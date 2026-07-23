from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from image_workflow import assert_node_classes, build_text_workflow, validate_request, workflow_metadata


STARTED_AT = time.time()
WORKSPACE = Path(os.environ.get("COMFY_WORKSPACE", "/workspace"))


def sanitize_text(value: object, limit: int = 4000) -> str:
    text = str(value)
    replacements = [
        "CLORE_API_KEY",
        "SUPABASE_SECRET_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_SECRET",
        "R2_SECRET",
        "SSH_PRIVATE",
        "TOKEN=",
        "PASSWORD=",
    ]
    for marker in replacements:
        text = text.replace(marker, "<redacted>")
    return text[-limit:]


def tail_lines(path: Path, max_lines: int = 12) -> list[str]:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return []
    return [sanitize_text(line, 500) for line in lines[-max_lines:]]


class ControllerState:
    def __init__(self, comfy_host: str, comfy_port: int, state_path: Path, log_dir: Path, bind_host: str, bind_port: int) -> None:
        self.comfy_host = comfy_host
        self.comfy_port = comfy_port
        self.state_path = state_path
        self.log_dir = log_dir
        self.bind_host = bind_host
        self.bind_port = bind_port
        self.jobs: dict[str, dict[str, object]] = {}

    @property
    def comfy_base_url(self) -> str:
        return f"http://{self.comfy_host}:{self.comfy_port}"

    def runtime_state(self) -> dict[str, object]:
        payload: dict[str, object] = {}
        try:
            if self.state_path.is_file():
                loaded = json.loads(self.state_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    payload = loaded
        except Exception as error:
            payload = {"stage": "state_read_failed", "error": sanitize_text(error)}

        stage = str(payload.get("stage") or "starting_comfyui")
        ready = payload.get("ready") is True
        error = payload.get("error")
        diagnostics = {
            "controller_pid": os.getpid(),
            "supervisor_controller_pid": payload.get("controller_pid"),
            "comfyui_pid": payload.get("comfyui_pid"),
            "stage": stage,
            "comfyui_exit_code": payload.get("comfyui_exit_code"),
            "last_stderr_lines": tail_lines(self.log_dir / "comfyui.log"),
            "node_profile": payload.get("node_profile") or os.environ.get("COMFY_NODE_PROFILE", "image-flux"),
            "runtime_mode": payload.get("runtime_mode") or os.environ.get("COMFY_RUNTIME_MODE", "gpu"),
            "gpu_profile": payload.get("gpu_profile") or os.environ.get("COMFY_GPU_PROFILE", ""),
            "model_directories": payload.get("model_directories") or [str(WORKSPACE / "models")],
            "uptime_seconds": max(0, int(time.time() - STARTED_AT)),
            "port_binding": f"{self.bind_host}:{self.bind_port}",
            "comfyui_base_url": self.comfy_base_url,
            "last_state_update": payload.get("updated_at"),
        }
        return {
            "controller": "alive",
            "ready": ready,
            "stage": "runtime_ready" if ready else stage,
            "error": sanitize_text(error) if error else None,
            "diagnostics": diagnostics,
        }


def request_upstream(url: str, method: str = "GET", body: bytes | None = None) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read()
    except Exception as error:
        return 503, {}, json.dumps({"error": "upstream_unavailable", "detail": str(error)}).encode()


def json_payload(data: bytes) -> object:
    try:
        return json.loads(data.decode("utf-8")) if data else {}
    except json.JSONDecodeError:
        return {"error": "invalid_upstream_json"}


def make_handler(state: ControllerState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: object) -> None:
            return

        def read_json(self) -> object:
            length = int(self.headers.get("content-length", "0"))
            try:
                return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
            except json.JSONDecodeError:
                raise ValueError("invalid_json")

        def send_json(self, status: int, payload: object) -> None:
            body = json.dumps(payload, sort_keys=True).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def proxy_json(self, path: str, method: str = "GET", body: object | None = None) -> None:
            encoded = json.dumps(body).encode("utf-8") if body is not None else None
            status, _headers, response = request_upstream(f"{state.comfy_base_url}{path}", method, encoded)
            self.send_json(status, json_payload(response))

        def do_GET(self) -> None:
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path == "/healthz":
                self.send_json(200, state.runtime_state())
                return
            if parsed.path == "/queue":
                self.proxy_json("/queue")
                return
            if parsed.path.startswith("/history/"):
                self.proxy_json(parsed.path)
                return
            if parsed.path == "/view":
                status, headers, response = request_upstream(f"{state.comfy_base_url}/view?{parsed.query}")
                self.send_response(status)
                self.send_header("content-type", headers.get("Content-Type", "application/octet-stream"))
                self.send_header("content-length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)
                return
            if parsed.path.startswith("/jobs/"):
                job = state.jobs.get(parsed.path.removeprefix("/jobs/"))
                if not job:
                    self.send_json(404, {"error": "job_not_found"})
                    return
                prompt_id = str(job.get("prompt_id", ""))
                if prompt_id:
                    status, _headers, response = request_upstream(f"{state.comfy_base_url}/history/{prompt_id}")
                    history = json_payload(response)
                    if status == 200 and isinstance(history, dict) and prompt_id in history:
                        entry = history[prompt_id]
                        job["status"] = "completed" if isinstance(entry, dict) and entry.get("status", {}).get("status_str") == "success" else job.get("status", "generating")
                        job["history"] = entry
                self.send_json(200, job)
                return
            if parsed.path.startswith("/results/"):
                job = state.jobs.get(parsed.path.removeprefix("/results/"))
                history = job.get("history") if job else None
                outputs = history.get("outputs", {}) if isinstance(history, dict) else {}
                for output in outputs.values():
                    for image in output.get("images", []) if isinstance(output, dict) else []:
                        query = urllib.parse.urlencode({key: image[key] for key in ("filename", "subfolder", "type") if key in image})
                        status, headers, response = request_upstream(f"{state.comfy_base_url}/view?{query}")
                        self.send_response(status); self.send_header("content-type", headers.get("Content-Type", "image/png")); self.send_header("content-length", str(len(response))); self.end_headers(); self.wfile.write(response); return
                self.send_json(409, {"error": "result_not_ready"})
                return
            self.send_json(404, {"error": "not_found"})

        def do_POST(self) -> None:
            try:
                payload = self.read_json()
            except ValueError:
                self.send_json(400, {"error": "invalid_json"})
                return
            if self.path == "/prompt":
                self.proxy_json("/prompt", "POST", payload)
                return
            if self.path == "/free":
                self.proxy_json("/free", "POST", payload)
                return
            if self.path == "/restore":
                if not isinstance(payload, dict) or not isinstance(payload.get("files"), list):
                    self.send_json(400, {"error": "invalid_restore_manifest"})
                    return
                manifest = Path("/workspace/r2-cache/http-restore-manifest.json")
                manifest.parent.mkdir(parents=True, exist_ok=True)
                manifest.write_text(json.dumps(payload), encoding="utf-8")
                env = {**os.environ, "STAGE3O_R2_RESTORE_MANIFEST": str(manifest)}
                result = subprocess.run([os.environ.get("COMFY_PYTHON", "python3"), "/opt/image-runtime/restore_r2.py"], env=env, capture_output=True, text=True, timeout=90 * 60)
                if result.returncode != 0:
                    self.send_json(502, {"error": "restore_failed", "detail": result.stderr.strip().splitlines()[-1:]})
                    return
                self.send_json(200, json_payload(result.stdout.encode()))
                return
            if self.path == "/image/generate":
                try:
                    options = validate_request(payload)
                    status, _headers, response = request_upstream(f"{state.comfy_base_url}/object_info")
                    if status != 200:
                        raise ValueError("runtime_node_introspection_failed")
                    assert_node_classes(json_payload(response))
                except ValueError as error:
                    self.send_json(400, {"error": str(error)})
                    return
                job_id = str(payload.get("task_id") or uuid.uuid4())
                workflow = build_text_workflow(job_id, options)
                status, _headers, response = request_upstream(f"{state.comfy_base_url}/prompt", "POST", {"prompt": workflow, "client_id": job_id})
                upstream = json_payload(response)
                if status >= 300 or not isinstance(upstream, dict) or not upstream.get("prompt_id"):
                    self.send_json(status, {"error": "comfy_prompt_failed", "upstream": upstream})
                    return
                state.jobs[job_id] = {"job_id": job_id, "task_id": payload.get("task_id"), "mode": "text_generation", "status": "generating", "prompt_id": upstream["prompt_id"], "metadata": workflow_metadata(options), "created_at": int(time.time())}
                self.send_json(202, state.jobs[job_id])
                return
            if self.path == "/shutdown":
                self.send_json(202, {"ok": True, "status": "shutting_down"})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            self.send_json(404, {"error": "not_found"})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--comfy-host", default="127.0.0.1")
    parser.add_argument("--comfy-port", type=int, default=8188)
    parser.add_argument("--state-path", default=os.environ.get("COMFY_RUNTIME_STATE_PATH", str(WORKSPACE / "logs" / "runtime-state.json")))
    parser.add_argument("--log-dir", default=os.environ.get("COMFY_LOG_DIR", str(WORKSPACE / "logs")))
    args = parser.parse_args()
    if args.comfy_host == "0.0.0.0":
        raise SystemExit("ComfyUI must not bind to 0.0.0.0")
    server = ThreadingHTTPServer((args.host, args.port), make_handler(ControllerState(args.comfy_host, args.comfy_port, Path(args.state_path), Path(args.log_dir), args.host, args.port)))
    signal.signal(signal.SIGTERM, lambda *_args: server.shutdown())
    signal.signal(signal.SIGINT, lambda *_args: server.shutdown())
    server.serve_forever()


if __name__ == "__main__":
    main()
