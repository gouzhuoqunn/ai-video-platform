#!/usr/bin/env python3
"""HTTP controller restore worker for the immutable image-only FLUX bundle."""
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
    relative = str(entry.get("runtime_path") or entry.get("relative_path") or "")
    pure = pathlib.PurePosixPath(relative)
    if not relative or pure.is_absolute() or ".." in pure.parts: raise ValueError("unsafe_model_path")
    target = pathlib.Path("/workspace/models") / pathlib.Path(*pure.parts); target.parent.mkdir(parents=True, exist_ok=True)
    if not isinstance(entry.get("sha256"), str) or len(entry["sha256"]) != 64: raise ValueError("image_manifest_sha256_required")
    expected = (int(entry["size_bytes"]), str(entry["sha256"]))
    if expected[0] <= 0: raise ValueError("image_manifest_size_required")
    if target.exists() and digest(target) == expected: return {"relative_path": relative, "reused": True}
    partial = target.with_suffix(target.suffix + ".part")
    download_url = str(entry.get("download_url") or "")
    if not download_url.startswith("https://"): raise ValueError("image_manifest_download_url_required")
    with urllib.request.urlopen(download_url, timeout=120) as source, partial.open("wb") as output:
        shutil.copyfileobj(source, output, CHUNK)
    if digest(partial) != expected: raise ValueError("model_integrity_failed")
    partial.replace(target); return {"relative_path": relative, "reused": False}

def main():
    manifest = pathlib.Path(os.environ["STAGE3O_R2_RESTORE_MANIFEST"])
    payload = json.loads(manifest.read_text(encoding="utf-8")); files = payload.get("files", [])
    if payload.get("family") != "fluxed-up-10.2-rtx4090-text" or not files or int(payload.get("parallelism", 2)) < 2: raise ValueError("image_restore_manifest_invalid")
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [future.result() for future in as_completed([pool.submit(restore, item) for item in files])]
    print(json.dumps({"restore_complete": True, "files": sorted(results, key=lambda item: item["relative_path"]), "remaining_workspace_bytes": shutil.disk_usage("/workspace").free}))

if __name__ == "__main__":
    try: main()
    except Exception as error:
        print(f"stage3o_restore_failed:{type(error).__name__}", file=sys.stderr); raise SystemExit(1)
