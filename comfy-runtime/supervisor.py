from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path


WORKSPACE = Path("/workspace")
LOG_DIR = WORKSPACE / "logs"
COMFY_DIR = Path("/opt/ComfyUI")
RUNTIME_DIR = Path("/opt/comfy-runtime")
REQUIRED_DIRS = [
    WORKSPACE / "models",
    WORKSPACE / "comfy-input",
    WORKSPACE / "comfy-output",
    WORKSPACE / "comfy-temp",
    WORKSPACE / "comfy-user",
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
    try:
        nvidia = subprocess.run(["nvidia-smi"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        log("gpu_preflight_failed: nvidia-smi unavailable")
        raise SystemExit(42)
    if nvidia.returncode != 0:
        log("gpu_preflight_failed: nvidia-smi unavailable")
        raise SystemExit(42)
    code = (
        "import torch,sys; "
        "sys.exit(0 if torch.cuda.is_available() and torch.cuda.device_count() > 0 else 1)"
    )
    torch_check = subprocess.run(["python3.11", "-c", code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if torch_check.returncode != 0:
        log("gpu_preflight_failed: torch cuda unavailable")
        raise SystemExit(42)


def comfy_args(mode: str) -> list[str]:
    host = os.environ.get("COMFYUI_HOST", "127.0.0.1")
    port = os.environ.get("COMFYUI_PORT", "8188")
    args = [
        "python3.11",
        "main.py",
        "--listen",
        host,
        "--port",
        port,
        "--input-directory",
        str(WORKSPACE / "comfy-input"),
        "--output-directory",
        str(WORKSPACE / "comfy-output"),
        "--user-directory",
        str(WORKSPACE / "comfy-user"),
        "--models-directory",
        str(WORKSPACE / "models"),
        "--disable-auto-launch",
        "--dont-print-server",
    ]
    if mode == "smoke_cpu":
        args.extend(["--cpu", "--disable-triton-backend", "--preview-method", "none"])
    return args


def start_process(name: str, args: list[str], cwd: Path, log_file: str) -> subprocess.Popen[str]:
    process = subprocess.Popen(
        args,
        cwd=str(cwd),
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
    signal.signal(signal.SIGTERM, stop_children)
    signal.signal(signal.SIGINT, stop_children)

    if mode == "gpu":
        gpu_preflight()

    log(f"starting ComfyUI runtime at commit {os.environ.get('COMFYUI_COMMIT')} mode={mode}")
    comfy = start_process("comfyui", comfy_args(mode), COMFY_DIR, "comfyui.log")

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
            "python3.11",
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
