from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Any


LEGACY_PATHS = (
    "/app/worker.py",
    "/app/wan_runner.py",
    "/app/config.py",
    "/app/security.py",
    "/app/healthcheck.py",
    "/app/entrypoint.sh",
    "/app/gpu-worker",
    "/app/gpu_worker",
    "/app/worker",
    "/app/__pycache__",
)
RUNTIME_SOURCES = (
    "/opt/comfy-runtime/entrypoint.sh",
    "/opt/comfy-runtime/supervisor.py",
    "/opt/comfy-runtime/controller.py",
    "/opt/comfy-runtime/launch_comfy.py",
    "/opt/comfy-runtime/healthcheck.py",
)


def root_path(root: Path, absolute_path: str) -> Path:
    return root / absolute_path.lstrip("/")


def sha256_file(path: Path) -> str | None:
    if not path.is_file() or path.is_symlink():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_runtime_references(root: Path) -> str:
    sources: list[str] = []
    for source in RUNTIME_SOURCES:
        path = root_path(root, source)
        if path.is_file():
            sources.append(path.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(sources)


def type_name(path: Path) -> str:
    if path.is_symlink():
        return "symlink"
    if path.is_file():
        return "regular"
    if path.is_dir():
        return "directory"
    return "other"


def process_has_legacy_worker() -> bool:
    proc = Path("/proc")
    if not proc.exists():
        return False
    for command_path in proc.glob("[0-9]*/cmdline"):
        try:
            command = command_path.read_bytes().replace(b"\0", b" ").decode("utf-8", errors="replace")
        except OSError:
            continue
        if "/app/worker.py" in command or "wan_runner.py" in command or "gpu-worker" in command:
            return True
    return False


def inventory_entry(
    path_name: str,
    root: Path,
    runtime_references: str,
    entrypoint: str,
    command: str,
    healthcheck: str,
) -> dict[str, Any]:
    path = root_path(root, path_name)
    exists = path.exists() or path.is_symlink()
    entry: dict[str, Any] = {
        "path": path_name,
        "exists": exists,
        "type": "missing",
        "size": None,
        "sha256": None,
        "owner": None,
        "mode": None,
        "executable": False,
        "symlinkTarget": None,
        "referencedByEntrypoint": False,
        "referencedByCmd": False,
        "referencedByHealthcheck": False,
        "referencedByCurrentRuntime": False,
        "removalDecision": "retain",
        "removalReason": "path absent",
    }
    if not exists:
        return entry

    info = path.lstat()
    entry.update(
        {
            "type": type_name(path),
            "size": info.st_size,
            "sha256": sha256_file(path),
            "owner": f"{info.st_uid}:{info.st_gid}",
            "mode": format(stat.S_IMODE(info.st_mode), "04o"),
            "executable": bool(info.st_mode & 0o111),
            "symlinkTarget": os.readlink(path) if path.is_symlink() else None,
        }
    )
    runtime_referenced = path_name in runtime_references
    entry["referencedByEntrypoint"] = path_name in entrypoint
    entry["referencedByCmd"] = path_name in command
    entry["referencedByHealthcheck"] = path_name in healthcheck
    entry["referencedByCurrentRuntime"] = runtime_referenced
    referenced = any(
        (
            entry["referencedByEntrypoint"],
            entry["referencedByCmd"],
            entry["referencedByHealthcheck"],
            runtime_referenced,
        )
    )
    if path_name == "/app/worker.py" and not referenced:
        entry["removalDecision"] = "remove"
        entry["removalReason"] = "retired legacy Worker entrypoint is not referenced by the current Runtime"
    elif referenced:
        entry["removalReason"] = "referenced by current Runtime"
    else:
        entry["removalReason"] = "not approved for removal without dedicated evidence"
    return entry


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/", help="Root filesystem to inspect; defaults to the running container")
    parser.add_argument("--output", required=True)
    parser.add_argument("--entrypoint", default="")
    parser.add_argument("--cmd", default="")
    parser.add_argument("--healthcheck", default="")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    runtime_references = read_runtime_references(root)
    entries = [
        inventory_entry(
            path,
            root,
            runtime_references,
            args.entrypoint,
            args.cmd,
            args.healthcheck,
        )
        for path in LEGACY_PATHS
    ]
    worker = next(entry for entry in entries if entry["path"] == "/app/worker.py")
    payload = {
        "legacyWorkerPathPresent": worker["exists"],
        "legacyWorkerProcessRunning": process_has_legacy_worker() if root == Path("/") else False,
        "legacyWorkerEntrypointReferenced": worker["referencedByCurrentRuntime"],
        "approvedRemovalPaths": [entry["path"] for entry in entries if entry["removalDecision"] == "remove"],
        "files": entries,
    }
    Path(args.output).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "legacy_worker_inventory "
        f"path_present={str(payload['legacyWorkerPathPresent']).lower()} "
        f"process_running={str(payload['legacyWorkerProcessRunning']).lower()} "
        f"entrypoint_referenced={str(payload['legacyWorkerEntrypointReferenced']).lower()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
