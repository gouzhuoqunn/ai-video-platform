from __future__ import annotations

import json
import os
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path


WORKSPACE = Path(os.environ.get("COMFY_WORKSPACE", "/workspace"))
LOG_DIR = Path(os.environ.get("COMFY_LOG_DIR", str(WORKSPACE / "logs")))
COMFY_USER_DIR = WORKSPACE / "comfy-user"
COMFY_DATABASE_PATH = COMFY_USER_DIR / "comfyui.db"
COMFY_DIR = Path(os.environ.get("COMFYUI_DIR", "/opt/ComfyUI"))
RUNTIME_DIR = Path(os.environ.get("COMFY_RUNTIME_DIR", "/opt/image-runtime"))
COMFY_PYTHON = os.environ.get("COMFY_PYTHON", "python3")
SMOKE_IMPORT_BLOCKER = RUNTIME_DIR / "smoke_import_blocker"
RUNTIME_STATE_PATH = Path(os.environ.get("COMFY_RUNTIME_STATE_PATH", str(LOG_DIR / "runtime-state.json")))
GPU_PROFILES = {"rtx4090", "rtx5090", "ampere_image_gpu"}
REQUIRED_DIRS = [
    WORKSPACE / "models",
    WORKSPACE / "comfy-input",
    WORKSPACE / "comfy-output",
    WORKSPACE / "comfy-temp",
    COMFY_USER_DIR,
    LOG_DIR,
    WORKSPACE / "r2-cache",
    WORKSPACE / "workflows",
]


children: dict[str, subprocess.Popen[str]] = {}
stopping = False
started_at = time.time()


def log(message: str) -> None:
    print(message, flush=True)


