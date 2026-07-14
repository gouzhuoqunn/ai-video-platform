from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import os
import runpy
import sys
import traceback
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


def profile_sha256(profile: dict[str, Any]) -> str:
    canonical = dict(profile)
    canonical.pop("profileSha256", None)
    payload = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def profile_path(name: str) -> Path:
    normalized = name.replace("_", "-")
    return PROFILE_DIR / f"{normalized}.json"


def validate_profile(profile: dict[str, Any]) -> None:
    builtin_files = list(profile.get("builtinExtraFiles", []))
    if len(set(builtin_files)) != len(builtin_files):
        raise RuntimeError("node profile contains duplicate builtin extra files")
    for relative_file in builtin_files:
        if not isinstance(relative_file, str):
            raise RuntimeError("node profile builtin extra file must be a string")
        path = Path(relative_file)
        if path.is_absolute() or ".." in path.parts:
            raise RuntimeError(f"node profile builtin extra file path is unsafe: {relative_file}")
        if path.parts[:1] != ("comfy_extras",) or path.suffix != ".py":
            raise RuntimeError(f"node profile builtin extra file is invalid: {relative_file}")


def load_profile(name: str) -> dict[str, Any]:
    path = profile_path(name)
    if not path.is_file():
        raise RuntimeError(f"unknown node profile: {name}")
    with path.open("r", encoding="utf-8") as handle:
        profile = json.load(handle)
    if profile.get("schemaVersion") != 1:
        raise RuntimeError(f"unsupported node profile schema: {path}")
    expected_profile_sha = profile.get("profileSha256")
    if expected_profile_sha and profile_sha256(profile) != expected_profile_sha:
        raise RuntimeError(f"node profile sha256 mismatch: {path}")
    if profile.get("status") == "unverified":
        raise RuntimeError(f"node profile is unverified and cannot be used: {profile.get('profile')}")
    validate_profile(profile)
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


def expected_arg_value(argv: list[str], flag: str, default: str) -> str:
    if flag not in argv:
        return default
    index = argv.index(flag)
    if index + 1 >= len(argv):
        raise RuntimeError(f"missing value for {flag}")
    return argv[index + 1]


def initialize_comfy_args(comfy_args: list[str]) -> bool:
    sys.path.insert(0, str(COMFY_DIR))
    os.chdir(COMFY_DIR)
    sys.argv = [str(COMFY_DIR / "main.py"), *comfy_args]

    import comfy.options  # type: ignore

    comfy.options.enable_args_parsing()
    from comfy.cli_args import args as parsed_args  # type: ignore

    require_cpu = os.environ.get("COMFY_RUNTIME_MODE") == "smoke_cpu" or "--cpu" in comfy_args
    expected_listen = expected_arg_value(comfy_args, "--listen", "127.0.0.1")
    expected_port = int(expected_arg_value(comfy_args, "--port", "8188"))

    if require_cpu and parsed_args.cpu is not True:
        raise RuntimeError("ComfyUI args.cpu was not true before importing nodes")
    if parsed_args.listen != expected_listen:
        raise RuntimeError(f"ComfyUI args.listen mismatch: expected {expected_listen}, got {parsed_args.listen}")
    if int(parsed_args.port) != expected_port:
        raise RuntimeError(f"ComfyUI args.port mismatch: expected {expected_port}, got {parsed_args.port}")

    log(
        "comfy_args_ready "
        f"cpu={parsed_args.cpu} listen={parsed_args.listen} port={parsed_args.port}"
    )
    return require_cpu


def verify_cpu_runtime_state() -> None:
    import comfy.model_management as model_management  # type: ignore

    if model_management.cpu_state != model_management.CPUState.CPU:
        raise RuntimeError(f"ComfyUI CPU state mismatch: {model_management.cpu_state}")
    device = model_management.get_torch_device()
    if getattr(device, "type", None) != "cpu":
        raise RuntimeError(f"ComfyUI torch device mismatch: {device}")
    log("comfy_cpu_state=CPU torch_device=cpu")


async def load_profile_builtin_extra_nodes(
    nodes_module: Any,
    profile: dict[str, Any],
    comfy_root: Path,
) -> list[str]:
    failed: list[str] = []
    builtin_files = list(profile.get("builtinExtraFiles", []))
    for relative_file in builtin_files:
        path = comfy_root / relative_file
        log(f"AWAITING_PROFILE_EXTRA={relative_file}")
        result = False
        if not path.exists():
            log(f"PROFILE_EXTRA_EXCEPTION {relative_file}: file does not exist")
            failed.append(relative_file)
            log(f"AWAITED_PROFILE_EXTRA={relative_file} result=false")
            continue
        try:
            loaded = await nodes_module.load_custom_node(
                str(path),
                module_parent="comfy_extras",
            )
            if inspect.isawaitable(loaded):
                if inspect.iscoroutine(loaded):
                    loaded.close()
                raise RuntimeError("load_custom_node returned an awaitable after await")
            result = bool(loaded)
        except Exception:
            log(f"PROFILE_EXTRA_EXCEPTION {relative_file}")
            log(traceback.format_exc())
            failed.append(relative_file)
            log(f"AWAITED_PROFILE_EXTRA={relative_file} result=false")
            continue
        if not result:
            failed.append(relative_file)
        log(f"AWAITED_PROFILE_EXTRA={relative_file} result={str(result).lower()}")
    return failed


def verify_required_nodes(nodes_module: Any, required_nodes: set[str]) -> None:
    missing = sorted(required_nodes.difference(nodes_module.NODE_CLASS_MAPPINGS))
    if missing:
        raise RuntimeError("profile missing required Comfy node classes: " + ", ".join(missing))
    log("PROFILE_REQUIRED_NODE_CLASSES_OK " + ",".join(sorted(required_nodes)))


def patch_node_profile(profile: dict[str, Any]) -> None:
    import nodes  # type: ignore

    builtin_files = list(profile.get("builtinExtraFiles", []))
    required_nodes = set(profile.get("requiredNodeClasses", []))

    async def init_profile_builtin_extra_nodes(*_args: Any, **_kwargs: Any) -> list[str]:
        failed = await load_profile_builtin_extra_nodes(nodes, profile, COMFY_DIR)
        if failed:
            raise RuntimeError("profile builtin extra files failed to load: " + ", ".join(failed))
        log("PROFILE_BUILTIN_EXTRA_FAILURES=0")
        verify_required_nodes(nodes, required_nodes)
        return []

    nodes.init_builtin_extra_nodes = init_profile_builtin_extra_nodes
    log(
        "node_profile="
        + str(profile.get("profile"))
        + " profile_sha256="
        + str(profile.get("profileSha256", ""))
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
    require_cpu = initialize_comfy_args(comfy_args)
    if require_cpu:
        # Importing nodes imports model_management; args.cpu must already be active.
        import nodes  # noqa: F401  # type: ignore

        verify_cpu_runtime_state()
    patch_node_profile(profile)

    sys.argv = [str(COMFY_DIR / "main.py"), *comfy_args]
    runpy.run_path(str(COMFY_DIR / "main.py"), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
