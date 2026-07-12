#!/usr/bin/env bash
set -euo pipefail

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi is missing. Refusing to start."
  exit 1
fi

if [ ! -f "/workspace/gpu-worker.env" ]; then
  echo "Missing /workspace/gpu-worker.env. Refusing to start without limited gpu_worker credentials."
  exit 1
fi

set -a
source /workspace/gpu-worker.env
set +a

export WAN_RUNNER="${WAN_RUNNER:-real}"
export WAN_MODEL_DIR="${WAN_MODEL_DIR:-/workspace/models/Wan2.2-TI2V-5B}"
export WAN_OUTPUT_DIR="${WAN_OUTPUT_DIR:-/workspace/jobs}"
export WAN_WIDTH="${WAN_WIDTH:-1280}"
export WAN_HEIGHT="${WAN_HEIGHT:-704}"
export WAN_NUM_FRAMES="${WAN_NUM_FRAMES:-120}"

if [ -n "${CLORE_API_KEY:-}" ] || [ -n "${SUPABASE_SECRET_KEY:-}" ] || [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "Forbidden secret detected in worker environment. Refusing to start."
  exit 1
fi

python3 /workspace/app/gpu-worker/worker.py
