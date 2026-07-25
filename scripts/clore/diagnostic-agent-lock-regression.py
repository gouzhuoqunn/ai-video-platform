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

def request(port, method, route, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    conn.request(method, route, headers=headers)
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
        process = subprocess.Popen([sys.executable, str(AGENT), "--token-sha256", token_sha, "--port", str(port)], env={**os.environ, "DIAG_ROOT": temp, "DIAG_TEST_STAGE_DELAY_SECONDS": "0.5"}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
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
            first_status, _ = request(port, "POST", "/stage/environment", token); assert first_status == 202
            second_status, _ = request(port, "POST", "/stage/gpu", token); assert second_status == 409
            terminal = wait_for(port, lambda status: status.get("stages", {}).get("environment", {}).get("status") in ("succeeded", "failed"))
            assert terminal["current_stage"] == "idle"
            health_status, health = request(port, "GET", "/healthz"); assert health_status == 200 and health["alive"] is True
            third_status, _ = request(port, "POST", "/stage/gpu", token); assert third_status == 202
            wait_for(port, lambda status: status.get("stages", {}).get("gpu", {}).get("status") in ("succeeded", "failed"))
            health_status, health = request(port, "GET", "/healthz"); assert health_status == 200 and health["current_stage"] == "idle"
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill()
    print(json.dumps({"ok": True, "health": "responsive", "concurrent_stage": 409, "terminal_stage": "bounded", "next_stage": 202}))

if __name__ == "__main__": main()
