#!/usr/bin/env python3
"""Direct, resumable GPU-host restore from short-lived read-only R2 URLs."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import pathlib
import threading
import time
import urllib.request

CONNECT_TIMEOUT_SECONDS = 30
STALL_TIMEOUT_SECONDS = 120
HEARTBEAT_SECONDS = 15
CHUNK_BYTES = 8 * 1024 * 1024


def fetch_json(url: str) -> dict:
    last_error = None
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "ai-video-platform-stage3x"})
            with urllib.request.urlopen(request, timeout=CONNECT_TIMEOUT_SECONDS) as response:
                return json.load(response)
        except Exception as error:  # the next attempt fetches the small immutable JSON again
            last_error = error
            time.sleep(2 ** attempt)
    raise RuntimeError(f"metadata_fetch_failed:{last_error}")


def atomic_json(path: pathlib.Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def restore_file(file: dict, url: str, root: pathlib.Path, update) -> dict:
    target = root / file["path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    expected_size = int(file["bytes"])
    expected_sha = file["sha256"].lower()
    if target.exists() and target.stat().st_size == expected_size:
        existing_digest = hashlib.sha256()
        with target.open("rb") as existing:
            for chunk in iter(lambda: existing.read(CHUNK_BYTES), b""):
                existing_digest.update(chunk)
        if existing_digest.hexdigest() == expected_sha:
            update(file["path"], "verified", expected_size)
            return {"path": file["path"], "status": "verified"}
        target.unlink()

    if part.exists() and part.stat().st_size > expected_size:
        part.unlink()
    started_at = time.monotonic()
    last_error = None
    for attempt in range(5):
        offset = part.stat().st_size if part.exists() else 0
        if offset == expected_size:
            break
        if time.monotonic() - started_at > 60 * 60:
            raise TimeoutError(f"restore_object_timeout:{file['path']}")
        headers = {"User-Agent": "ai-video-platform-stage3x"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=STALL_TIMEOUT_SECONDS) as response, part.open("ab" if offset else "wb") as output:
                while True:
                    chunk = response.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    output.write(chunk)
                    offset += len(chunk)
                    update(file["path"], "downloading", offset)
            last_error = None
        except Exception as error:
            last_error = error
            update(file["path"], "reconnecting", part.stat().st_size if part.exists() else 0)
            time.sleep(2 ** attempt)
    if last_error and (not part.exists() or part.stat().st_size != expected_size):
        raise RuntimeError(f"restore_reconnect_exhausted:{file['path']}:{last_error}")
    if part.stat().st_size != expected_size:
        raise ValueError(f"size_mismatch:{file['path']}:{part.stat().st_size}:{expected_size}")
    digest = hashlib.sha256()
    with part.open("rb") as source:
        for chunk in iter(lambda: source.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected_sha:
        raise ValueError(f"sha256_mismatch:{file['path']}")
    os.replace(part, target)
    update(file["path"], "verified", expected_size)
    return {"path": file["path"], "status": "verified"}


def run(bundle_path: pathlib.Path) -> None:
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    if bundle.get("schemaVersion") != 1:
        raise ValueError("restore_bundle_schema_invalid")
    current = fetch_json(bundle["currentUrl"])
    if current.get("manifestKey") != bundle["expectedManifestKey"]:
        raise ValueError("current_manifest_key_mismatch")
    manifest = fetch_json(bundle["manifestUrl"])
    if manifest.get("familyId") != bundle["familyId"] or manifest.get("revision") != current.get("revision"):
        raise ValueError("manifest_identity_mismatch")
    progress_path = pathlib.Path(bundle["progressPath"])
    state = {"familyId": bundle["familyId"], "status": "restoring", "startedAt": time.time(), "files": {}}
    lock = threading.Lock()

    def update(name: str, status: str, completed: int) -> None:
        with lock:
            state["files"][name] = {"status": status, "completedBytes": completed, "updatedAt": time.time()}
            state["heartbeatAt"] = time.time()
            atomic_json(progress_path, state)

    root = pathlib.Path(bundle["destinationRoot"])
    atomic_json(progress_path, state)
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=int(bundle["parallelDownloads"])) as pool:
            futures = []
            for file in manifest["files"]:
                url = bundle["objectUrls"].get(file["objectKey"])
                if not url:
                    raise ValueError(f"missing_presigned_object_url:{file['objectKey']}")
                futures.append(pool.submit(restore_file, file, url, root, update))
            for future in concurrent.futures.as_completed(futures):
                future.result()
        state["status"] = "completed"
        state["completedAt"] = time.time()
        atomic_json(progress_path, state)
    except Exception as error:
        state["status"] = "failed"
        state["error"] = f"{type(error).__name__}:{error}"
        state["failedAt"] = time.time()
        atomic_json(progress_path, state)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True)
    run(pathlib.Path(parser.parse_args().bundle))
