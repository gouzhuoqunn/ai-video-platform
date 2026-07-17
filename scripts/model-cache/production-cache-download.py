#!/usr/bin/env python3
"""Credential-gated exact-file downloader used only by the bounded Stage 3X cache workflow."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import urllib.request


def download(url: str, target: pathlib.Path, expected_size: int, expected_sha: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    offset = part.stat().st_size if part.exists() else 0
    headers = {"User-Agent": "ai-video-platform-stage3x-cache"}
    if "civitai.com" in url:
        token = os.environ.get("CIVITAI_API_TOKEN", "").strip()
        if not token:
            raise RuntimeError("CIVITAI_API_TOKEN_missing")
        headers["Authorization"] = f"Bearer {token}"
    if "huggingface.co" in url and os.environ.get("HF_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['HF_TOKEN']}"
    if offset:
        headers["Range"] = f"bytes={offset}-"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=1800) as response, part.open("ab" if offset else "wb") as output:
        for chunk in iter(lambda: response.read(8 * 1024 * 1024), b""):
            output.write(chunk)
    if part.stat().st_size != expected_size:
        raise RuntimeError(f"size_mismatch:{target.name}")
    digest = hashlib.sha256()
    with part.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest().lower() != expected_sha.lower():
        raise RuntimeError(f"sha256_mismatch:{target.name}")
    os.replace(part, target)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--family", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    registry = json.loads(pathlib.Path("comfy-runtime/production-model-registry.json").read_text(encoding="utf-8"))
    family = next((item for item in registry["families"] if item["id"] == args.family), None)
    if not family:
        raise RuntimeError("unknown_family")
    output = pathlib.Path(args.output)
    for item in family["objects"]:
        download(item["source"], output / item["path"], int(item["bytes"]), item["sha256"])


if __name__ == "__main__":
    main()
