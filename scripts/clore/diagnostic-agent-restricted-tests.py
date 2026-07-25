#!/usr/bin/env python3
"""Focused, offline contract tests for the restricted diagnostic agent."""
import hashlib
import http.client
import importlib.util
import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENT_PATH = ROOT / "scripts" / "clore" / "diagnostic-agent.py"


def load_agent():
    spec = importlib.util.spec_from_file_location("diagnostic_agent_test", AGENT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def model_entries(agent, url="https://models.example.invalid/download"):
    content = b"fixture-model"; digest = hashlib.sha256(content).hexdigest()
    return [{"role": role, "filename": filename, "url": url, "sha256": digest, "size_bytes": len(content)} for role, (filename, _directory) in agent.APPROVED_MODELS.items()]


class FakeResponse:
    status = 200
    def __init__(self, data): self.data = data; self.offset = 0
    def read(self, size=-1):
        if size < 0: size = len(self.data) - self.offset
        chunk = self.data[self.offset:self.offset + size]; self.offset += len(chunk); return chunk
    def close(self): pass
    def __enter__(self): return self
    def __exit__(self, *_): self.close()


def assert_raises(action, expected):
    try: action()
    except Exception as error:
        assert expected in str(error), f"expected {expected}, got {error}"
    else: raise AssertionError(f"expected {expected}")


def test_manifest_and_download(agent, temp):
    agent.COMFY_DIR = Path(temp) / "ComfyUI"
    valid = {"models": model_entries(agent)}
    accepted = agent.validate_manifest(valid); assert len(accepted) == 5
    for mutate, expected in [
        (lambda body: body["models"][0].update(role="other"), "invalid_or_duplicate_model_role"),
        (lambda body: body["models"][0].update(filename="../bad"), "invalid_or_duplicate_model_filename"),
        (lambda body: body["models"][0].update(url="http://example.test/a"), "model_url_must_be_https"),
        (lambda body: body["models"].__setitem__(1, dict(body["models"][0])), "invalid_or_duplicate_model_role"),
        (lambda body: body["models"][0].update(size_bytes=0), "invalid_model_hash_or_size"),
        (lambda body: body["models"][0].update(sha256="0" * 64), None),
    ]:
        body = json.loads(json.dumps(valid)); mutate(body)
        if expected: assert_raises(lambda: agent.validate_manifest(body), expected)
    fixture = b"fixture-model"
    entry = accepted[0]
    original = agent.urllib.request.urlopen
    agent.urllib.request.urlopen = lambda *_args, **_kwargs: FakeResponse(fixture)
    try:
        first = agent.stream_model(entry); assert first["status"] == "verified"
        second = agent.stream_model(entry); assert second["status"] == "verified_existing"
        wrong = dict(entry); wrong["sha256"] = "0" * 64
        assert_raises(lambda: agent.stream_model(wrong), "model_sha256_mismatch")
    finally:
        agent.urllib.request.urlopen = original


def test_raw_fetch_and_controller_failure(agent, temp):
    source = b"print('controller')\n"; expected = hashlib.sha256(source).hexdigest()
    destination = Path(temp) / "controller.py"
    original = agent.urllib.request.urlopen
    agent.urllib.request.urlopen = lambda *_args, **_kwargs: FakeResponse(source)
    try:
        agent.fetch_small_verified("https://raw.githubusercontent.com/example/file", destination, expected)
        assert destination.read_bytes() == source
        assert_raises(lambda: agent.fetch_small_verified("https://raw.githubusercontent.com/example/file", destination, "0" * 64), "raw_sha256_mismatch")
    finally:
        agent.urllib.request.urlopen = original
    agent.CONFIG.update({"project_commit": "f" * 40, "controller_sha256": "0" * 64, "workflow_sha256": "0" * 64})
    def missing(*_args, **_kwargs): raise urllib.error.HTTPError("https://raw.githubusercontent.com/x", 404, "not found", {}, None)
    agent.urllib.request.urlopen = missing
    try: assert_raises(agent.project_runtime, "raw_download_failed")
    finally: agent.urllib.request.urlopen = original


def test_inference(agent, temp):
    task_id = "123e4567-e89b-42d3-a456-426614174000"
    agent.ARTIFACT_DIR = Path(temp) / "artifacts"
    agent.STATE["models"] = {role: {"status": "verified"} for role in agent.APPROVED_MODELS}
    payload = {"task_id": task_id, "mode": "text_generation", "prompt": "fixture", "width": 768, "height": 768, "steps": 25, "cfg": 4.0, "lora_strength": 0.8, "seed": 1, "sampler": "Euler"}
    assert_raises(lambda: agent.validate_inference_shape({**payload, "workflow": {}}), "invalid_inference_fields")
    png = b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR" + (768).to_bytes(4, "big") + (768).to_bytes(4, "big") + b"\x08\x06\x00\x00\x00" + b"fixture"
    calls = {"poll": 0}
    def fake_request(url, method="GET", payload=None, timeout=30):
        if url.endswith("/healthz"): return 200, {"controller": "alive"}
        if url.endswith("/system_stats"): return 200, {}
        if url.endswith("/image/generate"): return 202, {"job_id": task_id, "prompt_id": "p-1"}
        if "/jobs/" in url:
            calls["poll"] += 1
            return 200, {"status": "completed", "history": {"status": {"status_str": "success"}}}
        raise AssertionError(url)
    original_json, original_open = agent.request_json, agent.urllib.request.urlopen
    agent.request_json = fake_request
    agent.urllib.request.urlopen = lambda *_args, **_kwargs: FakeResponse(png)
    try:
        result = agent.stage_inference(payload); assert result["width"] == 768 and result["height"] == 768 and calls["poll"] == 1
        assert (agent.ARTIFACT_DIR / task_id / "image.png").is_file()
        def failed_controller(url, *_args, **_kwargs):
            if url.endswith("/healthz"): return 200, {"controller": "alive"}
            if url.endswith("/system_stats"): return 200, {}
            return 502, {"error": "fixture_controller_failure"}
        agent.request_json = failed_controller
        assert_raises(lambda: agent.stage_inference(payload), "controller_generate_failed")
    finally:
        agent.request_json, agent.urllib.request.urlopen = original_json, original_open


def test_comfy_missing_torch_is_bounded(agent, temp):
    original_exec, original_writable, original_venv = agent.exec_fixed, agent.writable, agent.venv_python
    agent.writable = lambda _path: {"path": str(Path(temp) / "workspace"), "writable": True}
    agent.venv_python = lambda: sys.executable
    def fake_exec(command, timeout=90, cwd=None):
        if command[:2] == [sys.executable, "-c"]:
            return {"command": " ".join(command), "exit_code": 1, "output": "ModuleNotFoundError: No module named 'torch'"}
        return {"command": " ".join(command), "exit_code": 0, "output": "fixture"}
    agent.exec_fixed = fake_exec
    try:
        assert_raises(lambda: agent.stage_comfyui({}), "cuda_torch_probe_failed")
    finally:
        agent.exec_fixed, agent.writable, agent.venv_python = original_exec, original_writable, original_venv


def request(port, method, route, token=None, body=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    if body is not None: headers["Content-Type"] = "application/json"
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    conn.request(method, route, body=body, headers=headers)
    response = conn.getresponse(); data = response.read(); status = response.status; conn.close()
    return status, data


def test_http_artifacts():
    token = "restricted-fixture-token"; token_sha = hashlib.sha256(token.encode()).hexdigest()
    task_id = "123e4567-e89b-42d3-a456-426614174000"
    sock = socket.socket(); sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]; sock.close()
    with tempfile.TemporaryDirectory(prefix="diagnostic-agent-http-") as temp:
        artifact = Path(temp) / "artifacts" / task_id; artifact.mkdir(parents=True)
        artifact.joinpath("image.png").write_bytes(b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR" + (768).to_bytes(4, "big") + (768).to_bytes(4, "big") + b"\x08\x06\x00\x00\x00")
        artifact.joinpath("metadata.json").write_text(json.dumps({"task_id": task_id, "width": 768, "height": 768}), encoding="utf-8")
        args = [sys.executable, str(AGENT_PATH), "--token-sha256", token_sha, "--project-commit", "0" * 40, "--controller-sha256", "0" * 64, "--workflow-sha256", "0" * 64, "--port", str(port)]
        process = subprocess.Popen(args, env={**__import__("os").environ, "DIAG_ROOT": temp}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        try:
            for _ in range(40):
                try:
                    status, _ = request(port, "GET", "/healthz")
                    if status == 200: break
                except OSError: time.sleep(.05)
            assert status == 200
            assert request(port, "GET", f"/artifacts/{task_id}/image")[0] == 401
            assert request(port, "GET", f"/artifacts/{task_id}/image", token)[0] == 200
            assert request(port, "GET", "/artifacts/not-a-uuid/image", token)[0] == 404
            status, data = request(port, "POST", "/stage/inference", token, json.dumps({"workflow": {}})); assert status == 400 and b"invalid_inference_fields" in data
        finally:
            process.terminate(); process.wait(timeout=5)


def main():
    with tempfile.TemporaryDirectory(prefix="diagnostic-agent-restricted-") as temp:
        agent = load_agent(); agent.ROOT = Path(temp); agent.STATE_FILE = agent.ROOT / "state.json"; agent.RUNTIME_DIR = agent.ROOT / "runtime"; agent.ARTIFACT_DIR = agent.ROOT / "artifacts"
        test_manifest_and_download(agent, temp)
        test_raw_fetch_and_controller_failure(agent, temp)
        test_inference(agent, temp)
        test_comfy_missing_torch_is_bounded(agent, temp)
    test_http_artifacts()
    print(json.dumps({"ok": True, "raw_runtime": "verified", "models": "restricted_and_resumable", "inference": "fixed_controller_round_trip", "artifacts": "authenticated"}))


if __name__ == "__main__": main()
