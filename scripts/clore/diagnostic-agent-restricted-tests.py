#!/usr/bin/env python3
"""Focused, offline contract tests for the restricted diagnostic agent."""
import hashlib
import http.client
import io
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


def safetensors_fixture():
    data = b"\0" * 1024
    header = json.dumps(
        {"weight": {"dtype": "F32", "shape": [256], "data_offsets": [0, len(data)]}},
        separators=(",", ":"),
    ).encode("utf-8")
    return len(header).to_bytes(8, "little") + header + data


def additional_lora_entry(
    content,
    *,
    lora_id="123e4567-e89b-42d3-a456-426614174001",
    filename="fixture-extra-lora.safetensors",
    url="https://models.example.invalid/fixture-extra-lora.safetensors",
):
    return {
        "id": lora_id,
        "filename": filename,
        "url": url,
        "sha256": hashlib.sha256(content).hexdigest(),
        "size_bytes": len(content),
    }


class FakeResponse:
    status = 200
    def __init__(self, data): self.data = data; self.offset = 0; self.headers = {"Content-Type": "text/plain", "Content-Length": str(len(data))}
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
    extra_content = safetensors_fixture()
    extra = additional_lora_entry(extra_content)
    extended = agent.validate_manifest({"models": model_entries(agent), "loras": [extra]})
    assert len(extended) == 6
    dynamic = extended[-1]
    assert dynamic["kind"] == "additional_lora"
    assert dynamic["state_bucket"] == "lora_files" and dynamic["state_key"] == extra["filename"]
    assert Path(dynamic["destination"]) == agent.COMFY_DIR / "models" / "loras" / extra["filename"]
    assert dynamic["destination"].startswith(str(agent.COMFY_DIR / "models" / "loras"))
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
    for body, expected in [
        (
            {"models": model_entries(agent), "loras": [{**extra, "filename": "../escape.safetensors"}]},
            "invalid_or_duplicate_lora_filename",
        ),
        (
            {"models": model_entries(agent), "loras": [{**extra, "destination": "/tmp/escape"}]},
            "invalid_additional_lora_fields",
        ),
        (
            {"models": model_entries(agent), "loras": [extra, {**extra, "filename": "other.safetensors"}]},
            "invalid_or_duplicate_lora_id",
        ),
        (
            {"models": model_entries(agent), "loras": [{**extra, "filename": agent.APPROVED_MODELS["lora"][0]}]},
            "invalid_or_duplicate_lora_filename",
        ),
    ]:
        assert_raises(lambda body=body: agent.validate_manifest(body), expected)
    fixture = b"fixture-model"
    entry = accepted[0]
    original = agent.urllib.request.urlopen
    requests = []
    def downloaded(request, *_args, **_kwargs):
        requests.append(request); return FakeResponse(fixture)
    agent.urllib.request.urlopen = downloaded
    try:
        first = agent.stream_model(entry); assert first["status"] == "verified"
        second = agent.stream_model(entry); assert second["status"] == "verified_existing" and len(requests) == 1
        assert requests[0].get_header("User-agent") == "ai-video-platform-model-fetch/1"
        assert requests[0].get_header("Accept") == "application/octet-stream"
        wrong = dict(entry); wrong["sha256"] = "0" * 64
        assert_raises(lambda: agent.stream_model(wrong), "model_sha256_mismatch")
    finally:
        agent.urllib.request.urlopen = original


