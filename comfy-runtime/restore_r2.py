#!/usr/bin/env python3
"""HTTP controller restore worker for the immutable Wan R2 bundle."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib, json, os, pathlib, shutil, sys, time, urllib.request

CHUNK = 4 * 1024 * 1024

def digest(path):
    hasher, size = hashlib.sha256(), 0
    with path.open("rb") as source:
        for data in iter(lambda: source.read(CHUNK), b""):
            size += len(data); hasher.update(data)
    return size, hasher.hexdigest()

def restore(entry):
    relative = str(entry["relative_path"]); pure = pathlib.PurePosixPath(relative)
    if not relative or pure.is_absolute() or ".." in pure.parts: raise ValueError("unsafe_model_path")
    target = pathlib.Path("/workspace/models") / pathlib.Path(*pure.parts); target.parent.mkdir(parents=True, exist_ok=True)
    expected = int(entry["size_bytes"]), str(entry["sha256"])
    if target.exists() and digest(target) == expected: return {"relative_path": relative, "reused": True}
    partial = target.with_suffix(target.suffix + ".part")
    with urllib.request.urlopen(str(entry["download_url"]), timeout=120) as source, partial.open("wb") as output:
        shutil.copyfileobj(source, output, CHUNK)
    if digest(partial) != expected: raise ValueError("model_integrity_failed")
    partial.replace(target); return {"relative_path": relative, "reused": False}

def main():
    manifest = pathlib.Path(os.environ["STAGE3O_R2_RESTORE_MANIFEST"])
    payload = json.loads(manifest.read_text(encoding="utf-8")); files = payload.get("files", [])
    if not files or int(payload.get("parallelism", 2)) != 2: raise ValueError("stage3o_manifest_invalid")
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [future.result() for future in as_completed([pool.submit(restore, item) for item in files])]
    print(json.dumps({"restore_complete": True, "files": sorted(results, key=lambda item: item["relative_path"]), "remaining_workspace_bytes": shutil.disk_usage("/workspace").free}))

if __name__ == "__main__":
    try: main()
    except Exception as error:
        print(f"stage3o_restore_failed:{type(error).__name__}", file=sys.stderr); raise SystemExit(1)
