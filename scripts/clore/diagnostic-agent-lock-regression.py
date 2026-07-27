#!/usr/bin/env python3
"""Process-level regression test for the diagnostic agent stage gate."""
import hashlib
import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENT = ROOT / "scripts" / "clore" / "diagnostic-agent.py"

def request(port, method, route, token=None, payload=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    if data is not None: headers["Content-Type"] = "application/json"
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    conn.request(method, route, body=data, headers=headers)
    response = conn.getresponse(); body = json.loads(response.read().decode("utf-8")); conn.close()
    return response.status, body

def wait_for(port, predicate, timeout=12):
    end = time.monotonic() + timeout; last = None
    while time.monotonic() < end:
        status, body = request(port, "GET", "/status"); last = (status, body)
        if predicate(body): return body
        time.sleep(0.1)
    raise AssertionError(f"bounded status wait expired: {last}")

def main():
    token = "local-regression-token"; token_sha = hashlib.sha256(token.encode()).hexdigest()
    listener = socket.socket(); listener.bind(("127.0.0.1", 0)); port = listener.getsockname()[1]; listener.close()
    with tempfile.TemporaryDirectory(prefix="diagnostic-agent-lock-") as temp:
        process = subprocess.Popen([sys.executable, str(AGENT), "--token-sha256", token_sha, "--project-commit", "0" * 40, "--controller-sha256", "0" * 64, "--workflow-sha256", "0" * 64, "--port", str(port)], env={**os.environ, "DIAG_ROOT": temp, "DIAG_TEST_STAGE_DELAY_SECONDS": "0.5"}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        try:
            end = time.monotonic() + 8
            while True:
                try:
                    health_status, health = request(port, "GET", "/healthz")
                    if health_status == 200: break
                except OSError: pass
                if time.monotonic() >= end: raise AssertionError("agent health did not start")
                time.sleep(0.1)
            assert health["current_stage"] == "idle" and health["last_error"] is None
            first_status, first = request(port, "POST", "/stage/environment", token, {"stage_run_id": "11111111-1111-4111-8111-111111111111"}); assert first_status == 202
            first_run_id = first.get("stage_run_id"); assert isinstance(first_run_id, str) and first["stage"] == "environment"
            persisted = request(port, "GET", "/status")[1]; assert persisted["stages"]["environment"]["stage_run_id"] == first_run_id
            second_status, _ = request(port, "POST", "/stage/gpu", token, {"stage_run_id": "22222222-2222-4222-8222-222222222222"}); assert second_status == 409
            terminal = wait_for(port, lambda status: status.get("stages", {}).get("environment", {}).get("status") in ("succeeded", "failed"))
            assert terminal["stages"]["environment"]["stage_run_id"] == first_run_id
            assert terminal["current_stage"] == "idle"
            health_status, health = request(port, "GET", "/healthz"); assert health_status == 200 and health["alive"] is True
            third_status, third = request(port, "POST", "/stage/gpu", token, {"stage_run_id": "33333333-3333-4333-8333-333333333333"}); assert third_status == 202 and third["stage_run_id"] != first_run_id
            wait_for(port, lambda status: status.get("stages", {}).get("gpu", {}).get("status") in ("succeeded", "failed"))
            health_status, health = request(port, "GET", "/healthz"); assert health_status == 200 and health["current_stage"] == "idle"
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill()
    print(json.dumps({"ok": True, "health": "responsive", "concurrent_stage": 409, "terminal_stage": "bounded", "next_stage": 202}))

if __name__ == "__main__": main()