def test_additional_lora_download_validation_and_state(agent, temp):
    agent.COMFY_DIR = Path(temp) / "ComfyUI-additional-lora"
    base_manifest = {"models": model_entries(agent)}
    for entry in agent.validate_manifest(base_manifest):
        destination = Path(entry["destination"])
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"fixture-model")
    content = safetensors_fixture()
    extra = additional_lora_entry(content)
    manifest = {"models": model_entries(agent), "loras": [extra]}
    original = agent.urllib.request.urlopen
    requests = []

    def downloaded(request, *_args, **_kwargs):
        requests.append(request)
        return FakeResponse(content)

    agent.STATE["models"] = {}
    agent.STATE["lora_files"] = {}
    agent.urllib.request.urlopen = downloaded
    try:
        agent.stage_models(manifest)
    finally:
        agent.urllib.request.urlopen = original
    assert len(requests) == 1
    assert set(agent.STATE["models"]) == set(agent.APPROVED_MODELS)
    assert set(agent.STATE["lora_files"]) == {extra["filename"]}
    assert agent.STATE["lora_files"][extra["filename"]]["status"] in {"verified", "verified_existing"}
    assert (agent.COMFY_DIR / "models" / "loras" / extra["filename"]).read_bytes() == content

    corrupt = b"x" * len(content)
    corrupt_entry = additional_lora_entry(
        corrupt,
        lora_id="123e4567-e89b-42d3-a456-426614174002",
        filename="corrupt-extra-lora.safetensors",
    )
    original = agent.urllib.request.urlopen
    agent.urllib.request.urlopen = lambda *_args, **_kwargs: FakeResponse(corrupt)
    try:
        assert_raises(
            lambda: agent.stage_models({"models": model_entries(agent), "loras": [corrupt_entry]}),
            "invalid_lora_safetensors",
        )
    finally:
        agent.urllib.request.urlopen = original
    assert not (agent.COMFY_DIR / "models" / "loras" / corrupt_entry["filename"]).exists()


def test_model_http_error_is_structured_and_sanitized(agent, temp):
    agent.COMFY_DIR = Path(temp) / "ComfyUI-http-error"
    entry = agent.validate_manifest({"models": model_entries(agent, "https://signed.example/model?X-Amz-Signature=secret")})[0]
    original = agent.urllib.request.urlopen
    def denied(*_args, **_kwargs):
        raise urllib.error.HTTPError("https://signed.example/model?X-Amz-Signature=secret", 403, "Forbidden", {"Content-Type": "application/xml", "Content-Length": "99", "Retry-After": "3"}, io.BytesIO(b"<Error><Code>AccessDenied</Code><Message>SignatureDoesNotMatch https://signed.example/model?X-Amz-Signature=secret</Message></Error>"))
    agent.urllib.request.urlopen = denied
    try:
        try: agent.stream_model(entry)
        except agent.StageFailure as error:
            data = error.data
            assert data["code"] == "model_download_http_error" and data["http_status"] == 403
            assert data["final_hostname"] == "signed.example" and data["content_type"] == "application/xml" and data["retry_after"] == "3"
            assert "AccessDenied" in data["body_excerpt"] and "SignatureDoesNotMatch" in data["body_excerpt"]
            assert "secret" not in json.dumps(data) and "X-Amz-Signature" not in json.dumps(data)
        else: raise AssertionError("expected structured HTTP error")
    finally: agent.urllib.request.urlopen = original


def test_raw_fetch_and_controller_failure(agent, temp):
    source = b"print('controller')\n"; expected = hashlib.sha256(source).hexdigest()
    destination = Path(temp) / "controller.py"
    original = agent.urllib.request.urlopen
    agent.urllib.request.urlopen = lambda *_args, **_kwargs: FakeResponse(source)
    try:
        agent.fetch_small_verified([("fixture", "https://raw.githubusercontent.com/example/file")], destination, expected)
        assert destination.read_bytes() == source
        assert_raises(lambda: agent.fetch_small_verified([("fixture", "https://raw.githubusercontent.com/example/file")], destination, "0" * 64), "immutable_source_sha256_mismatch")
    finally:
        agent.urllib.request.urlopen = original
    # The runtime resolver now requires both the immutable predecessor
    # identities and the bounded, fixed patch payloads used to materialize the
    # deployed controller/workflow.  This fixture intentionally keeps the
    # values invalid/unreachable so the source-unavailable classification is
    # still the first failure.
    agent.CONFIG.update({
        "project_commit": "f" * 40,
        "controller_source_sha256": "0" * 64,
        "controller_sha256": "0" * 64,
        "controller_patch": "fixture-controller-patch",
        "workflow_source_sha256": "0" * 64,
        "workflow_sha256": "0" * 64,
        "workflow_patch": "fixture-workflow-patch",
    })
    def missing(*_args, **_kwargs): raise urllib.error.HTTPError("https://raw.githubusercontent.com/x", 404, "not found", {}, None)
    agent.urllib.request.urlopen = missing
    try: assert_raises(agent.project_runtime, "immutable_source_unavailable")
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


