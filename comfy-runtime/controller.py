from __future__ import annotations

import argparse
import json
import os
import signal
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ControllerState:
    def __init__(self, comfy_host: str, comfy_port: int) -> None:
        self.comfy_host = comfy_host
        self.comfy_port = comfy_port

    @property
    def comfy_base_url(self) -> str:
        return f"http://{self.comfy_host}:{self.comfy_port}"


def request_json(url: str, method: str = "GET") -> tuple[int, object]:
    request = urllib.request.Request(url, method=method)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = response.read().decode("utf-8")
            return response.status, json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        return error.code, {"error": payload}
    except Exception as error:
        return 503, {"error": str(error)}


def make_handler(state: ControllerState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            return

        def send_json(self, status: int, payload: object) -> None:
            body = json.dumps(payload, sort_keys=True).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/healthz":
                comfy_status, comfy_payload = request_json(f"{state.comfy_base_url}/system_stats")
                self.send_json(
                    200 if comfy_status == 200 else 503,
                    {
                        "ok": comfy_status == 200,
                        "comfyui_commit": os.environ.get("COMFYUI_COMMIT"),
                        "comfyui_bind": state.comfy_base_url,
                        "comfyui_status": comfy_status,
                        "comfyui": comfy_payload,
                    },
                )
                return
            if self.path == "/queue":
                status, payload = request_json(f"{state.comfy_base_url}/queue")
                self.send_json(status, payload)
                return
            self.send_json(404, {"error": "not_found"})

        def do_POST(self) -> None:
            if self.path == "/interrupt":
                status, payload = request_json(f"{state.comfy_base_url}/interrupt", method="POST")
                if status in (200, 204, 404):
                    self.send_json(200, {"ok": True, "upstream_status": status, "upstream": payload})
                else:
                    self.send_json(status, {"ok": False, "upstream_status": status, "upstream": payload})
                return
            self.send_json(404, {"error": "not_found"})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--comfy-host", default="127.0.0.1")
    parser.add_argument("--comfy-port", type=int, default=8188)
    args = parser.parse_args()

    if args.comfy_host == "0.0.0.0":
        raise SystemExit("ComfyUI must not bind to 0.0.0.0")

    state = ControllerState(args.comfy_host, args.comfy_port)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(state))

    def shutdown(_signum: int, _frame: object) -> None:
        server.shutdown()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    server.serve_forever()


if __name__ == "__main__":
    main()
