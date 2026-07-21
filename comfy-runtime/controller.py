from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class ControllerState:
    def __init__(self, comfy_host: str, comfy_port: int) -> None:
        self.comfy_host = comfy_host
        self.comfy_port = comfy_port

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