def test_extended_inference_contract(agent, temp):
    task_id = "123e4567-e89b-42d3-a456-426614174003"
    filename = "fixture-extra-lora.safetensors"
    legacy = {"task_id": task_id, "mode": "text_generation", "prompt": "legacy fixture", "width": 768, "height": 768, "steps": 25, "cfg": 4.0, "lora_strength": 0.8, "seed": 1, "sampler": "Euler"}
    assert agent.validate_inference_shape(legacy) == task_id
    payload = {
        **legacy,
        "prompt": "extended fixture",
        "negative_prompt": "female anatomy",
        "loras": [{"filename": filename, "strength": 0.85}],
    }
    assert agent.validate_inference_shape(payload) == task_id
    for invalid, expected in [
        ({**payload, "negative_prompt": "x" * 4001}, "invalid_negative_prompt"),
        ({**payload, "loras": [{"filename": "../escape.safetensors", "strength": 0.8}]}, "invalid_inference_lora"),
        ({**payload, "loras": [{"filename": filename, "strength": True}]}, "invalid_inference_lora"),
        ({**payload, "loras": [{"filename": filename, "strength": 0.8}, {"filename": filename, "strength": 0.7}]}, "invalid_inference_lora"),
        ({**payload, "loras": [{"filename": f"extra-{index}.safetensors", "strength": 0.8} for index in range(9)]}, "invalid_inference_loras"),
        ({**payload, "loras": [{"filename": filename, "strength": 0.8, "url": "https://example.invalid"}]}, "invalid_inference_lora_fields"),
    ]:
        assert_raises(lambda invalid=invalid: agent.validate_inference_shape(invalid), expected)

    agent.ARTIFACT_DIR = Path(temp) / "extended-artifacts"
    agent.STATE["models"] = {role: {"status": "verified"} for role in agent.APPROVED_MODELS}
    agent.STATE["lora_files"] = {}
    original_json, original_open = agent.request_json, agent.urllib.request.urlopen
    agent.request_json = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("unverified LoRA reached Controller"))
    try:
        assert_raises(lambda: agent.stage_inference(payload), "requested_loras_not_verified")
    finally:
        agent.request_json = original_json

    calls = []
    agent.STATE["lora_files"] = {
        filename: {
            "filename": filename,
            "status": "verified",
            "sha256": "1" * 64,
            "size_bytes": len(safetensors_fixture()),
        },
    }

    def request(url, method="GET", body=None, timeout=30):
        if url.endswith("/healthz"): return 200, {"controller": "alive"}
        if url.endswith("/system_stats"): return 200, {}
        if url.endswith("/image/generate"):
            calls.append(body)
            return 202, {"job_id": "extended-job", "prompt_id": "extended-prompt"}
        if "/jobs/" in url:
            return 200, {"status": "completed", "history": {"status": {"status_str": "success"}}}
        raise AssertionError(url)

    png = b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR" + (768).to_bytes(4, "big") + (768).to_bytes(4, "big") + b"\x08\x06\x00\x00\x00" + b"extended"
    agent.request_json = request
    agent.urllib.request.urlopen = lambda *_args, **_kwargs: FakeResponse(png)
    try:
        result = agent.stage_inference(payload)
    finally:
        agent.request_json, agent.urllib.request.urlopen = original_json, original_open
    assert result["width"] == 768 and result["height"] == 768
    assert calls == [payload]
    rendered = json.dumps(agent.STATE)
    assert payload["prompt"] not in rendered and payload["negative_prompt"] not in rendered


def test_comfy_missing_torch_is_bounded(agent, temp):
    original_exec, original_logged, original_writable, original_venv = agent.exec_fixed, agent.exec_logged, agent.writable, agent.venv_python
    agent.writable = lambda _path: {"path": str(Path(temp) / "workspace"), "writable": True}
    agent.venv_python = lambda: sys.executable
    def fake_exec(command, timeout=90, cwd=None):
        if command[:2] == [sys.executable, "-c"]:
            return {"command": " ".join(command), "exit_code": 1, "output": "ModuleNotFoundError: No module named 'torch'"}
        return {"command": " ".join(command), "exit_code": 0, "output": "fixture"}
    agent.exec_fixed = fake_exec
    agent.exec_logged = lambda name, command, timeout, cwd=None: {"command": " ".join(command), "log_path": str(Path(temp) / f"{name}.log"), "started_at": "fixture", "finished_at": "fixture", "duration_seconds": 0, "exit_code": 0, "timed_out": False, "first_output_lines": [], "final_output_lines": [], "error_matches": []}
    try:
        assert_raises(lambda: agent.stage_comfyui({}), "cuda_torch_probe_failed")
    finally:
        agent.exec_fixed, agent.exec_logged, agent.writable, agent.venv_python = original_exec, original_logged, original_writable, original_venv


