#!/usr/bin/env python3
"""Focused Controller-to-ComfyUI JSON boundary regression tests."""
import http.client
import importlib.util
import json
import socket
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTROLLER_PATH = ROOT / "comfy-runtime" / "controller.py"


def load_controller():
    spec = importlib.util.spec_from_file_location("controller_json_boundary", CONTROLLER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    import sys
    sys.path.insert(0, str(CONTROLLER_PATH.parent))
    try: spec.loader.exec_module(module)
    finally: sys.path.pop(0)
    return module


def unused_port():
    sock = socket.socket(); sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]; sock.close(); return port


def json_response(handler, status, body):
    encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
    handler.send_response(status); handler.send_header("Content-Type", "application/json"); handler.send_header("Content-Length", str(len(encoded))); handler.end_headers(); handler.wfile.write(encoded)


def request(port, method, route, body=None):
    headers = {"Content-Type": "application/json"} if body is not None else {}
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5); conn.request(method, route, body=body, headers=headers)
    response = conn.getresponse(); raw = response.read(); status = response.status; conn.close(); return status, json.loads(raw.decode("utf-8"))


def main():
    controller = load_controller(); received = []; validation_failure = {"error": {"type": "prompt_validation", "message": "missing node"}, "node_errors": {"7": {"errors": [{"message": "invalid sampler"}]}}, "prompt_validation": {"reason": "fixture"}, "prompt": "must-not-escape", "token": "fixture-token"}
    mode = {"validation": False}
    class FakeComfy(BaseHTTPRequestHandler):
        def log_message(self, *_args): return
        def do_GET(self):
            if self.path == "/object_info":
                json_response(self, 200, {key: {} for key in {"CLIPTextEncode", "DualCLIPLoader", "EmptyFlux2LatentImage", "FluxGuidance", "KSampler", "LoraLoader", "SaveImage", "UNETLoader", "VAEDecode", "VAELoader"}}); return
            if self.path.startswith("/history/"):
                json_response(self, 200, {}); return
            json_response(self, 404, {"error": "not_found"})
        def do_POST(self):
            assert self.path == "/prompt"
            if self.headers.get("Content-Length") is None:
                try: json_response(self, 400, {"error": "missing_content_length"})
                except ConnectionResetError: pass
                return
            length = int(self.headers["Content-Length"]); raw = self.rfile.read(length)
            received.append({"raw": raw, "content_type": self.headers.get("Content-Type"), "payload": json.loads(raw.decode("utf-8"))})
            if mode["validation"]: json_response(self, 400, validation_failure)
            else: json_response(self, 200, {"prompt_id": "fake-prompt-id"})

    comfy_port, controller_port = unused_port(), unused_port()
    comfy = ThreadingHTTPServer(("127.0.0.1", comfy_port), FakeComfy); threading.Thread(target=comfy.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="controller-json-boundary-") as temp:
        state = controller.ControllerState("127.0.0.1", comfy_port, Path(temp) / "state.json", Path(temp) / "logs", "127.0.0.1", controller_port)
        server = ThreadingHTTPServer(("127.0.0.1", controller_port), controller.make_handler(state)); thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        payload = {"task_id": "123e4567-e89b-42d3-a456-426614174000", "mode": "text_generation", "prompt": "Unicode survives: 雪", "width": 768, "height": 768, "steps": 25, "cfg": 4.0, "lora_strength": 0.8, "seed": 1, "sampler": "Euler"}
        try:
            status, body = request(controller_port, "POST", "/image/generate", json.dumps(payload, ensure_ascii=False).encode("utf-8")); assert status == 202 and body["prompt_id"] == "fake-prompt-id"
            assert len(received) == 1 and isinstance(received[0]["raw"], bytes) and received[0]["content_type"] == "application/json"
            assert set(received[0]["payload"]) == {"prompt", "client_id"}; assert received[0]["payload"]["prompt"]["4"]["inputs"]["text"] == payload["prompt"]
            assert body["job_id"] in state.jobs and state.jobs[body["job_id"]]["prompt_id"] == "fake-prompt-id"
            mode["validation"] = True; status, error = request(controller_port, "POST", "/image/generate", json.dumps(payload, ensure_ascii=False).encode("utf-8")); assert status == 400 and error["error"] == "comfy_prompt_failed"
            upstream = error["upstream"]; assert upstream["http_status"] == 400 and upstream["node_errors"] and upstream["prompt_validation"] == {"reason": "fixture"}
            rendered = json.dumps(error); assert "fixture-token" not in rendered and "must-not-escape" not in rendered
            old_status, _old_headers, old_body = controller.request_upstream(f"http://127.0.0.1:{comfy_port}/prompt", "POST", {"prompt": {}})  # type: ignore[arg-type]
            assert old_status == 503 and b"can't concat str to bytes" in old_body
        finally:
            server.shutdown(); comfy.shutdown(); thread.join(timeout=5)
    source = CONTROLLER_PATH.read_text(encoding="utf-8")
    assert "request_upstream(f\"{state.comfy_base_url}/prompt\", \"POST\", {\"prompt\": workflow" not in source
    print(json.dumps({"ok": True, "json_body_bytes": True, "utf8": True, "prompt_id_stored": True, "structured_validation_error": True, "old_dict_boundary_regression": True, "single_inference_boundary": True, "secrets_redacted": True}))


if __name__ == "__main__": main()
