#!/usr/bin/env python3
"""GPU-side FLUX restore using temporary read URLs only."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

CHUNK_BYTES = 4 * 1024 * 1024

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)

def safe_target(relative):
    pure = pathlib.PurePosixPath(relative)
    if not relative or pure.is_absolute() or ".." in pure.parts:
        raise ValueError("flux_r2_unsafe_path")
    return pathlib.Path("/workspace/models") / pathlib.Path(*pure.parts)

def hash_file(file_path):
    digest = hashlib.sha256()
    size = 0
    with file_path.open("rb") as source:
        while True:
            chunk = source.read(CHUNK_BYTES)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()

def download_once(url, partial, expected_size):
    existing = partial.stat().st_size if partial.exists() else 0
    if existing > expected_size:
        partial.unlink()
        existing = 0
    request = urllib.request.Request(url, headers={"Range": f"bytes={existing}-"} if existing else {})
    with urllib.request.urlopen(request, timeout=120) as source:
        status = getattr(source, "status", 200)
        mode = "ab" if existing and status == 206 else "wb"
        with partial.open(mode) as destination:
            while True:
                chunk = source.read(CHUNK_BYTES)
                if not chunk:
                    break
                destination.write(chunk)
            destination.flush()
            os.fsync(destination.fileno())

def restore_entry(entry):
    relative = str(entry.get("relative_path", ""))
    target = safe_target(relative)
    expected_size = int(entry["size_bytes"])
    expected_sha = str(entry["sha256"])
    urls = [entry.get("download_url"), entry.get("hf_fallback_url")]
    urls = [url for url in urls if isinstance(url, str) and url.startswith("https://")]
    if not urls:
        raise ValueError("flux_r2_download_url_missing")
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".part")
    if target.exists() and hash_file(target) == (expected_size, expected_sha):
        return {"relative_path": relative, "reused": True, "size_bytes": expected_size}
    last_error = None
    for url_index, url in enumerate(urls):
        for retry in range(2):
            try:
                download_once(url, partial, expected_size)
                size, sha256 = hash_file(partial)
                if size != expected_size or sha256 != expected_sha:
                    raise ValueError("flux_r2_integrity_failed")
                partial.replace(target)
                return {"relative_path": relative, "reused": False, "source": "r2" if url_index == 0 else "hf", "size_bytes": size}
            except (OSError, ValueError, urllib.error.URLError) as error:
                last_error = error
                if retry == 0:
                    time.sleep(2)
    raise RuntimeError(str(last_error or "flux_r2_restore_failed"))

def main():
    manifest_path = pathlib.Path(os.environ.get("FLUX_R2_RESTORE_MANIFEST", "/workspace/flux-r2-manifest.json"))
    if not manifest_path.is_file():
        fail("flux_r2_manifest_missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = manifest.get("files", [])
    if len(files) != 3:
        fail("flux_r2_manifest_file_count_invalid")
    started = time.monotonic()
    results = []
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(restore_entry, entry) for entry in files]
            for future in as_completed(futures):
                results.append(future.result())
    except Exception as error:
        fail(f"flux_r2_restore_failed:{type(error).__name__}")
    print(json.dumps({"flux_r2_restore_complete": True, "parallelism": 2, "elapsed_seconds": round(time.monotonic() - started, 3), "files": sorted(results, key=lambda item: item["relative_path"])}, separators=(",", ":")))

if __name__ == "__main__":
    main()
