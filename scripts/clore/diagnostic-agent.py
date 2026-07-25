#!/usr/bin/env python3
"""Restricted, authenticated Clore image diagnostic agent.

The only externally reachable service is this agent.  It deliberately exposes
fixed diagnostics, a fixed five-file model manifest, and one fixed image path;
it is not a shell, file browser, workflow runner, or general proxy.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(os.environ.get("DIAG_ROOT", "/tmp/clore-diagnostic"))
STATE_FILE = ROOT / "state.json"
LOG_DIR = ROOT / "logs"
RUNTIME_DIR = ROOT / "runtime"
ARTIFACT_DIR = ROOT / "artifacts"
WORKSPACE = Path("/workspace")
VENV = WORKSPACE / "clore-diagnostic-venv"
COMFY_DIR = WORKSPACE / "ComfyUI"
COMFY_URL = "https://github.com/comfyanonymous/ComfyUI.git"
COMFY_COMMIT = "da2608926eaf68fd532bba4e1ace3402c5d21399"
PYTORCH_INDEX = "https://download.pytorch.org/whl/cu124"
RAW_ROOT = "https://raw.githubusercontent.com/gouzhuoqunn/ai-video-platform"
MAX_TEXT = 6000
MAX_MODEL_BODY = 64 * 1024
MAX_INFERENCE_BODY = 16 * 1024
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
SHA_RE = re.compile(r"^[a-f0-9]{64}$", re.I)
COMMIT_RE = re.compile(r"^[a-f0-9]{40}$", re.I)
APPROVED_MODELS = {
    "transformer": ("fluxedUpFluxNSFW_102BF16.safetensors", "diffusion_models"),
    "lora": ("aidmaNSFWunlock-FLUX-V0.2.safetensors", "loras"),
    "vae": ("ae.safetensors", "vae"),
    "clip_l": ("clip_l.safetensors", "text_encoders"),
    "t5": ("t5xxl_fp8_e4m3fn_scaled.safetensors", "text_encoders"),
}
STATE_LOCK = threading.Lock()
STAGE_GATE = threading.Lock()
STATE: dict[str, Any] = {"alive": True, "started_at": None, "current_stage": "idle", "last_error": None, "stages": {}, "models": {}}
CHILDREN: dict[str, subprocess.Popen[str]] = {}
CONFIG: dict[str, str] = {}


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def clean(value: object, limit: int = MAX_TEXT) -> str:
    text = str(value)
    text = re.sub(r"(?i)(authorization|bearer|token|secret|password|api[_-]?key)\s*[:=]\s*\S+", r"\1=<redacted>", text)
    text = re.sub(r"([?&](?:x-amz-|signature|token|credential)[^=&]*=)[^&\s]+", r"\1<redacted>", text, flags=re.I)
    return text[-limit:]


def test_stage_delay() -> float:
    """Bounded test-only delay; never accepts a remote request parameter."""
    try:
        return min(5.0, max(0.0, float(os.environ.get("DIAG_TEST_STAGE_DELAY_SECONDS", "0"))))
    except ValueError:
        return 0.0


def redacted_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "<redacted>" if parsed.query else "", ""))


def save_locked() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(STATE, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def tail(path: Path, lines: int = 24) -> list[str]:
    try:
        return [clean(line, 500) for line in path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]]
    except Exception:
        return []


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def exec_fixed(command: list[str], timeout: int = 90, cwd: Path | None = None) -> dict[str, Any]:
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, cwd=str(cwd) if cwd else None)
    return {"command": " ".join(command), "exit_code": result.returncode, "output": clean(result.stdout)}


def writable(directory: str) -> dict[str, Any]:
    try:
        path = Path(directory)
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".diagnostic-write-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return {"path": str(path), "writable": True}
    except Exception as error:
        return {"path": str(directory), "writable": False, "error": clean(error, 300)}


def probe(url: str, attempts: int = 30, timeout: int = 3) -> dict[str, Any]:
    last: str | None = None
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:
                body = response.read(32768).decode("utf-8", "replace")
                return {"status": response.status, "body": clean(body, 1200)}
        except Exception as error:
            last = clean(error, 500)
            time.sleep(1)
    return {"status": None, "error": last}


def request_json(url: str, method: str = "GET", payload: dict[str, Any] | None = None, timeout: int = 30) -> tuple[int, Any]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw.decode("utf-8")) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw.decode("utf-8"))
        except Exception:
            return error.code, {"error": clean(raw)}


def begin(name: str) -> None:
    with STATE_LOCK:
        STATE["current_stage"] = name
        STATE["last_error"] = None
        STATE["stages"][name] = {"status": "running", "started_at": now(), "completed_at": None, "exit_code": None, "log_tail": []}
        save_locked()


def complete(name: str, data: dict[str, Any]) -> None:
    with STATE_LOCK:
        record = STATE["stages"][name]
        record.update({"status": "succeeded", "completed_at": now(), "exit_code": 0, "data": data})
        STATE["current_stage"] = "idle"
        save_locked()


def failed(name: str, error: object, data: dict[str, Any] | None = None) -> None:
    with STATE_LOCK:
        record = STATE["stages"].setdefault(name, {})
        record.update({"status": "failed", "completed_at": now(), "first_exact_failure": clean(error), "data": data or record.get("data", {})})
        STATE["last_error"] = clean(error)
        STATE["current_stage"] = "idle"
        save_locked()


def stage_environment(_: dict[str, Any]) -> dict[str, Any]:
    commands = {name: exec_fixed(command, 30) for name, command in {
        "hostname": ["hostname"], "id": ["id"], "pwd": ["pwd"], "python": ["python3", "--version"], "disk": ["df", "-h", "/"], "memory": ["free", "-h"]}.items()}
    return {"commands": commands, "tmp": writable("/tmp"), "workspace": writable("/workspace")}


def stage_gpu(_: dict[str, Any]) -> dict[str, Any]:
    smi = exec_fixed(["nvidia-smi"], 30)
    torch = exec_fixed(["python3", "-c", "import json,torch; d={'torch_version':torch.__version__,'cuda_available':torch.cuda.is_available()}; d.update({'gpu_name':torch.cuda.get_device_name(0),'compute_capability':torch.cuda.get_device_capability(0),'vram':torch.cuda.get_device_properties(0).total_memory} if d['cuda_available'] else {}); print(json.dumps(d))"], 60)
    return {"nvidia_smi": smi, "torch": torch}


def raw_file_url(path: str) -> str:
    return f"{RAW_ROOT}/{CONFIG['project_commit']}/{path}"


def fetch_small_verified(url: str, destination: Path, expected: str) -> None:
    try:
        with urllib.request.urlopen(url, timeout=45) as response:
            if response.status != 200:
                raise RuntimeError(f"raw_download_http_{response.status}")
            content = response.read(2 * 1024 * 1024)
    except Exception as error:
        raise RuntimeError(f"raw_download_failed:{clean(error, 400)}") from error
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(content)
    if sha256(destination) != expected:
        destination.unlink(missing_ok=True)
        raise RuntimeError(f"raw_sha256_mismatch:{destination.name}")


def project_runtime() -> tuple[Path, dict[str, str]]:
    runtime = RUNTIME_DIR
    runtime.mkdir(parents=True, exist_ok=True)
    controller = runtime / "controller.py"
    workflow = runtime / "image_workflow.py"
    fetch_small_verified(raw_file_url("comfy-runtime/controller.py"), controller, CONFIG["controller_sha256"])
    fetch_small_verified(raw_file_url("comfy-runtime/image_workflow.py"), workflow, CONFIG["workflow_sha256"])
    check = exec_fixed([sys.executable, "-c", "import sys;sys.path.insert(0,sys.argv[1]);import image_workflow,controller;print('runtime_import_ok')", str(runtime)], 45)
    if check["exit_code"]:
        raise RuntimeError("runtime_import_failed:" + check["output"])
    return runtime, {"project_commit": CONFIG["project_commit"], "controller_sha256": sha256(controller), "image_workflow_sha256": sha256(workflow), "import": check}


def stage_controller(_: dict[str, Any]) -> dict[str, Any]:
    runtime, checks = project_runtime()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = LOG_DIR / "controller.log"
    previous = CHILDREN.get("controller")
    if previous and previous.poll() is None:
        previous.terminate()
    handle = log.open("w", encoding="utf-8")
    command = [sys.executable, str(runtime / "controller.py"), "--host", "127.0.0.1", "--port", "18080", "--comfy-host", "127.0.0.1", "--comfy-port", "8188", "--state-path", str(ROOT / "controller-state.json"), "--log-dir", str(LOG_DIR / "controller-runtime")]
    process = subprocess.Popen(command, cwd=str(runtime), stdout=handle, stderr=subprocess.STDOUT, text=True)
    CHILDREN["controller"] = process
    result = probe("http://127.0.0.1:18080/healthz")
    result.update({"source": checks, "process_exit_code": process.poll(), "log_tail": tail(log)})
    if result["status"] != 200 or '"controller": "alive"' not in result.get("body", ""):
        raise RuntimeError(json.dumps(result))
    return result


def venv_python() -> str:
    return str(VENV / "bin" / "python")


def venv_package_missing(result: dict[str, Any]) -> bool:
    output = str(result.get("output", "")).lower()
    return "ensurepip" in output or "python3.12-venv" in output or "python3-venv" in output


def ensure_venv() -> dict[str, Any]:
    """Create the fixed runtime venv, repairing only Ubuntu's missing venv package."""
    progress: dict[str, Any] = {}
    python = Path(venv_python())
    if python.is_file():
        progress["existing_pip_probe"] = exec_fixed([str(python), "-m", "pip", "--version"], 60)
        if progress["existing_pip_probe"]["exit_code"] == 0:
            progress["reused"] = True
            return progress
    if VENV.exists():
        shutil.rmtree(VENV, ignore_errors=True)
        progress["removed_incomplete_venv"] = True
    progress["initial_venv"] = exec_fixed(["python3", "-m", "venv", str(VENV)], 180)
    if progress["initial_venv"]["exit_code"] != 0:
        if not venv_package_missing(progress["initial_venv"]):
            raise RuntimeError("ensure_venv_failed:" + clean(json.dumps(progress)))
        progress["apt_update"] = exec_fixed(["apt-get", "update"], 300)
        if progress["apt_update"]["exit_code"] != 0:
            raise RuntimeError("ensure_venv_failed:" + clean(json.dumps(progress)))
        progress["apt_install"] = exec_fixed(["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "--no-install-recommends", "python3.12-venv"], 600)
        if progress["apt_install"]["exit_code"] != 0:
            raise RuntimeError("ensure_venv_failed:" + clean(json.dumps(progress)))
        shutil.rmtree(VENV, ignore_errors=True)
        progress["removed_before_retry"] = True
        progress["retry_venv"] = exec_fixed(["python3", "-m", "venv", str(VENV)], 180)
        if progress["retry_venv"]["exit_code"] != 0:
            raise RuntimeError("ensure_venv_failed:" + clean(json.dumps(progress)))
    python = Path(venv_python())
    if not python.is_file():
        progress["python_exists"] = False
        raise RuntimeError("ensure_venv_failed:" + clean(json.dumps(progress)))
    progress["python_probe"] = exec_fixed([str(python), "--version"], 60)
    progress["pip_probe"] = exec_fixed([str(python), "-m", "pip", "--version"], 60)
    if progress["python_probe"]["exit_code"] != 0 or progress["pip_probe"]["exit_code"] != 0:
        raise RuntimeError("ensure_venv_failed:" + clean(json.dumps(progress)))
    return progress


def write_runtime_state(stage: str, ready: bool, error: str | None = None) -> None:
    state = {"stage": stage, "ready": ready, "error": error, "updated_at": now(), "comfyui_pid": CHILDREN.get("comfyui").pid if CHILDREN.get("comfyui") else None, "workspace": str(WORKSPACE)}
    (ROOT / "controller-state.json").write_text(json.dumps(state), encoding="utf-8")


def stage_comfyui(_: dict[str, Any]) -> dict[str, Any]:
    workspace = writable(str(WORKSPACE))
    if not workspace["writable"]:
        raise RuntimeError("workspace_not_writable")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    progress: dict[str, Any] = {"workspace": workspace, "venv": str(VENV), "comfy_commit": COMFY_COMMIT}
    progress["ensure_venv"] = ensure_venv()
    progress["install_torch"] = exec_fixed([venv_python(), "-m", "pip", "install", "--upgrade", "pip", "wheel", "setuptools"], 600)
    if progress["install_torch"]["exit_code"]:
        raise RuntimeError(progress["install_torch"]["output"])
    progress["install_cuda_torch"] = exec_fixed([venv_python(), "-m", "pip", "install", "torch==2.6.0", "torchvision==0.21.0", "--index-url", PYTORCH_INDEX], 1800)
    if progress["install_cuda_torch"]["exit_code"]:
        raise RuntimeError(progress["install_cuda_torch"]["output"])
    progress["torch_probe"] = exec_fixed([venv_python(), "-c", "import json,torch;assert torch.cuda.is_available();p=torch.cuda.get_device_properties(0);assert 'RTX 4090' in torch.cuda.get_device_name(0);print(json.dumps({'torch':torch.__version__,'cuda':torch.version.cuda,'gpu':torch.cuda.get_device_name(0),'vram':p.total_memory}))"], 90)
    if progress["torch_probe"]["exit_code"]:
        raise RuntimeError("cuda_torch_probe_failed:" + progress["torch_probe"]["output"])
    if not COMFY_DIR.exists():
        progress["clone_comfy"] = exec_fixed(["git", "clone", "--filter=blob:none", COMFY_URL, str(COMFY_DIR)], 600)
        if progress["clone_comfy"]["exit_code"]:
            raise RuntimeError(progress["clone_comfy"]["output"])
    progress["checkout_comfy"] = exec_fixed(["git", "fetch", "--depth", "1", "origin", COMFY_COMMIT], 300, COMFY_DIR)
    if progress["checkout_comfy"]["exit_code"]:
        raise RuntimeError(progress["checkout_comfy"]["output"])
    progress["checkout_comfy"] = exec_fixed(["git", "checkout", "--detach", COMFY_COMMIT], 120, COMFY_DIR)
    if progress["checkout_comfy"]["exit_code"]:
        raise RuntimeError(progress["checkout_comfy"]["output"])
    progress["install_comfy"] = exec_fixed([venv_python(), "-m", "pip", "install", "-r", "requirements.txt"], 1800, COMFY_DIR)
    if progress["install_comfy"]["exit_code"]:
        raise RuntimeError(progress["install_comfy"]["output"])
    log = LOG_DIR / "comfyui.log"
    previous = CHILDREN.get("comfyui")
    if previous and previous.poll() is None:
        previous.terminate()
    handle = log.open("w", encoding="utf-8")
    process = subprocess.Popen([venv_python(), "main.py", "--listen", "127.0.0.1", "--port", "8188"], cwd=str(COMFY_DIR), stdout=handle, stderr=subprocess.STDOUT, text=True)
    CHILDREN["comfyui"] = process
    results = {route: probe("http://127.0.0.1:8188" + route, 60) for route in ("/system_stats", "/object_info", "/queue")}
    results.update({"progress": progress, "process_exit_code": process.poll(), "log_tail": tail(log)})
    if any(value.get("status") != 200 for key, value in results.items() if key.startswith("/")):
        write_runtime_state("comfyui_failed", False, clean(json.dumps(results)))
        raise RuntimeError(json.dumps(results))
    write_runtime_state("runtime_ready", True)
    return results


def safe_download_url(value: object) -> str:
    if not isinstance(value, str) or len(value) > 6000:
        raise ValueError("invalid_model_url")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("model_url_must_be_https")
    host = parsed.hostname.lower()
    if host == "localhost" or host.endswith(".localhost"):
        raise ValueError("model_url_localhost_forbidden")
    try:
        address = ipaddress.ip_address(host)
        if address.is_private or address.is_loopback or address.is_link_local or address.is_unspecified:
            raise ValueError("model_url_nonpublic_ip_forbidden")
    except ValueError as error:
        if str(error).startswith("model_url_"):
            raise
    return value


def validate_manifest(payload: object) -> list[dict[str, Any]]:
    entries = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(entries, list) or len(entries) != len(APPROVED_MODELS):
        raise ValueError("exactly_five_models_required")
    result: list[dict[str, Any]] = []
    seen_roles: set[str] = set(); seen_names: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"role", "filename", "url", "sha256", "size_bytes"}:
            raise ValueError("invalid_model_manifest_fields")
        role = entry["role"]; filename = entry["filename"]; expected = APPROVED_MODELS.get(role)
        if not isinstance(role, str) or expected is None or role in seen_roles:
            raise ValueError("invalid_or_duplicate_model_role")
        if not isinstance(filename, str) or filename != expected[0] or filename in seen_names or "/" in filename or "\\" in filename or ".." in filename:
            raise ValueError("invalid_or_duplicate_model_filename")
        digest = entry["sha256"]
        size = entry["size_bytes"]
        if not isinstance(digest, str) or not SHA_RE.fullmatch(digest) or not isinstance(size, int) or size <= 0:
            raise ValueError("invalid_model_hash_or_size")
        result.append({"role": role, "filename": filename, "url": safe_download_url(entry["url"]), "sha256": digest.lower(), "size_bytes": size, "destination": str(COMFY_DIR / "models" / expected[1] / filename)})
        seen_roles.add(role); seen_names.add(filename)
    if seen_roles != set(APPROVED_MODELS):
        raise ValueError("missing_approved_model_role")
    return result


def stream_model(entry: dict[str, Any]) -> dict[str, Any]:
    destination = Path(entry["destination"]); part = destination.with_name(destination.name + ".part")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and destination.stat().st_size == entry["size_bytes"] and sha256(destination) == entry["sha256"]:
        return {"filename": entry["filename"], "status": "verified_existing", "downloaded_bytes": entry["size_bytes"], "size_bytes": entry["size_bytes"], "sha256": entry["sha256"]}
    offset = part.stat().st_size if part.exists() else 0
    if offset > entry["size_bytes"]:
        part.unlink(); offset = 0
    request = urllib.request.Request(entry["url"])
    if offset:
        request.add_header("Range", f"bytes={offset}-")
    try:
        response = urllib.request.urlopen(request, timeout=60)
        if offset and response.status != 206:
            response.close(); part.unlink(missing_ok=True); offset = 0
            response = urllib.request.urlopen(urllib.request.Request(entry["url"]), timeout=60)
        with response, part.open("ab" if offset else "wb") as handle:
            received = offset
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                handle.write(block); received += len(block)
                if received > entry["size_bytes"]:
                    raise RuntimeError("model_download_exceeds_expected_size")
                with STATE_LOCK:
                    STATE["models"][entry["role"]] = {"filename": entry["filename"], "status": "downloading", "downloaded_bytes": received, "size_bytes": entry["size_bytes"], "url": redacted_url(entry["url"])}
                    save_locked()
    except Exception as error:
        raise RuntimeError(f"model_download_failed:{entry['filename']}:{clean(error, 400)}") from error
    if part.stat().st_size != entry["size_bytes"]:
        raise RuntimeError(f"model_size_mismatch:{entry['filename']}")
    if sha256(part) != entry["sha256"]:
        raise RuntimeError(f"model_sha256_mismatch:{entry['filename']}")
    os.replace(part, destination)
    return {"filename": entry["filename"], "status": "verified", "downloaded_bytes": entry["size_bytes"], "size_bytes": entry["size_bytes"], "sha256": entry["sha256"]}


def stage_models(payload: dict[str, Any]) -> dict[str, Any]:
    manifest = validate_manifest(payload)
    results: dict[str, Any] = {}
    for entry in manifest:
        with STATE_LOCK:
            STATE["models"][entry["role"]] = {"filename": entry["filename"], "status": "queued", "downloaded_bytes": 0, "size_bytes": entry["size_bytes"], "url": redacted_url(entry["url"])}
            save_locked()
        result = stream_model(entry)
        results[entry["role"]] = result
        with STATE_LOCK:
            STATE["models"][entry["role"]] = result
            save_locked()
    return {"models": results}


def png_dimensions(data: bytes) -> tuple[int, int]:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError("invalid_png")
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def stage_inference(payload: dict[str, Any]) -> dict[str, Any]:
    task_id = validate_inference_shape(payload)
    with STATE_LOCK:
        verified_roles = {role for role, value in STATE["models"].items() if value.get("status") in {"verified", "verified_existing"}}
    if verified_roles != set(APPROVED_MODELS):
        raise RuntimeError("models_not_verified")
    controller_status, controller_health = request_json("http://127.0.0.1:18080/healthz")
    comfy_status, _ = request_json("http://127.0.0.1:8188/system_stats")
    if controller_status != 200 or not isinstance(controller_health, dict) or controller_health.get("controller") != "alive" or comfy_status != 200:
        raise RuntimeError("controller_or_comfyui_not_healthy")
    status, job = request_json("http://127.0.0.1:18080/image/generate", "POST", payload)
    if status != 202 or not isinstance(job, dict) or not isinstance(job.get("job_id"), str):
        raise RuntimeError("controller_generate_failed:" + clean(job, 800))
    started = time.monotonic(); job_id = job["job_id"]
    while time.monotonic() - started < 20 * 60:
        status, state = request_json(f"http://127.0.0.1:18080/jobs/{urllib.parse.quote(job_id)}")
        if status != 200 or not isinstance(state, dict):
            raise RuntimeError("controller_job_poll_failed:" + clean(state, 600))
        if state.get("status") == "completed":
            break
        history = state.get("history")
        if isinstance(history, dict) and isinstance(history.get("status"), dict) and history["status"].get("status_str") in {"error", "failed"}:
            raise RuntimeError("controller_job_failed:" + clean(history, 1000))
        time.sleep(2)
    else:
        raise RuntimeError("controller_job_timeout")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:18080/results/{urllib.parse.quote(job_id)}", timeout=60) as response:
            if response.status != 200:
                raise RuntimeError(f"controller_result_http_{response.status}")
            image = response.read(64 * 1024 * 1024)
    except Exception as error:
        raise RuntimeError("controller_result_failed:" + clean(error, 500)) from error
    width, height = png_dimensions(image)
    if width != payload["width"] or height != payload["height"]:
        raise RuntimeError(f"result_dimensions_mismatch:{width}x{height}")
    artifact = ARTIFACT_DIR / task_id
    artifact.mkdir(parents=True, exist_ok=True)
    image_path = artifact / "image.png"; image_path.write_bytes(image)
    metadata = {"task_id": task_id, "width": width, "height": height, "byte_size": len(image), "sha256": sha256(image_path), "generation_duration_seconds": round(time.monotonic() - started, 3), "controller_prompt_id": job.get("prompt_id")}
    (artifact / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def validate_inference_shape(payload: object) -> str:
    if not isinstance(payload, dict) or set(payload) != {"task_id", "mode", "prompt", "width", "height", "steps", "cfg", "lora_strength", "seed", "sampler"}:
        raise ValueError("invalid_inference_fields")
    task_id = payload.get("task_id")
    if not isinstance(task_id, str) or not UUID_RE.fullmatch(task_id):
        raise ValueError("invalid_task_id")
    if payload.get("mode") != "text_generation" or not isinstance(payload.get("prompt"), str) or len(payload["prompt"]) > 4000:
        raise ValueError("invalid_inference_request")
    return task_id


STAGES: dict[str, tuple[str, Any, int]] = {
    "/stage/environment": ("environment", stage_environment, 0),
    "/stage/gpu": ("gpu", stage_gpu, 0),
    "/stage/controller": ("controller", stage_controller, 0),
    "/stage/comfyui": ("comfyui", stage_comfyui, 0),
    "/stage/models": ("models", stage_models, MAX_MODEL_BODY),
    "/stage/inference": ("inference", stage_inference, MAX_INFERENCE_BODY),
}


def run_stage(route: str, payload: dict[str, Any]) -> bool:
    name, action, _ = STAGES[route]
    if not STAGE_GATE.acquire(blocking=False):
        return False
    def worker() -> None:
        try:
            begin(name)
            time.sleep(test_stage_delay())
            complete(name, action(payload))
        except Exception as error:
            failed(name, error)
        finally:
            STAGE_GATE.release()
    threading.Thread(target=worker, daemon=True).start()
    return True


class Handler(BaseHTTPRequestHandler):
    token_hash = ""
    def log_message(self, *_args: object) -> None:
        return
    def send_json(self, code: int, value: object) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def authenticated(self) -> bool:
        auth = self.headers.get("Authorization", "")
        return auth.startswith("Bearer ") and hmac.compare_digest(hashlib.sha256(auth[7:].encode()).hexdigest(), self.token_hash)
    def do_GET(self) -> None:
        route = urllib.parse.urlsplit(self.path).path
        if route == "/healthz":
            with STATE_LOCK: value = {"alive": True, "agent": "restricted-clore-diagnostic", "current_stage": STATE["current_stage"], "last_error": STATE["last_error"]}
            self.send_json(200, value); return
        if route in {"/status", "/logs"}:
            with STATE_LOCK:
                value = json.loads(json.dumps(STATE)) if route == "/status" else {name: record.get("log_tail", []) for name, record in STATE["stages"].items()}
            self.send_json(200, value); return
        match = re.fullmatch(r"/artifacts/([^/]+)/(image|metadata)", route)
        if match:
            if not self.authenticated(): self.send_json(401, {"error": "unauthorized"}); return
            task_id, kind = match.groups()
            if not UUID_RE.fullmatch(task_id): self.send_json(404, {"error": "artifact_not_found"}); return
            base = ARTIFACT_DIR / task_id
            file = base / ("image.png" if kind == "image" else "metadata.json")
            if not file.is_file(): self.send_json(404, {"error": "artifact_not_found"}); return
            if kind == "metadata": self.send_json(200, json.loads(file.read_text(encoding="utf-8"))); return
            try: png_dimensions(file.read_bytes())
            except ValueError: self.send_json(409, {"error": "artifact_not_verified"}); return
            data = file.read_bytes(); self.send_response(200); self.send_header("Content-Type", "image/png"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data); return
        self.send_json(404, {"error": "not_found"})
    def do_POST(self) -> None:
        route = urllib.parse.urlsplit(self.path).path
        if not self.authenticated(): self.send_json(401, {"error": "unauthorized"}); return
        item = STAGES.get(route)
        if not item: self.send_json(404, {"error": "unknown_stage"}); return
        limit = item[2]
        try: length = int(self.headers.get("Content-Length", "0"))
        except ValueError: self.send_json(400, {"error": "invalid_content_length"}); return
        if length < 0 or length > limit: self.send_json(413, {"error": "stage_body_too_large"}); return
        raw = self.rfile.read(length) if length else b""
        if limit == 0 and raw: self.send_json(400, {"error": "stage_parameters_forbidden"}); return
        try: payload = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception: self.send_json(400, {"error": "invalid_json"}); return
        if not isinstance(payload, dict): self.send_json(400, {"error": "invalid_stage_payload"}); return
        try:
            if route == "/stage/models": validate_manifest(payload)
            if route == "/stage/inference": validate_inference_shape(payload)
        except ValueError as error:
            self.send_json(400, {"error": str(error)}); return
        if not run_stage(route, payload): self.send_json(409, {"error": "stage_already_running"}); return
        self.send_json(202, {"accepted": route})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--token-sha256", required=True)
    parser.add_argument("--project-commit")
    parser.add_argument("--controller-sha256")
    parser.add_argument("--workflow-sha256")
    parser.add_argument("--immutable", help="commit:controller_sha256:workflow_sha256")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    if args.immutable:
        parts = args.immutable.split(":")
        if len(parts) != 3:
            raise SystemExit("immutable_sha256_and_project_commit_required")
        args.project_commit, args.controller_sha256, args.workflow_sha256 = parts
    if not args.project_commit or not args.controller_sha256 or not args.workflow_sha256 or not COMMIT_RE.fullmatch(args.project_commit) or not SHA_RE.fullmatch(args.controller_sha256) or not SHA_RE.fullmatch(args.workflow_sha256) or not SHA_RE.fullmatch(args.token_sha256):
        raise SystemExit("immutable_sha256_and_project_commit_required")
    CONFIG.update({"project_commit": args.project_commit.lower(), "controller_sha256": args.controller_sha256.lower(), "workflow_sha256": args.workflow_sha256.lower()})
    ROOT.mkdir(parents=True, exist_ok=True); LOG_DIR.mkdir(parents=True, exist_ok=True)
    with STATE_LOCK:
        STATE["started_at"] = now(); save_locked()
    Handler.token_hash = args.token_sha256.lower()
    ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
