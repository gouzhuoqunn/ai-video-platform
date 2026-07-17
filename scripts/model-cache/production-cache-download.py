#!/usr/bin/env python3
"""Credential-gated exact-file downloader used only by the bounded Stage 3X cache workflow."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import pathlib
import shutil
import threading
import time
import urllib.request
import urllib.parse


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(request, fp, code, msg, headers, newurl)
        if redirected and urllib.parse.urlparse(request.full_url).netloc != urllib.parse.urlparse(newurl).netloc:
            redirected.remove_header("Authorization")
        return redirected


SAFE_OPENER = urllib.request.build_opener(SafeRedirectHandler())
STALL_TIMEOUT_SECONDS = 120
HEARTBEAT_SECONDS = 30


def verify_and_publish(part: pathlib.Path, target: pathlib.Path, expected_size: int, expected_sha: str) -> None:
    if part.stat().st_size != expected_size:
        raise RuntimeError(f"size_mismatch:{target.name}")
    digest = hashlib.sha256()
    with part.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest().lower() != expected_sha.lower():
        raise RuntimeError(f"sha256_mismatch:{target.name}")
    os.replace(part, target)


def download_huggingface(url: str, target: pathlib.Path, expected_size: int, expected_sha: str) -> None:
    from huggingface_hub import hf_hub_download

    parts = [urllib.parse.unquote(part) for part in urllib.parse.urlparse(url).path.split("/") if part]
    resolve_index = parts.index("resolve")
    repo_id = "/".join(parts[:resolve_index])
    revision = parts[resolve_index + 1]
    filename = "/".join(parts[resolve_index + 2 :])
    temporary_root = target.parent / f".hf-{expected_sha[:12]}"
    temporary_root.mkdir(parents=True, exist_ok=True)
    try:
        downloaded = pathlib.Path(hf_hub_download(repo_id=repo_id, filename=filename, revision=revision, token=os.environ.get("HF_TOKEN"), local_dir=temporary_root))
        part = target.with_suffix(target.suffix + ".part")
        os.replace(downloaded, part)
        verify_and_publish(part, target, expected_size, expected_sha)
    finally:
        shutil.rmtree(temporary_root, ignore_errors=True)


def download(url: str, target: pathlib.Path, expected_size: int, expected_sha: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if "huggingface.co" in url:
        download_huggingface(url, target, expected_size, expected_sha)
        return
    part = target.with_suffix(target.suffix + ".part")
    headers = {"User-Agent": "ai-video-platform-stage3x-cache"}
    if "civitai.com" in url:
        token = os.environ.get("CIVITAI_API_TOKEN", "").strip()
        if not token:
            raise RuntimeError("CIVITAI_API_TOKEN_missing")
        headers["Authorization"] = f"Bearer {token}"
    last_error = None
    for attempt in range(5):
        offset = part.stat().st_size if part.exists() else 0
        if offset == expected_size:
            break
        request_headers = dict(headers)
        if offset:
            request_headers["Range"] = f"bytes={offset}-"
        try:
            with SAFE_OPENER.open(urllib.request.Request(url, headers=request_headers), timeout=STALL_TIMEOUT_SECONDS) as response:
                if offset and response.status != 206:
                    part.unlink(missing_ok=True)
                    raise RuntimeError(f"range_resume_rejected:{target.name}")
                with part.open("ab" if offset else "wb") as output:
                    for chunk in iter(lambda: response.read(8 * 1024 * 1024), b""):
                        output.write(chunk)
            last_error = None
        except Exception as error:
            last_error = error
            time.sleep(2 ** attempt)
    if last_error and (not part.exists() or part.stat().st_size != expected_size):
        raise RuntimeError(f"download_resume_exhausted:{target.name}:{type(last_error).__name__}")
    verify_and_publish(part, target, expected_size, expected_sha)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--family", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--download-plan")
    args = parser.parse_args()
    registry = json.loads(pathlib.Path("comfy-runtime/production-model-registry.json").read_text(encoding="utf-8"))
    family = next((item for item in registry["families"] if item["id"] == args.family), None)
    if not family:
        raise RuntimeError("unknown_family")
    skip_paths = set()
    if args.download_plan:
        plan = json.loads(pathlib.Path(args.download_plan).read_text(encoding="utf-8"))
        if plan.get("schemaVersion") != 1 or plan.get("familyId") != family["id"]:
            raise RuntimeError("download_plan_identity_mismatch")
        skip_paths = set(plan.get("skipPaths", []))
        known_paths = {item["path"] for item in family["objects"]}
        if not skip_paths.issubset(known_paths):
            raise RuntimeError("download_plan_unknown_path")
    output = pathlib.Path(args.output)
    selected = [item for item in family["objects"] if item["path"] not in skip_paths]
    print(json.dumps({
        "familyId": family["id"],
        "skippedVerifiedR2Objects": len(skip_paths),
        "downloadObjects": len(selected),
        "downloadBytes": sum(int(item["bytes"]) for item in selected),
    }))
    heartbeat_stop = threading.Event()
    observed: dict[str, tuple[int, float]] = {}

    def heartbeat() -> None:
        while not heartbeat_stop.wait(HEARTBEAT_SECONDS):
            now = time.monotonic()
            progress = []
            stalled = []
            for item in selected:
                target = output / item["path"]
                part = target.with_suffix(target.suffix + ".part")
                current = target.stat().st_size if target.exists() else part.stat().st_size if part.exists() else 0
                previous, changed_at = observed.get(item["path"], (-1, now))
                if current != previous:
                    changed_at = now
                observed[item["path"]] = (current, changed_at)
                progress.append({"path": item["path"], "bytes": current, "expectedBytes": int(item["bytes"])})
                if current < int(item["bytes"]) and now - changed_at >= STALL_TIMEOUT_SECONDS:
                    stalled.append(item["path"])
            print(json.dumps({"stage": "download_heartbeat", "familyId": family["id"], "files": progress, "stalledPaths": stalled}), flush=True)

    heartbeat_thread = threading.Thread(target=heartbeat, name="production-cache-heartbeat", daemon=True)
    heartbeat_thread.start()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=int(family["parallelDownloads"])) as pool:
            futures = [
                pool.submit(download, item["source"], output / item["path"], int(item["bytes"]), item["sha256"])
                for item in selected
            ]
            for future in concurrent.futures.as_completed(futures):
                future.result()
    finally:
        heartbeat_stop.set()
        heartbeat_thread.join(timeout=2)


if __name__ == "__main__":
    main()
