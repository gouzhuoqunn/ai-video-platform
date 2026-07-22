from __future__ import annotations

import argparse
import base64
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


class ControllerState:
    def __init__(self, comfy_host: str, comfy_port: int) -> None:
        self.comfy_host = comfy_host
        self.comfy_port = comfy_port
        self.jobs: dict[str, dict[str, object]] = {}

    @property
    def comfy_base_url(self) -> str:
        return f"http://{self.comfy_host}:{self.comfy_port}"


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
                status, _headers, response = request_upstream(f"{state.comfy_base_url}/system_stats")
                self.send_json(200 if status == 200 else 503, {"ok": status == 200, "comfyui_status": status, "comfyui": json_payload(response)})
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
                result = subprocess.run([os.environ.get("COMFY_PYTHON", "python3.11"), "/opt/comfy-runtime/restore_r2.py"], env=env, capture_output=True, text=True, timeout=90 * 60)
                if result.returncode != 0:
                    self.send_json(502, {"error": "restore_failed", "detail": result.stderr.strip().splitlines()[-1:]})
                    return
                self.send_json(200, json_payload(result.stdout.encode()))
                return
            if self.path == "/image/generate":
                if not isinstance(payload, dict) or payload.get("mode") not in {"text_generation", "kontext_edit"} or not isinstance(payload.get("workflow"), dict):
                    self.send_json(400, {"error": "invalid_image_generation_request"})
                    return
                if payload["mode"] == "kontext_edit" and not payload.get("reference_image"):
                    self.send_json(400, {"error": "kontext_requires_reference_image"})
                    return
                job_id = str(payload.get("task_id") or uuid.uuid4())
                workflow = payload["workflow"]
                if payload["mode"] == "kontext_edit":
                    try:
                        header, encoded = str(payload["reference_image"]).split(",", 1)
                        if not header.startswith("data:image/"):
                            raise ValueError("reference_image_not_image")
                        suffix = header.split(";", 1)[0].split("/", 1)[1].replace("jpeg", "jpg")
                        filename = f"{job_id}.{suffix}"
                        (Path("/workspace/comfy-input") / filename).write_bytes(base64.b64decode(encoded, validate=True))
                        workflow = json.loads(json.dumps(workflow).replace("__REFERENCE_IMAGE__", filename))
                    except Exception as error:
                        self.send_json(400, {"error": "invalid_reference_image", "detail": str(error)})
                        return
                status, _headers, response = request_upstream(f"{state.comfy_base_url}/prompt", "POST", {"prompt": workflow, "client_id": job_id})
                upstream = json_payload(response)
                if status >= 300 or not isinstance(upstream, dict) or not upstream.get("prompt_id"):
                    self.send_json(status, {"error": "comfy_prompt_failed", "upstream": upstream})
                    return
                state.jobs[job_id] = {"job_id": job_id, "task_id": payload.get("task_id"), "mode": payload["mode"], "status": "generating", "prompt_id": upstream["prompt_id"], "created_at": int(time.time())}
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
    args = parser.parse_args()
    if args.comfy_host == "0.0.0.0":
        raise SystemExit("ComfyUI must not bind to 0.0.0.0")
    server = ThreadingHTTPServer((args.host, args.port), make_handler(ControllerState(args.comfy_host, args.comfy_port)))
    signal.signal(signal.SIGTERM, lambda *_args: server.shutdown())
    signal.signal(signal.SIGINT, lambda *_args: server.shutdown())
    server.serve_forever()


if __name__ == "__main__":
    main()