def logged_result(agent, temp, name, command, code=0, timed_out=False, output="fixture"):
    path = Path(temp) / "logs" / f"{name}.log"; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(output, encoding="utf-8")
    lines = output.splitlines()
    return {"command": " ".join(command), "log_path": str(path), "started_at": "fixture", "finished_at": "fixture", "duration_seconds": 1.25, "exit_code": code, "timed_out": timed_out, "first_output_lines": lines[:30], "final_output_lines": lines[-120:], "error_matches": [line for line in lines if "ERROR" in line or "ResolutionImpossible" in line]}


def test_comfy_torch_requirements_and_logging(agent, temp):
    original = agent.VENV, agent.COMFY_DIR, agent.ROOT, agent.LOG_DIR, agent.exec_fixed, agent.exec_logged, agent.ensure_venv, agent.writable, agent.probe, agent.venv_python, agent.subprocess.Popen
    agent.VENV = Path(temp) / "venv"; agent.COMFY_DIR = Path(temp) / "ComfyUI"; agent.ROOT = Path(temp) / "root"; agent.LOG_DIR = agent.ROOT / "logs"; agent.COMFY_DIR.mkdir(exist_ok=True)
    agent.COMFY_DIR.joinpath("requirements.txt").write_text("torch==9.9\ntorchvision>=9\ntorchaudio ; sys_platform == 'linux'\naiohttp==3\n# torch comment\ncomfy-aimdo==0.4.10\n", encoding="utf-8")
    try:
        assert agent.TORCH_REQUIREMENTS == ("torch==2.8.0", "torchvision==0.23.0", "torchaudio==2.8.0")
        assert agent.PYTORCH_CU128_INDEX.endswith("/cu128")
        filtered, constraints = agent.write_comfy_requirements()
        assert filtered.read_text(encoding="utf-8") == "aiohttp==3\n# torch comment\ncomfy-aimdo==0.4.10\n"
        assert constraints.read_text(encoding="utf-8") == "torch==2.8.0\ntorchvision==0.23.0\ntorchaudio==2.8.0\n"
        # Full retained logs preserve terminal errors after a long download transcript.
        agent.LOG_DIR.mkdir(parents=True, exist_ok=True)
        error = agent.exec_logged("long-error", [sys.executable, "-c", "import sys;print('x'*7001);print('ERROR: terminal failure');sys.exit(7)"], 10)
        assert error["exit_code"] == 7 and error["timed_out"] is False and "ERROR: terminal failure" in error["error_matches"] and "ERROR: terminal failure" in error["final_output_lines"] and error["duration_seconds"] >= 0
        timeout = agent.exec_logged("timeout", [sys.executable, "-c", "import time;print('partial-output',flush=True);time.sleep(10)"], 0.1)
        assert timeout["timed_out"] is True and "partial-output" in timeout["final_output_lines"]
        conflict = agent.exec_logged("conflict", [sys.executable, "-c", "import sys;print('ResolutionImpossible: conflict');sys.exit(1)"], 10)
        assert "ResolutionImpossible: conflict" in conflict["error_matches"]
        # A successful stage uses only the fixed cu128 stack, constraints, pip check, and import probe.
        calls = []
        agent.ensure_venv = lambda: {"reused": True}; agent.writable = lambda _path: {"path": str(Path(temp) / "workspace"), "writable": True}; agent.venv_python = lambda: sys.executable; agent.probe = lambda _url, attempts=30, timeout=3: {"status": 200, "body": "{}"}
        def fixed(command, timeout=90, cwd=None):
            calls.append(("fixed", command)); return {"command": " ".join(command), "exit_code": 0, "output": "fixture"}
        def logged(name, command, timeout, cwd=None):
            calls.append((name, command)); return logged_result(agent, temp, name, command)
        agent.exec_fixed, agent.exec_logged = fixed, logged
        class FakeProcess:
            pid = 0
            def poll(self): return None
            def terminate(self): return None
        agent.subprocess.Popen = lambda *_args, **_kwargs: FakeProcess()
        result = agent.stage_comfyui({}); assert result["/system_stats"]["status"] == 200
        cuda = next(command for name, command in calls if name == "pip-cuda-torch")
        assert cuda == [sys.executable, "-m", "pip", "install", "--no-input", "--progress-bar", "off", "torch==2.8.0", "torchvision==0.23.0", "torchaudio==2.8.0", "--index-url", agent.PYTORCH_CU128_INDEX]
        requirements = next(command for name, command in calls if name == "pip-comfy-requirements")
        assert "--constraint" in requirements and "torch==2.8.0" not in requirements and "torchvision==0.23.0" not in requirements and "torchaudio==2.8.0" not in requirements
        assert any(name == "pip-check" for name, _command in calls)
        assert any("comfy_aimdo" in " ".join(command) and "comfy_kitchen" in " ".join(command) for name, command in calls if name == "fixed")
    finally:
        agent.VENV, agent.COMFY_DIR, agent.ROOT, agent.LOG_DIR, agent.exec_fixed, agent.exec_logged, agent.ensure_venv, agent.writable, agent.probe, agent.venv_python, agent.subprocess.Popen = original


