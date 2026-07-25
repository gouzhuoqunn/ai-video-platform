#!/usr/bin/env python3
"""Restricted, model-free diagnostic agent for a single Clore order."""
import argparse
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path("/tmp/clore-diagnostic")
STATE_FILE = ROOT / "state.json"
LOG_DIR = ROOT / "logs"
PROJECT_URL = "https://github.com/gouzhuoqunn/ai-video-platform.git"
PROJECT_COMMIT = "b5b723e97d7edd0910b1bed2a80f4c077a32cdaa"
COMFY_URL = "https://github.com/comfyanonymous/ComfyUI.git"
COMFY_COMMIT = "da2608926eaf68fd532bba4e1ace3402c5d21399"
CONTROLLER_SHA256 = "95b1c2b073cd8191221bebd26e5845e3dfddcbfca80e81fc4324805b5714e89d"
WORKFLOW_SHA256 = "566b2e562e22fb61830ec64ea43413d4537613df7eb5cc584d56113d63923334"
MAX_TEXT = 6000
LOCK = threading.Lock()
STATE = {"alive": True, "started_at": None, "current_stage": "idle", "last_error": None, "stages": {}}
CHILDREN = {}

def now(): return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def clean(value, limit=MAX_TEXT):
    text = str(value)
    text = re.sub(r"(?i)(authorization|bearer|token|secret|password|api[_-]?key)\s*[:=]\s*\S+", r"\1=<redacted>", text)
    return text[-limit:]

def save():
    ROOT.mkdir(parents=True, exist_ok=True)
    with LOCK: STATE_FILE.write_text(json.dumps(STATE, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def tail(path, lines=24):
    try: return [clean(line, 500) for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]]
    except Exception: return []

def exec_fixed(command, timeout=90, cwd=None):
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, cwd=str(cwd) if cwd else None)
    return {"command": " ".join(command), "exit_code": result.returncode, "output": clean(result.stdout)}

def writable(directory):
    try:
        path = Path(directory); path.mkdir(parents=True, exist_ok=True); probe = path / ".diagnostic-write-probe"
        probe.write_text("ok", encoding="utf-8"); probe.unlink()
        return {"path": str(path), "writable": True}
    except Exception as error: return {"path": str(directory), "writable": False, "error": clean(error, 300)}

def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""): digest.update(block)
    return digest.hexdigest()

def probe(url, attempts=30):
    last = None
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                body = response.read(32768).decode("utf-8", "replace")
                return {"status": response.status, "body": clean(body, 1200)}
        except Exception as error: last = clean(error, 500); time.sleep(1)
    return {"status": None, "error": last}

def begin(name):
    STATE["current_stage"] = name; STATE["last_error"] = None
    STATE["stages"][name] = {"status": "running", "started_at": now(), "completed_at": None, "exit_code": None, "log_tail": []}; save()

def complete(name, data):
    record = STATE["stages"][name]; record.update({"status": "succeeded", "completed_at": now(), "exit_code": 0, "data": data}); STATE["current_stage"] = "idle"; save()

def failed(name, error, data=None):
    record = STATE["stages"].setdefault(name, {}); record.update({"status": "failed", "completed_at": now(), "first_exact_failure": clean(error), "data": data or record.get("data", {})}); STATE["last_error"] = clean(error); STATE["current_stage"] = "idle"; save()

def stage_environment():
    outputs = {name: exec_fixed(command, 30) for name, command in {
        "hostname": ["hostname"], "id": ["id"], "pwd": ["pwd"], "python": ["python3", "--version"], "disk": ["df", "-h", "/"], "memory": ["free", "-h"]}.items()}
    return {"commands": outputs, "tmp": writable("/tmp"), "workspace": writable("/workspace")}

def stage_gpu():
    smi = exec_fixed(["nvidia-smi"], 30)
    torch = exec_fixed(["python3", "-c", "import json,torch; d={'torch_version':torch.__version__,'cuda_available':torch.cuda.is_available()}; d.update({'gpu_name':torch.cuda.get_device_name(0),'compute_capability':torch.cuda.get_device_capability(0),'vram':torch.cuda.get_device_properties(0).total_memory} if d['cuda_available'] else {}); print(json.dumps(d))"], 60)
    return {"nvidia_smi": smi, "torch": torch}

def project_runtime():
    root = ROOT / "project"
    if root.exists(): shutil.rmtree(root)
    clone = exec_fixed(["git", "clone", "--filter=blob:none", PROJECT_URL, str(root)], 480)
    if clone["exit_code"]: raise RuntimeError(clone["output"])
    checkout = exec_fixed(["git", "checkout", PROJECT_COMMIT], 120, root)
    if checkout["exit_code"]: raise RuntimeError(checkout["output"])
    commit = exec_fixed(["git", "rev-parse", "HEAD"], 30, root)
    runtime = root / "comfy-runtime"; controller = runtime / "controller.py"; workflow = runtime / "image_workflow.py"
    checks = {"commit": clean(commit["output"], 80).strip(), "controller_sha256": sha256(controller), "image_workflow_sha256": sha256(workflow)}
    if checks["commit"] != PROJECT_COMMIT or checks["controller_sha256"] != CONTROLLER_SHA256 or checks["image_workflow_sha256"] != WORKFLOW_SHA256: raise RuntimeError("pinned_project_source_verification_failed")
    return root, runtime, checks

