#!/usr/bin/env python3
"""Run one ComfyUI workflow from the GPU host without a client-side tunnel."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any


BASE_URL = "http://127.0.0.1:8188"
WS_HOST = "127.0.0.1"
WS_PORT = 8188
OUTPUT_ROOT = Path("/workspace/comfy-output")
STAGING_ROOT = Path("/workspace/runtime-tools/results")


class RunnerError(RuntimeError):
    def __init__(self, code: str, detail: Any = None):
        super().__init__(code)
        self.code = code
        self.detail = detail


def request_json(path: str, *, method: str = "GET", payload: Any = None, timeout: float = 15) -> tuple[int, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        BASE_URL + path,
        data=data,
        method=method,
        headers={"content-type": "application/json"} if data is not None else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {"raw": raw.decode("utf-8", errors="replace")[-2000:]}
        return error.code, body


def require_json(path: str, *, method: str = "GET", payload: Any = None, timeout: float = 15) -> Any:
    status, body = request_json(path, method=method, payload=payload, timeout=timeout)
    if status < 200 or status >= 300:
        raise RunnerError("comfy_http_error", {"path": path, "status": status, "body": body})
    return body


def websocket_probe(client_id: str, timeout: float = 8) -> dict[str, Any]:
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    target = f"/ws?clientId={urllib.parse.quote(client_id)}"
    request = (
        f"GET {target} HTTP/1.1\r\n"
        f"Host: {WS_HOST}:{WS_PORT}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    ).encode("ascii")
    try:
        with socket.create_connection((WS_HOST, WS_PORT), timeout=timeout) as connection:
            connection.settimeout(timeout)
            connection.sendall(request)
            response = b""
            while b"\r\n\r\n" not in response and len(response) < 16384:
                chunk = connection.recv(4096)
                if not chunk:
                    break
                response += chunk
        first_line = response.split(b"\r\n", 1)[0].decode("ascii", errors="replace")
        accepted = " 101 " in first_line
        return {"attempted": True, "connected": accepted, "status_line": first_line}
    except Exception as error:
        return {"attempted": True, "connected": False, "error": type(error).__name__ + ":" + str(error)[:300]}


def dry_probe() -> dict[str, Any]:
    client_id = f"stage3v-probe-{uuid.uuid4()}"
    stats = require_json("/system_stats")
    object_info = require_json("/object_info")
    history = require_json("/history")
    queue = require_json("/queue")
    validation_status, validation = request_json(
        "/prompt",
        method="POST",
        payload={
            "client_id": client_id,
            "prompt": {"stage3v_invalid": {"class_type": "Stage3VIntentionalInvalidNode", "inputs": {}}},
        },
    )
    validation_rejected = validation_status >= 400 and isinstance(validation, dict)
    if not validation_rejected:
        raise RunnerError("dry_probe_validation_not_rejected", {"status": validation_status, "body": validation})
    return {
        "ok": True,
        "mode": "probe",
        "system_stats_json": isinstance(stats, dict),
        "object_info_json": isinstance(object_info, dict),
        "object_info_node_count": len(object_info) if isinstance(object_info, dict) else 0,
        "history_json": isinstance(history, dict),
        "queue_json": isinstance(queue, dict),
        "prompt_validation_status": validation_status,
        "prompt_validation_rejected": True,
        "websocket_remote_local": websocket_probe(client_id),
        "websocket_optional": True,
    }


def history_error(item: dict[str, Any]) -> Any | None:
    status = item.get("status")
    if isinstance(status, dict) and str(status.get("status_str", "")).lower() in {"error", "failed"}:
        return status
    messages = status.get("messages", []) if isinstance(status, dict) else []
    for message in messages if isinstance(messages, list) else []:
        if isinstance(message, list) and message and str(message[0]).lower() in {"execution_error", "execution_interrupted"}:
            return message
    return None


def collect_outputs(item: dict[str, Any]) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []
    outputs = item.get("outputs", {})
    if not isinstance(outputs, dict):
        return found
    for node_id, output in outputs.items():
        if not isinstance(output, dict):
            continue
        for key in ("images", "gifs", "videos", "audio"):
            values = output.get(key, [])
            if not isinstance(values, list):
                continue
            for value in values:
                if not isinstance(value, dict) or not isinstance(value.get("filename"), str):
                    continue
                found.append({
                    "node_id": str(node_id),
                    "category": key,
                    "filename": value["filename"],
                    "subfolder": str(value.get("subfolder", "")),
                    "type": str(value.get("type", "output")),
                })
    return found


def safe_output_path(output: dict[str, str]) -> Path:
    if output.get("type") != "output":
        raise RunnerError("output_type_not_supported", output)
    candidate = (OUTPUT_ROOT / output.get("subfolder", "") / output["filename"]).resolve()
    root = OUTPUT_ROOT.resolve()
    if candidate != root and root not in candidate.parents:
        raise RunnerError("output_path_unsafe", output)
    if not candidate.is_file():
        raise RunnerError("output_file_missing", {"path": str(candidate), "output": output})
    return candidate


def select_output(outputs: list[dict[str, str]], kind: str) -> dict[str, str]:
    suffixes = {"image": (".png",), "video": (".webm", ".mp4")}[kind]
    for output in outputs:
        if output["filename"].lower().endswith(suffixes):
            return output
    raise RunnerError("expected_output_missing", {"kind": kind, "outputs": outputs})


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_workflow(workflow_path: Path, client_id: str, kind: str, timeout_seconds: int, poll_seconds: float) -> dict[str, Any]:
    with workflow_path.open("r", encoding="utf-8") as handle:
        workflow = json.load(handle)
    if not isinstance(workflow, dict) or not workflow:
        raise RunnerError("workflow_json_invalid")
    stats = require_json("/system_stats")
    object_info = require_json("/object_info")
    if not isinstance(object_info, dict):
        raise RunnerError("object_info_json_invalid")
    required = sorted({str(node.get("class_type")) for node in workflow.values() if isinstance(node, dict) and node.get("class_type")})
    missing = [name for name in required if name not in object_info]
    if missing:
        raise RunnerError("required_nodes_missing", missing)
    websocket = websocket_probe(client_id)
    submitted_at = time.time()
    submitted = require_json("/prompt", method="POST", payload={"prompt": workflow, "client_id": client_id})
    prompt_id = submitted.get("prompt_id") if isinstance(submitted, dict) else None
    if not isinstance(prompt_id, str) or not prompt_id:
        raise RunnerError("prompt_id_missing", submitted)
    deadline = time.monotonic() + timeout_seconds
    last_queue: Any = None
    history_item: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        history = require_json("/history/" + urllib.parse.quote(prompt_id))
        if not isinstance(history, dict):
            raise RunnerError("history_json_invalid")
        candidate = history.get(prompt_id)
        if isinstance(candidate, dict):
            detected = history_error(candidate)
            if detected is not None:
                raise RunnerError("history_execution_error", detected)
            outputs = collect_outputs(candidate)
            status = candidate.get("status")
            completed = isinstance(status, dict) and status.get("completed") is True
            if outputs or completed:
                history_item = candidate
                break
        last_queue = require_json("/queue")
        time.sleep(poll_seconds)
    if history_item is None:
        raise RunnerError("history_timeout", {"prompt_id": prompt_id, "last_queue": last_queue})
    outputs = collect_outputs(history_item)
    selected = select_output(outputs, kind)
    source = safe_output_path(selected)
    STAGING_ROOT.mkdir(parents=True, exist_ok=True)
    staged = STAGING_ROOT / f"{uuid.uuid4().hex}{source.suffix.lower()}"
    shutil.copy2(source, staged)
    return {
        "ok": True,
        "mode": "workflow",
        "kind": kind,
        "prompt_id": prompt_id,
        "client_id": client_id,
        "elapsed_ms": round((time.time() - submitted_at) * 1000),
        "system_stats": stats,
        "required_nodes": required,
        "required_nodes_verified": True,
        "websocket_remote_local": websocket,
        "websocket_optional": True,
        "history_verified": True,
        "queue_json_verified": isinstance(last_queue, dict) if last_queue is not None else True,
        "output": selected,
        "staged_path": str(staged),
        "output_size_bytes": staged.stat().st_size,
        "output_sha256": sha256_file(staged),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe", action="store_true")
    mode.add_argument("--workflow", type=Path)
    parser.add_argument("--client-id", default=f"stage3v-{uuid.uuid4()}")
    parser.add_argument("--kind", choices=("image", "video"), default="image")
    parser.add_argument("--timeout-seconds", type=int, default=1200)
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        result = dry_probe() if args.probe else run_workflow(args.workflow, args.client_id, args.kind, args.timeout_seconds, args.poll_seconds)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)
        return 0
    except RunnerError as error:
        print(json.dumps({"ok": False, "error": error.code, "detail": error.detail}, ensure_ascii=False, separators=(",", ":")), flush=True)
        return 1
    except Exception as error:
        print(json.dumps({"ok": False, "error": "runner_unhandled_error", "detail": type(error).__name__ + ":" + str(error)[:1000]}, ensure_ascii=False, separators=(",", ":")), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
