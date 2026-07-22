#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="${COMFY_RUNTIME_DIR:-/opt/image-runtime}"
PYTHON_BIN="${COMFY_PYTHON:-python3}"
exec "${PYTHON_BIN}" "${RUNTIME_DIR}/supervisor.py"
