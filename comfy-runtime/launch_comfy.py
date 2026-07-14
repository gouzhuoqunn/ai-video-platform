from __future__ import annotations

import argparse
import hashlib
import json
import os
import runpy
import sys
from pathlib import Path
from typing import Any


COMFY_DIR = Path(os.environ.get("COMFYUI_DIR", "/opt/ComfyUI"))
RUNTIME_DIR = Path(os.environ.get("COMFY_RUNTIME_DIR", "/opt/comfy-runtime"))
PROFILE_DIR = Path(os.environ.get("COMFY_NODE_PROFILE_DIR", RUNTIME_DIR / "node-profiles"))


def log(message: str) -> None:
    print(message, flush=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def profile_path(name: str) -> Path:
    normalized = name.replace("_", "-")
    return PROFILE_DIR / f"{normalized}.json"


def load_profile(name: str) -> dict[str, Any]:
    path = profile_path(name)
    with path.open("r", encoding="utf-8") as handle:
        profile = json.load(handle)
    if profile.get("schemaVersion") != 1:
        raise RuntimeError(f"unsupported node profile schema: {path}")
    return profile


def verify_profile_inputs(profile: dict[str, Any]) -> None:
    expected_manifest = profile.get("workflowManifestSha256")
    manifest = RUNTIME_DIR / "workflows" / "official" / "manifest.json"
    if expected_manifest and manifest.exists():
        actual = sha256_file(manifest)
        if actual != expected_manifest:
            raise RuntimeError(
                f"workflow manifest sha256 mismatch: expected {expected_manifest}, got {actual}"
            )

    expected_audit = profile.get("sourceAuditSha256")
    audit = RUNTIME_DIR / "comfyui-source-audit.json"
    if expected_audit and audit.exists():
        actual = sha256_file(audit)
        if actual != expected_audit:
            raise RuntimeError(f"source audit sha256 mismatch: expected {expected_audit}, got {actual}")


def load_builtin_extra(nodes_module: Any, relative_file: str) -> None:
    path = COMFY_DIR / relative_file
    if not path.exists():
        raise RuntimeError(f"profile builtin extra file missing: {relative_file}")

    log(f"PROFILE_LOADING_BUILTIN_EXTRA {relative_file}")
    try:
        success = nodes_module.load_custom_node(str(path), set(), "comfy_extras")
    except TypeError:
        try:
            success = nodes_module.load_custom_node(str(path), set())
        except TypeError:
            success = nodes_module.load_custom_node(str(path))
    if success is False:
        raise RuntimeError(f"profile builtin extra failed to load: {relative_file}")
    log(f"PROFILE_LOADED_BUILTIN_EXTRA {relative_file}")


def patch_node_profile(profile: dict[str, Any]) -> None:
    if profile.get("useComfyDefaultBuiltinExtras") is True:
        log(f"node_profile={profile.get('profile')} builtin_extra_mode=comfy_default")
        return

    sys.path.insert(0, str(COMFY_DIR))
    os.chdir(COMFY_DIR)
    import nodes  # type: ignore

    builtin_files = list(profile.get("builtinExtraFiles", []))
    required_nodes = set(profile.get("requiredNodeClasses", []))

    def init_profile_builtin_extra_nodes(*_args: Any, **_kwargs: Any) -> None:
        for relative_file in builtin_files:
            load_builtin_extra(nodes, relative_file)

        missing = sorted(required_nodes.difference(nodes.NODE_CLASS_MAPPINGS))
        if missing:
            raise RuntimeError("profile missing required Comfy node classes: " + ", ".join(missing))
        log("PROFILE_REQUIRED_NODE_CLASSES_OK " + ",".join(sorted(required_nodes)))

    nodes.init_builtin_extra_nodes = init_profile_builtin_extra_nodes
    log(
        "node_profile="
        + str(profile.get("profile"))
        + " workflow_manifest_sha256="
        + str(profile.get("workflowManifestSha256", ""))
        + " source_audit_sha256="
        + str(profile.get("sourceAuditSha256", ""))
        + " builtin_extra_files="
        + ",".join(builtin_files)
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--node-profile", default=os.environ.get("COMFY_NODE_PROFILE", "production_minimal"))
    args, comfy_args = parser.parse_known_args()

    profile = load_profile(args.node_profile)
    verify_profile_inputs(profile)
    patch_node_profile(profile)

    sys.argv = [str(COMFY_DIR / "main.py"), *comfy_args]
    runpy.run_path(str(COMFY_DIR / "main.py"), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
