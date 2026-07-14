#!/usr/bin/env python3
"""Fail-closed validation for a Runner-side ComfyUI /object_info response."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


MAX_INPUT_BYTES = 128 * 1024 * 1024


def canonical_profile_sha256(profile: dict[str, Any]) -> str:
    canonical = dict(profile)
    canonical.pop("profileSha256", None)
    payload = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--profile", required=True, type=Path)
    return parser.parse_args()


def load_json_object(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"{label} must be an existing regular file: {path}")
    size = path.stat().st_size
    if size == 0:
        raise ValueError(f"{label} must not be empty")
    if size > MAX_INPUT_BYTES:
        raise ValueError(f"{label} exceeds maximum size of {MAX_INPUT_BYTES} bytes: {size}")
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{label} is not valid JSON: {exc.msg}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} JSON top level must be an object")
    return value


def main() -> int:
    args = parse_args()
    try:
        profile = load_json_object(args.profile, "profile")
        if profile.get("schemaVersion") != 1:
            raise ValueError("profile schemaVersion must be 1")
        expected_profile_sha = profile.get("profileSha256")
        if not isinstance(expected_profile_sha, str) or not expected_profile_sha:
            raise ValueError("profile profileSha256 must be a non-empty string")
        if canonical_profile_sha256(profile) != expected_profile_sha:
            raise ValueError("profile profileSha256 mismatch")
        required_nodes = profile.get("requiredNodeClasses")
        if not isinstance(required_nodes, list) or not all(isinstance(node, str) for node in required_nodes):
            raise ValueError("profile requiredNodeClasses must be an array of strings")

        object_info = load_json_object(args.input, "object_info input")
        missing = sorted(set(required_nodes).difference(object_info))
    except (OSError, ValueError) as exc:
        print(f"object_info_validation_error={exc}", file=sys.stderr)
        return 1

    print(f"object_info_node_count={len(object_info)}")
    print(f"required_node_count={len(required_nodes)}")
    print(f"missing_node_count={len(missing)}")
    if missing:
        print("missing_nodes=" + ",".join(missing))
        return 1
    print("missing_nodes=")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