def stage_controller():
    _root, runtime, checks = project_runtime(); LOG_DIR.mkdir(parents=True, exist_ok=True); log = LOG_DIR / "controller.log"
    handle = log.open("w", encoding="utf-8")
    command = ["python3", str(runtime / "controller.py"), "--host", "127.0.0.1", "--port", "18080", "--comfy-host", "127.0.0.1", "--comfy-port", "8188", "--state-path", str(ROOT / "controller-state.json"), "--log-dir", str(LOG_DIR / "controller-runtime")]
    process = subprocess.Popen(command, cwd=str(runtime), stdout=handle, stderr=subprocess.STDOUT, text=True); CHILDREN["controller"] = process
    result = probe("http://127.0.0.1:18080/healthz")
    result.update({"source": checks, "process_exit_code": process.poll(), "log_tail": tail(log)})
    if result["status"] != 200 or '"controller": "alive"' not in result.get("body", ""): raise RuntimeError(json.dumps(result))
    return result

def stage_comfyui():
    root = ROOT / "ComfyUI"
    if root.exists(): shutil.rmtree(root)
    clone = exec_fixed(["git", "clone", "--filter=blob:none", COMFY_URL, str(root)], 480)
    if clone["exit_code"]: raise RuntimeError(clone["output"])
    checkout = exec_fixed(["git", "checkout", COMFY_COMMIT], 120, root)
    if checkout["exit_code"]: raise RuntimeError(checkout["output"])
    install = exec_fixed(["python3", "-m", "pip", "install", "-r", "requirements.txt"], 900, root)
    if install["exit_code"]: raise RuntimeError(install["output"])
    log = LOG_DIR / "comfyui.log"; handle = log.open("w", encoding="utf-8")
    process = subprocess.Popen(["python3", "main.py", "--listen", "127.0.0.1", "--port", "8188"], cwd=str(root), stdout=handle, stderr=subprocess.STDOUT, text=True); CHILDREN["comfyui"] = process
    results = {path: probe("http://127.0.0.1:8188" + path, 45) for path in ("/system_stats", "/object_info", "/queue")}
    results["commit"] = COMFY_COMMIT; results["process_exit_code"] = process.poll(); results["log_tail"] = tail(log)
    if any(value.get("status") != 200 for key, value in results.items() if key.startswith("/")): raise RuntimeError(json.dumps(results))
    return results

STAGES = {"/stage/environment": ("environment", stage_environment), "/stage/gpu": ("gpu", stage_gpu), "/stage/controller": ("controller", stage_controller), "/stage/comfyui": ("comfyui", stage_comfyui)}

def run_stage(route):
    name, action = STAGES[route]
    if not LOCK.acquire(blocking=False): return False
    def worker():
        try: begin(name); complete(name, action())
        except Exception as error: failed(name, error)
        finally: LOCK.release()
    threading.Thread(target=worker, daemon=True).start(); return True

class Handler(BaseHTTPRequestHandler):
    token_hash = ""
    def log_message(self, *_args): pass
    def send_json(self, code, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8"); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        route = urlparse(self.path).path
        if route == "/healthz": self.send_json(200, {"alive": True, "current_stage": STATE["current_stage"], "last_error": STATE["last_error"]}); return
        if route == "/status": self.send_json(200, STATE); return
        if route == "/logs": self.send_json(200, {name: record.get("log_tail", []) for name, record in STATE["stages"].items()}); return
        self.send_json(404, {"error": "not_found"})
    def do_POST(self):
        route = urlparse(self.path).path; auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or not hmac.compare_digest(hashlib.sha256(auth[7:].encode()).hexdigest(), self.token_hash): self.send_json(401, {"error": "unauthorized"}); return
        if route not in STAGES: self.send_json(404, {"error": "unknown_stage"}); return
        if self.headers.get("Content-Length", "0") not in ("", "0"): self.send_json(400, {"error": "stage_parameters_forbidden"}); return
        if not run_stage(route): self.send_json(409, {"error": "stage_already_running"}); return
        self.send_json(202, {"accepted": route})

def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--token-sha256", required=True); args = parser.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True); LOG_DIR.mkdir(parents=True, exist_ok=True); STATE["started_at"] = now(); save(); Handler.token_hash = args.token_sha256.lower()
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
if __name__ == "__main__": main()