def sanitize_text(value: object, limit: int = 2000) -> str:
    text = str(value)
    for marker in ["CLORE_API_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "R2_SECRET", "SSH_PRIVATE"]:
        text = text.replace(marker, "<redacted>")
    return text[-limit:]


def write_state(stage: str, error: object | None = None, extra: dict[str, object] | None = None) -> None:
    RUNTIME_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    comfy = children.get("comfyui")
    controller = children.get("controller")
    payload: dict[str, object] = {
        "updated_at": time.time(),
        "controller_pid": controller.pid if controller and controller.poll() is None else None,
        "comfyui_pid": comfy.pid if comfy and comfy.poll() is None else None,
        "stage": stage,
        "ready": stage == "runtime_ready",
        "error": sanitize_text(error) if error else None,
        "comfyui_exit_code": comfy.poll() if comfy else None,
        "node_profile": os.environ.get("COMFY_NODE_PROFILE", "image-flux"),
        "runtime_mode": os.environ.get("COMFY_RUNTIME_MODE", "gpu"),
        "gpu_profile": os.environ.get("COMFY_GPU_PROFILE", ""),
        "model_directories": [str(WORKSPACE / "models")],
        "workspace": str(WORKSPACE),
        "comfyui_base_url": f"http://127.0.0.1:{os.environ.get('COMFYUI_PORT', '8188')}",
        "controller_bind": f"{os.environ.get('COMFY_CONTROLLER_HOST', '0.0.0.0')}:{os.environ.get('COMFY_CONTROLLER_PORT', '8080')}",
        "uptime_seconds": max(0, int(time.time() - started_at)),
    }
    if extra:
        payload.update(extra)
    temp = RUNTIME_STATE_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    temp.replace(RUNTIME_STATE_PATH)


def ensure_directories() -> None:
    for directory in REQUIRED_DIRS:
        directory.mkdir(parents=True, exist_ok=True)
        probe = directory / ".write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()


def ensure_database_preflight() -> None:
    """Fail before ComfyUI import when its canonical SQLite location is unusable."""
    try:
        COMFY_USER_DIR.mkdir(parents=True, exist_ok=True)
        probe = COMFY_USER_DIR / ".database-preflight"
        with probe.open("w", encoding="utf-8") as handle:
            handle.write("ok")
            handle.flush()
            os.fsync(handle.fileno())
        probe.unlink()

        connection = sqlite3.connect(COMFY_DATABASE_PATH)
        try:
            connection.execute("CREATE TABLE IF NOT EXISTS runtime_preflight (id INTEGER PRIMARY KEY)")
            connection.execute("INSERT INTO runtime_preflight DEFAULT VALUES")
            connection.execute("SELECT COUNT(*) FROM runtime_preflight").fetchone()
            connection.rollback()
        finally:
            connection.close()

        stat_result = COMFY_USER_DIR.stat()
        database_stat = COMFY_DATABASE_PATH.stat()
        runtime_uid = os.getuid() if hasattr(os, "getuid") else -1
        runtime_gid = os.getgid() if hasattr(os, "getgid") else -1
        log(
            "database_preflight_ok "
            f"user_directory={COMFY_USER_DIR} database_url={database_url()} "
            f"runtime_uid_gid={runtime_uid}:{runtime_gid} "
            f"user_owner={stat_result.st_uid}:{stat_result.st_gid} "
            f"user_mode={stat_result.st_mode & 0o777:o} "
            f"database_owner={database_stat.st_uid}:{database_stat.st_gid} "
            f"database_mode={database_stat.st_mode & 0o777:o}"
        )
    except Exception as error:
        log(f"database_preflight_failed: {error}")
        write_state("runtime_failed", f"database_preflight_failed: {error}")
        raise


def database_url() -> str:
    return f"sqlite:///{COMFY_DATABASE_PATH}"


def stream_output(name: str, process: subprocess.Popen[str], log_path: Path) -> None:
    assert process.stdout is not None
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        for line in process.stdout:
            text = f"[{name}] {line}"
            print(text, end="", flush=True)
            handle.write(text)
            handle.flush()


def wait_http(url: str, timeout_seconds: int) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        comfy = children.get("comfyui")
        if comfy and comfy.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if response.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(5)
    return False


def gpu_preflight() -> None:
    gpu_profile = os.environ.get("COMFY_GPU_PROFILE", "")
    if gpu_profile not in GPU_PROFILES:
        log("gpu_preflight_failed: COMFY_GPU_PROFILE must be rtx4090 or rtx5090")
        raise RuntimeError("gpu_preflight_failed: COMFY_GPU_PROFILE must be rtx4090 or rtx5090")

    python_path = os.environ.get("PYTHONPATH", "")
    if str(SMOKE_IMPORT_BLOCKER) in python_path.split(os.pathsep):
        log("gpu_preflight_failed: smoke import blocker present in PYTHONPATH")
        raise RuntimeError("gpu_preflight_failed: smoke import blocker present in PYTHONPATH")

    try:
        nvidia = subprocess.run(["nvidia-smi"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except FileNotFoundError as error:
        log("gpu_preflight_failed: nvidia-smi unavailable")
        raise RuntimeError("gpu_preflight_failed: nvidia-smi unavailable") from error
    if nvidia.returncode != 0:
        log("gpu_preflight_failed: nvidia-smi unavailable")
        raise RuntimeError("gpu_preflight_failed: nvidia-smi unavailable")
    code = (
        "import json,torch,sys; "
        "ok=torch.cuda.is_available() and torch.cuda.device_count()>0; "
        "p=torch.cuda.get_device_properties(0) if ok else None; "
        "print(json.dumps({'ok':ok,'name':p.name if p else None,'capability':[p.major,p.minor] if p else None,'vram_bytes':p.total_memory if p else 0})); "
        "sys.exit(0 if ok else 1)"
    )
    torch_check = subprocess.run([COMFY_PYTHON, "-c", code], capture_output=True, text=True)
    if torch_check.returncode != 0:
        log("gpu_preflight_failed: torch cuda unavailable")
        raise RuntimeError("gpu_preflight_failed: torch cuda unavailable")
    hardware = json.loads(torch_check.stdout.strip().splitlines()[-1])
    capability = tuple(hardware.get("capability") or [0, 0])
    vram_gb = float(hardware.get("vram_bytes", 0)) / 1024**3
    if capability < (8, 0):
        raise RuntimeError(f"gpu_preflight_failed: compute capability {capability[0]}.{capability[1]} is below Ampere")
    if vram_gb < 20:
        raise RuntimeError(f"gpu_preflight_failed: VRAM {vram_gb:.2f}GB is below 20GB")
    if capability < (8, 9):
        os.environ["COMFY_FORCE_FP16"] = "1"
    if vram_gb < 24:
        os.environ["COMFY_CPU_OFFLOAD_REQUIRED"] = "1"
    log(
        "gpu_preflight_ok "
        f"profile={gpu_profile} name={hardware.get('name')} capability={capability[0]}.{capability[1]} "
        f"vram_gb={vram_gb:.2f} fp16_compute={os.environ.get('COMFY_FORCE_FP16') == '1'} "
        f"cpu_offload={os.environ.get('COMFY_CPU_OFFLOAD_REQUIRED') == '1'}"
    )


def comfy_args(mode: str) -> list[str]:
    host = os.environ.get("COMFYUI_HOST", "127.0.0.1")
    port = os.environ.get("COMFYUI_PORT", "8188")
    node_profile = os.environ.get("COMFY_NODE_PROFILE", "image-flux")
    args = [
        COMFY_PYTHON,
        str(RUNTIME_DIR / "launch_comfy.py"),
        "--node-profile",
        node_profile,
        "--listen",
        host,
        "--port",
        port,
        "--input-directory",
        str(WORKSPACE / "comfy-input"),
        "--output-directory",
        str(WORKSPACE / "comfy-output"),
        "--user-directory",
        str(COMFY_USER_DIR),
        "--database-url",
        database_url(),
        "--models-directory",
        str(WORKSPACE / "models"),
        "--disable-auto-launch",
        "--dont-print-server",
        "--disable-all-custom-nodes",
        "--disable-triton-backend",
    ]
    if mode == "smoke_cpu":
        args.extend(["--cpu", "--preview-method", "none"])
    elif os.environ.get("COMFY_FORCE_FP16") == "1":
        args.append("--force-fp16")
    if mode != "smoke_cpu" and os.environ.get("COMFY_CPU_OFFLOAD_REQUIRED") == "1":
        args.append("--lowvram")
    return args


def child_env(mode: str) -> dict[str, str]:
    env = os.environ.copy()
    if mode == "smoke_cpu":
        existing = env.get("PYTHONPATH", "")
        parts = [str(SMOKE_IMPORT_BLOCKER)]
        if existing:
            parts.append(existing)
        env["PYTHONPATH"] = os.pathsep.join(parts)
        env["PYTHONFAULTHANDLER"] = "1"
        env.setdefault("OMP_NUM_THREADS", "1")
        env.setdefault("MKL_NUM_THREADS", "1")
    return env


def start_process(
    name: str,
    args: list[str],
    cwd: Path,
    log_file: str,
    env: dict[str, str] | None = None,
) -> subprocess.Popen[str]:
    process = subprocess.Popen(
        args,
        cwd=str(cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    children[name] = process
    threading.Thread(target=stream_output, args=(name, process, LOG_DIR / log_file), daemon=True).start()
    write_state(f"{name}_started")
    return process


def start_controller() -> subprocess.Popen[str]:
    controller_host = os.environ.get("COMFY_CONTROLLER_HOST", "0.0.0.0")
    controller_port = os.environ.get("COMFY_CONTROLLER_PORT", "8080")
    return start_process(
        "controller",
        [
            COMFY_PYTHON,
            str(RUNTIME_DIR / "controller.py"),
            "--host",
            controller_host,
            "--port",
            controller_port,
            "--comfy-host",
            "127.0.0.1",
            "--comfy-port",
            os.environ.get("COMFYUI_PORT", "8188"),
            "--state-path",
            str(RUNTIME_STATE_PATH),
            "--log-dir",
            str(LOG_DIR),
        ],
        RUNTIME_DIR,
        "controller.log",
    )


def stop_children(signum: int | None = None, _frame: object | None = None) -> None:
    global stopping
    stopping = True
    write_state("stopping")
    for process in children.values():
        if process.poll() is None:
            process.terminate()
    deadline = time.monotonic() + 15
    for process in children.values():
        while process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.2)
        if process.poll() is None:
            process.kill()


def supervise_failure(message: str) -> None:
    log(message)
    write_state("runtime_failed", message)


def main() -> int:
    if os.environ.get("START_GPU_WORKER", "false") == "true":
        log("START_GPU_WORKER must stay false for the ComfyUI runtime")
        return 2

    mode = os.environ.get("COMFY_RUNTIME_MODE", "gpu")
    if mode not in {"smoke_cpu", "gpu"}:
        log(f"invalid_comfy_runtime_mode: {mode}")
        return 2

    ensure_directories()
    signal.signal(signal.SIGTERM, stop_children)
    signal.signal(signal.SIGINT, stop_children)

    write_state("starting_controller")
    start_controller()
    write_state("starting_comfyui")

    try:
        ensure_database_preflight()
        if mode == "gpu":
            gpu_preflight()
        node_profile = os.environ.get("COMFY_NODE_PROFILE", "image-flux")
        log(
            "starting ComfyUI runtime at commit "
            f"{os.environ.get('COMFYUI_COMMIT')} mode={mode} node_profile={node_profile}"
        )
        comfy = start_process("comfyui", comfy_args(mode), COMFY_DIR, "comfyui.log", child_env(mode))
        write_state("starting_comfyui")
        if wait_http(f"http://127.0.0.1:{os.environ.get('COMFYUI_PORT', '8188')}/system_stats", 300):
            write_state("runtime_ready")
        else:
            code = comfy.poll()
            supervise_failure(f"supervisor_process_failure: comfyui_unhealthy exit_code={code}")
    except Exception as error:
        supervise_failure(error)

    while not stopping:
        controller = children.get("controller")
        if controller and controller.poll() is not None:
            log(f"supervisor_process_failure: controller exit_code={controller.returncode}")
            return controller.returncode or 1
        comfy = children.get("comfyui")
        if comfy and comfy.poll() is not None:
            current = {}
            if RUNTIME_STATE_PATH.exists():
                try:
                    current = json.loads(RUNTIME_STATE_PATH.read_text(encoding="utf-8"))
                except Exception:
                    current = {}
            if current.get("stage") == "runtime_ready":
                supervise_failure(f"supervisor_process_failure: comfyui exit_code={comfy.returncode}")
        time.sleep(1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
