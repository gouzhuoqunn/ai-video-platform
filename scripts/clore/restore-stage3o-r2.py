#!/usr/bin/env python3
"""Restore a locked Stage 3O model bundle through temporary read-only URLs."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib, json, os, pathlib, shutil, sys, time, urllib.request

CHUNK = 4 * 1024 * 1024

def hash_file(file_path):
    digest, size = hashlib.sha256(), 0
    with file_path.open("rb") as source:
        while True:
            data = source.read(CHUNK)
            if not data: break
            size += len(data); digest.update(data)
    return size, digest.hexdigest()

def target_path(relative):
    pure = pathlib.PurePosixPath(relative)
    if not relative or pure.is_absolute() or ".." in pure.parts: raise ValueError("unsafe_model_path")
    return pathlib.Path("/workspace/models") / pathlib.Path(*pure.parts)

def restore(entry):
    started = time.monotonic(); target = target_path(str(entry["relative_path"])); target.parent.mkdir(parents=True, exist_ok=True)
    size, sha = int(entry["size_bytes"]), str(entry["sha256"]); partial = target.with_suffix(target.suffix + ".part")
    if target.exists() and hash_file(target) == (size, sha):
        return {"relative_path": entry["relative_path"], "reused": True, "size_bytes": size, "elapsed_seconds": 0, "bytes_per_second": 0}
    existing = partial.stat().st_size if partial.exists() and partial.stat().st_size <= size else 0
    if partial.exists() and not existing: partial.unlink()
    request = urllib.request.Request(str(entry["download_url"]), headers={"Range": f"bytes={existing}-"} if existing else {})
    with urllib.request.urlopen(request, timeout=120) as source, partial.open("ab" if existing and getattr(source, "status", 200) == 206 else "wb") as output:
        while True:
            data = source.read(CHUNK)
            if not data: break
            output.write(data)
        output.flush(); os.fsync(output.fileno())
    actual = hash_file(partial)
    if actual != (size, sha): raise ValueError("model_integrity_failed")
    partial.replace(target); elapsed = max(time.monotonic() - started, 0.001)
    return {"relative_path": entry["relative_path"], "reused": False, "size_bytes": size, "elapsed_seconds": round(elapsed, 3), "bytes_per_second": round(size / elapsed)}

def main():
    manifest = pathlib.Path(os.environ.get("STAGE3O_R2_RESTORE_MANIFEST", "/workspace/stage3o-r2-bundle.json"))
    data = json.loads(manifest.read_text(encoding="utf-8")); files = data.get("files", [])
    if not files or int(data.get("parallelism", 2)) != 2: raise ValueError("stage3o_manifest_invalid")
    started = time.monotonic(); results = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        for future in as_completed([pool.submit(restore, entry) for entry in files]): results.append(future.result())
    print(json.dumps({"restore_complete": True, "parallelism": 2, "elapsed_seconds": round(time.monotonic() - started, 3), "remaining_workspace_bytes": shutil.disk_usage("/workspace").free, "files": sorted(results, key=lambda item: item["relative_path"])}, separators=(",", ":")))

if __name__ == "__main__":
    try: main()
    except Exception as error:
        print(f"stage3o_restore_failed:{type(error).__name__}", file=sys.stderr); raise SystemExit(1)
