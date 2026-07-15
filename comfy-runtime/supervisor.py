from __future__ import annotations

import os
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path


WORKSPACE = Path("/workspace")
LOG_DIR = WORKSPACE / "logs"
COMFY_USER_DIR = WORKSPACE / "comfy-user"
COMFY_DATABASE_PATH = COMFY_USER_DIR / "comfyui.db"
COMFY_DIR = Path(os.environ.get("COMFYUI_DIR", "/opt/ComfyUI"))
RUNTIME_DIR = Path(os.environ.get("COMFY_RUNTIME_DIR", "/opt/comfy-runtime"))
COMFY_PYTHON = os.environ.get("COMFY_PYTHON", "python3.11")
SMOKE_IMPORT_BLOCKER = RUNTIME_DIR / "smoke_import_blocker"
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


children: list[subprocess.Popen[str]] = []
stopping = False


def log(message: str) -> None:
    print(message, flush=True)


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
        log(
            "database_preflight_ok "
            f"user_directory={COMFY_USER_DIR} database_url={database_url()} "
            f"runtime_uid_gid={os.getuid()}:{os.getgid()} "
            f"user_owner={stat_result.st_uid}:{stat_result.st_gid} "
            f"user_mode={stat_result.st_mode & 0o777:o} "
            f"database_owner={database_stat.st_uid}:{database_stat.st_gid} "
            f"database_mode={database_stat.st_mode & 0o777:o}"
        )
    except Exception as error:
        log(f"database_preflight_failed: {error}")
        raise SystemExit(43)


def database_url() -> str:
    return f"sqlite:///{COMFY_DATABASE_PATH}"


def stream_output(name: str, process: subprocess.Popen[str], log_path: Path) -> None:
    assert process.stdout is not None
    with log_path.open("a", encoding="utf-8") as handle:
        for line in process.stdout:
            text = f"[{name}] {line}"
            print(text, end="", flush=True)
            handle.write(text)
            handle.flush()


def wait_http(url: str, timeout_seconds: int) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if any(child.poll() is not None for child in children):
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
        log("gpu_preflight_failed: unsupported COMFY_GPU_PROFILE")
        raise SystemExit(42)

    python_path = os.environ.get("PYTHONPATH", "")
    if str(SMOKE_IMPORT_BLOCKER) in python_path.split(os.pathsep):
        log("gpu_preflight_failed: smoke import blocker present in PYTHONPATH")
        raise SystemExit(42)

    try:
        nvidia = subprocess.run(["nvidia-smi"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        log("gpu_preflight_failed: nvidia-smi unavailable")
        raise SystemExit(42)
    if nvidia.returncode != 0:
        log("gpu_preflight_failed: nvidia-smi unavailable")
        raise SystemExit(42)
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
        raise SystemExit(42)
    import json
    hardware = json.loads(torch_check.stdout.strip().splitlines()[-1])
    capability = tuple(hardware.get("capability") or [0, 0])
    vram_gb = float(hardware.get("vram_bytes", 0)) / 1024**3
    if capability < (8, 0):
        log(f"gpu_preflight_failed: compute capability {capability[0]}.{capability[1]} is below Ampere")
        raise SystemExit(42)
    if vram_gb < 20:
        log(f"gpu_preflight_failed: VRAM {vram_gb:.2f}GB is below 20GB")
        raise SystemExit(42)
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
    node_profile = os.environ.get("COMFY_NODE_PROFILE", "production_minimal")
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
    children.append(process)
    threading.Thread(target=stream_output, args=(name, process, LOG_DIR / log_file), daemon=True).start()
    return process


def stop_children(signum: int | None = None, _frame: object | None = None) -> None:
    global stopping
    stopping = True
    for process in children:
        if process.poll() is None:
            process.terminate()
    deadline = time.monotonic() + 15
    for process in children:
        while process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.2)
        if process.poll() is None:
            process.kill()


def main() -> int:
    if os.environ.get("START_GPU_WORKER", "false") == "true":
        log("START_GPU_WORKER must stay false for the ComfyUI runtime")
        return 2

    mode = os.environ.get("COMFY_RUNTIME_MODE", "gpu")
    if mode not in {"smoke_cpu", "gpu"}:
        log(f"invalid_comfy_runtime_mode: {mode}")
        return 2

    ensure_directories()
    ensure_database_preflight()
    signal.signal(signal.SIGTERM, stop_children)
    signal.signal(signal.SIGINT, stop_children)

    if mode == "gpu":
        gpu_preflight()

    node_profile = os.environ.get("COMFY_NODE_PROFILE", "production_minimal")
    log(
        "starting ComfyUI runtime at commit "
        f"{os.environ.get('COMFYUI_COMMIT')} mode={mode} node_profile={node_profile}"
    )
    comfy = start_process("comfyui", comfy_args(mode), COMFY_DIR, "comfyui.log", child_env(mode))

    if not wait_http(f"http://127.0.0.1:{os.environ.get('COMFYUI_PORT', '8188')}/system_stats", 300):
        code = comfy.poll()
        log(f"supervisor_process_failure: comfyui_unhealthy exit_code={code}")
        stop_children()
        return 1

    controller_host = os.environ.get("COMFY_CONTROLLER_HOST", "0.0.0.0")
    controller_port = os.environ.get("COMFY_CONTROLLER_PORT", "8080")
    controller = start_process(
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
        ],
        RUNTIME_DIR,
        "controller.log",
    )

    while not stopping:
        for name, process in [("comfyui", comfy), ("controller", controller)]:
            code = process.poll()
            if code is not None:
                log(f"supervisor_process_failure: {name} exit_code={code}")
                stop_children()
                return code if code else 1
        time.sleep(1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
