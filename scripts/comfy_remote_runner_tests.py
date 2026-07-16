from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("comfy_remote_runner", Path(__file__).with_name("comfy-remote-runner.py"))
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def test_dry_probe() -> None:
    original_require = runner.require_json
    original_request = runner.request_json
    original_ws = runner.websocket_probe
    try:
        runner.require_json = lambda path, **_kwargs: {"node": {}} if path == "/object_info" else {}
        runner.request_json = lambda path, **_kwargs: (400, {"error": {"type": "invalid_prompt"}})
        runner.websocket_probe = lambda _client_id: {"attempted": True, "connected": False, "error": "test"}
        result = runner.dry_probe()
        assert result["ok"] is True
        assert result["prompt_validation_rejected"] is True
        assert result["websocket_remote_local"]["connected"] is False
        assert result["websocket_optional"] is True
    finally:
        runner.require_json = original_require
        runner.request_json = original_request
        runner.websocket_probe = original_ws


def test_http_polling_without_websocket() -> None:
    original_require = runner.require_json
    original_ws = runner.websocket_probe
    original_output = runner.OUTPUT_ROOT
    original_staging = runner.STAGING_ROOT
    with tempfile.TemporaryDirectory(prefix="stage3v-runner-") as temporary:
        root = Path(temporary)
        output = root / "output"
        staging = root / "staging"
        output.mkdir()
        (output / "result.png").write_bytes(b"png-test-bytes")
        workflow_path = root / "workflow.json"
        workflow_path.write_text(json.dumps({"1": {"class_type": "SaveImage", "inputs": {}}}), encoding="utf-8")
        history_calls = 0

        def fake_require(path: str, **_kwargs):
            nonlocal history_calls
            if path == "/system_stats":
                return {"devices": [{"name": "test"}]}
            if path == "/object_info":
                return {"SaveImage": {}}
            if path == "/prompt":
                return {"prompt_id": "prompt-1"}
            if path.startswith("/history/"):
                history_calls += 1
                if history_calls == 1:
                    return {}
                return {"prompt-1": {"outputs": {"1": {"images": [{"filename": "result.png", "subfolder": "", "type": "output"}]}}, "status": {"status_str": "success", "completed": True, "messages": []}}}
            if path == "/queue":
                return {"queue_running": [], "queue_pending": []}
            raise AssertionError(path)

        try:
            runner.require_json = fake_require
            runner.websocket_probe = lambda _client_id: {"attempted": True, "connected": False, "error": "tunnel-independent"}
            runner.OUTPUT_ROOT = output
            runner.STAGING_ROOT = staging
            result = runner.run_workflow(workflow_path, "stage3v-test-client", "image", 2, 0.001)
            assert result["ok"] is True
            assert result["prompt_id"] == "prompt-1"
            assert result["websocket_remote_local"]["connected"] is False
            assert result["history_verified"] is True
            assert Path(result["staged_path"]).read_bytes() == b"png-test-bytes"
            assert history_calls == 2
        finally:
            runner.require_json = original_require
            runner.websocket_probe = original_ws
            runner.OUTPUT_ROOT = original_output
            runner.STAGING_ROOT = original_staging


if __name__ == "__main__":
    test_dry_probe()
    test_http_polling_without_websocket()
    print("Remote-host-local Comfy runner, HTTP polling fallback, and optional WebSocket tests passed.")
