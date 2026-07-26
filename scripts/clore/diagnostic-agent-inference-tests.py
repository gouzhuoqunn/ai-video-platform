#!/usr/bin/env python3
"""Focused inference receipt regression test for the restricted Agent."""
import importlib.util
import json
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENT_PATH = ROOT / "scripts" / "clore" / "diagnostic-agent.py"
TASK_ID = "eefc2b5b-5f25-4d82-aeeb-3b8ff501a1a0"


class Response:
    status = 200
    def __init__(self, body): self.body = body
    def read(self, _size=-1): return self.body
    def __enter__(self): return self
    def __exit__(self, *_args): return None


def load_agent():
    spec = importlib.util.spec_from_file_location("diagnostic_agent_inference_test", AGENT_PATH)
    assert spec and spec.loader
    agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
    return agent


def png(width, height):
    return b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR" + width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00fixture"


def main():
    agent = load_agent()
    payload = {"task_id": TASK_ID, "mode": "text_generation", "prompt": "sensitive user input", "width": 768, "height": 768, "steps": 25, "cfg": 4.0, "lora_strength": 0.8, "seed": 1, "sampler": "Euler"}
    with tempfile.TemporaryDirectory(prefix="agent-inference-") as temp:
        agent.ROOT = Path(temp); agent.STATE_FILE = agent.ROOT / "state.json"; agent.ARTIFACT_DIR = agent.ROOT / "artifacts"
        agent.STATE = {"alive": True, "started_at": None, "current_stage": "idle", "last_error": None, "stages": {}, "models": {role: {"status": "verified"} for role in agent.APPROVED_MODELS}}
        original_request, original_open = agent.request_json, agent.urllib.request.urlopen
        def request(url, *_args, **_kwargs):
            if url.endswith("/healthz"): return 200, {"controller": "alive"}
            if url.endswith("/system_stats"): return 200, {}
            if url.endswith("/image/generate"): return 202, {"job_id": "job-fixture", "prompt_id": "prompt-fixture"}
            if "/jobs/" in url: return 200, {"status": "completed", "history": {"status": {"status_str": "success"}}}
            raise AssertionError(url)
        agent.request_json = request; agent.urllib.request.urlopen = lambda *_args, **_kwargs: Response(png(384, 384))
        try:
            agent.begin("inference")
            try: agent.stage_inference(payload)
            except agent.StageFailure as error: agent.failed("inference", error, error.data)
            else: raise AssertionError("384x384 result must fail")
        finally:
            agent.request_json, agent.urllib.request.urlopen = original_request, original_open
        record = agent.STATE["stages"]["inference"]
        assert record["status"] == "failed" and agent.STATE["current_stage"] == "idle"
        data = record["data"]
        assert data["controller_job_id"] == "job-fixture" and data["controller_prompt_id"] == "prompt-fixture"
        assert data["requested_width"] == 768 and data["requested_height"] == 768
        assert data["actual_width"] == 384 and data["actual_height"] == 384 and data["code"] == "result_dimensions_mismatch"
        assert data["png_byte_size"] > 0 and len(data["png_sha256"]) == 64
        rendered = json.dumps(agent.STATE); assert "sensitive user input" not in rendered and "prompt-fixture" in rendered
    print(json.dumps({"ok": True, "prompt_and_job_persist_before_dimension_failure": True, "failure_is_structured": True, "no_artifact_written": True}))


if __name__ == "__main__": main()
