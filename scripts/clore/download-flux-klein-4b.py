#!/usr/bin/env python3
"""Download only the three locked FLUX.2 Klein first-image files, fail closed on mismatch."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

FILES = (
    ("black-forest-labs/FLUX.2-klein-4b-fp8", "5b4408e59397a4a37ccb46afe426d8ed86379441", "flux-2-klein-4b-fp8.safetensors", "diffusion_models", "flux-2-klein-4b-fp8.safetensors", 4070624520, "97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6"),
    ("Comfy-Org/vae-text-encorder-for-flux-klein-4b", "a9e4ca87c16db4c4e1a16406a9ddb300ab0ae246", "split_files/text_encoders/qwen_3_4b.safetensors", "text_encoders", "qwen_3_4b.safetensors", 8044982048, "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a"),
    ("Comfy-Org/vae-text-encorder-for-flux-klein-4b", "a9e4ca87c16db4c4e1a16406a9ddb300ab0ae246", "split_files/vae/flux2-vae.safetensors", "vae", "flux2-vae.safetensors", 336211292, "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3"),
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_one(repo: str, revision: str, remote: str, directory: str, filename: str, expected_size: int, expected_sha: str, root: Path) -> dict[str, object]:
    destination = root / directory / filename
    partial = destination.with_suffix(destination.suffix + ".part")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size == expected_size and sha256_file(destination) == expected_sha:
        return {"file": filename, "status": "already_verified", "size": expected_size, "sha256": expected_sha}
    if destination.exists():
        destination.unlink()
    url = f"https://huggingface.co/{repo}/resolve/{revision}/{remote}?download=true"
    for attempt in range(2):
        try:
            start = partial.stat().st_size if partial.exists() else 0
            request = urllib.request.Request(url, headers={"User-Agent": "ai-video-platform-flux-first-image", **({"Range": f"bytes={start}-"} if start else {})})
            with urllib.request.urlopen(request, timeout=90) as response, partial.open("ab" if start else "wb") as handle:
                if start and response.status != 206:
                    handle.close()
                    partial.unlink(missing_ok=True)
                    raise RuntimeError("download server did not honor resume range")
                shutil.copyfileobj(response, handle, length=1024 * 1024)
            if partial.stat().st_size != expected_size:
                raise RuntimeError(f"size mismatch: expected {expected_size}, got {partial.stat().st_size}")
            digest = sha256_file(partial)
            if digest != expected_sha:
                raise RuntimeError("sha256 mismatch")
            os.replace(partial, destination)
            return {"file": filename, "status": "downloaded_verified", "size": expected_size, "sha256": expected_sha}
        except (OSError, urllib.error.URLError, urllib.error.HTTPError, RuntimeError) as error:
            if attempt == 1:
                raise RuntimeError(f"{filename}: {error}") from error
            time.sleep(2)
    raise RuntimeError(f"{filename}: unreachable")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-root", default="/workspace/models")
    args = parser.parse_args()
    root = Path(args.models_root)
    results = [download_one(*entry, root) for entry in FILES]
    print(json.dumps({"flux_model_download_verified": True, "files": results}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"flux_model_download_verified": False, "error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
