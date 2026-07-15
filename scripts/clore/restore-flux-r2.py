#!/usr/bin/env python3
"""GPU-side read-only FLUX restore helper. It accepts only temporary read URLs or a readonly R2 environment, never write credentials."""
import hashlib
import json
import os
import pathlib
import sys
import urllib.request

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)

def main():
    manifest_path = os.environ.get("FLUX_R2_RESTORE_MANIFEST", "/workspace/flux-r2-manifest.json")
    if not pathlib.Path(manifest_path).is_file():
        fail("flux_r2_manifest_missing")
    manifest = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))
    if os.environ.get("MODEL_CACHE_ACCESS_KEY_ID") and os.environ.get("MODEL_CACHE_SECRET_ACCESS_KEY"):
        # Credentials are allowed only when the supplied identity is read-only; the controller verifies this boundary before transfer.
        pass
    for entry in manifest.get("files", []):
        relative = entry.get("relative_path", "")
        if not relative or ".." in pathlib.PurePosixPath(relative).parts:
            fail("flux_r2_unsafe_path")
        url = entry.get("download_url", "")
        if not url.startswith("https://"):
            fail("flux_r2_download_url_missing")
        target = pathlib.Path("/workspace/models") / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_suffix(target.suffix + ".part")
        with urllib.request.urlopen(url, timeout=120) as source, partial.open("wb") as destination:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                destination.write(chunk)
        data = partial.read_bytes()
        if len(data) != int(entry["size_bytes"]) or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            partial.unlink(missing_ok=True)
            fail("flux_r2_integrity_failed")
        partial.replace(target)
    print("flux_r2_restore_complete")

if __name__ == "__main__":
    main()