def test_ensure_venv(agent, temp):
    original_venv, original_exec, original_writable, original_log = agent.VENV, agent.exec_fixed, agent.writable, agent.LOG_DIR
    agent.VENV = Path(temp) / "venv"; agent.LOG_DIR = Path(temp) / "logs"; agent.writable = lambda _path: {"path": str(Path(temp) / "workspace"), "writable": True}
    calls = []
    def result(command, code=0, output="fixture"):
        calls.append(command); return {"command": " ".join(command), "exit_code": code, "output": output}
    def make_venv():
        target = Path(agent.venv_python()); target.parent.mkdir(parents=True, exist_ok=True); target.write_text("fixture", encoding="utf-8")
    try:
        # A healthy existing venv is reused and never touches apt.
        make_venv(); agent.exec_fixed = lambda command, timeout=90, cwd=None: result(command)
        assert agent.ensure_venv()["reused"] is True
        assert not any(command and command[0] in {"apt-get", "env"} for command in calls)
        # A direct venv creation succeeds without apt.
        calls.clear(); __import__("shutil").rmtree(agent.VENV)
        def direct(command, timeout=90, cwd=None):
            if command[:3] == ["python3", "-m", "venv"]: make_venv()
            return result(command)
        agent.exec_fixed = direct; agent.ensure_venv()
        assert not any(command and command[0] in {"apt-get", "env"} for command in calls)
        # The known ensurepip failure installs exactly the fixed package once, then retries.
        calls.clear(); __import__("shutil").rmtree(agent.VENV)
        attempts = {"venv": 0}
        def recover(command, timeout=90, cwd=None):
            if command[:3] == ["python3", "-m", "venv"]:
                attempts["venv"] += 1
                if attempts["venv"] == 1: return result(command, 1, "ensurepip is not available; install python3.12-venv")
                make_venv()
            return result(command)
        agent.exec_fixed = recover; progress = agent.ensure_venv()
        assert attempts["venv"] == 2 and len([command for command in calls if command == ["apt-get", "update"]]) == 1
        assert len([command for command in calls if command == ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "--no-install-recommends", "python3.12-venv"]]) == 1
        assert progress["pip_probe"]["exit_code"] == 0
        # An incomplete venv is removed before creation.
        calls.clear(); __import__("shutil").rmtree(agent.VENV, ignore_errors=True); (agent.VENV / "partial").mkdir(parents=True)
        agent.exec_fixed = direct; progress = agent.ensure_venv(); assert progress["removed_incomplete_venv"] is True
        # Apt failure is bounded at ensure_venv and stage_comfyui never begins Torch/ComfyUI work.
        calls.clear(); __import__("shutil").rmtree(agent.VENV)
        def apt_fails(command, timeout=90, cwd=None):
            if command[:3] == ["python3", "-m", "venv"]: return result(command, 1, "ensurepip unavailable")
            if command == ["apt-get", "update"]: return result(command, 1, "repository unavailable")
            return result(command)
        agent.exec_fixed = apt_fails
        assert_raises(lambda: agent.stage_comfyui({}), "ensure_venv_failed")
        assert not any("torch" in " ".join(command) or command[:1] == ["git"] for command in calls)
    finally:
        agent.VENV, agent.exec_fixed, agent.writable, agent.LOG_DIR = original_venv, original_exec, original_writable, original_log


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
        args = [
            sys.executable,
            str(AGENT_PATH),
            "--token-sha256",
            token_sha,
            "--project-commit",
            "0" * 40,
            "--controller-source-sha256",
            "0" * 64,
            "--controller-sha256",
            "0" * 64,
            "--controller-patch",
            "eJyrVkrLz1eyUkpKLFKqBQA0XwV2",
            "--workflow-source-sha256",
            "0" * 64,
            "--workflow-sha256",
            "0" * 64,
            "--workflow-patch",
            "eJyrVkrLz1eyUkpKLFKqBQA0XwV2",
            "--port",
            str(port),
        ]
        process = subprocess.Popen(args, env={**__import__("os").environ, "DIAG_ROOT": temp}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        try:
            status = None
            for _ in range(40):
                try:
                    status, _ = request(port, "GET", "/healthz")
                    if status == 200: break
                except OSError: time.sleep(.05)
            if status != 200:
                exit_code = process.poll()
                stderr = process.stderr.read() if exit_code is not None and process.stderr else ""
                raise AssertionError(f"Agent HTTP fixture did not start: exit={exit_code}, stderr={stderr[-1000:]}")
            assert request(port, "GET", f"/artifacts/{task_id}/image")[0] == 401
            assert request(port, "GET", f"/artifacts/{task_id}/image", token)[0] == 200
            assert request(port, "GET", "/artifacts/not-a-uuid/image", token)[0] == 404
            status, data = request(port, "POST", "/stage/inference", token, json.dumps({"stage_run_id": "11111111-1111-4111-8111-111111111111", "workflow": {}})); assert status == 400 and b"invalid_inference_fields" in data
        finally:
            process.terminate(); process.wait(timeout=5)


def main():
    def check(name, action):
        print(f"CHECK {name}", flush=True)
        started = time.monotonic()
        try:
            action()
        except Exception:
            print(f"FAIL {name} ({time.monotonic() - started:.2f}s)", flush=True)
            raise
        print(f"PASS {name} ({time.monotonic() - started:.2f}s)", flush=True)

    with tempfile.TemporaryDirectory(prefix="diagnostic-agent-restricted-") as temp:
        agent = load_agent(); agent.ROOT = Path(temp); agent.STATE_FILE = agent.ROOT / "state.json"; agent.RUNTIME_DIR = agent.ROOT / "runtime"; agent.ARTIFACT_DIR = agent.ROOT / "artifacts"
        check("manifest_and_download", lambda: test_manifest_and_download(agent, temp))
        check("additional_lora_download_validation_and_state", lambda: test_additional_lora_download_validation_and_state(agent, temp))
        check("model_http_error_is_structured_and_sanitized", lambda: test_model_http_error_is_structured_and_sanitized(agent, temp))
        check("raw_fetch_and_controller_failure", lambda: test_raw_fetch_and_controller_failure(agent, temp))
        check("inference", lambda: test_inference(agent, temp))
        check("extended_inference_contract", lambda: test_extended_inference_contract(agent, temp))
        check("comfy_missing_torch_is_bounded", lambda: test_comfy_missing_torch_is_bounded(agent, temp))
        check("ensure_venv", lambda: test_ensure_venv(agent, temp))
        check("comfy_torch_requirements_and_logging", lambda: test_comfy_torch_requirements_and_logging(agent, temp))
    check("http_artifacts", test_http_artifacts)
    print(json.dumps({"ok": True, "venv": "fixed_reuse_and_bounded_package_repair", "torch": "cu128_2_8_pinned", "requirements": "torch_filtered_and_constrained", "pip_logs": "full_local_with_bounded_status_summary", "raw_runtime": "verified", "models": "restricted_and_resumable", "inference": "fixed_controller_round_trip", "artifacts": "authenticated"}))


if __name__ == "__main__": main()
