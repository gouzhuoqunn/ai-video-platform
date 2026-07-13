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
export WAN_MODEL_REVISION="${WAN_MODEL_REVISION:-921dbaf3f1674a56f47e83fb80a34bac8a8f203e}"
export WAN_CODE_REVISION="${WAN_CODE_REVISION:-42bf4cfaa384bc21833865abc2f9e6c0e67233dc}"
export WAN_MODEL_DIR="${WAN_MODEL_DIR:-/workspace/models/Wan2.2-TI2V-5B}"
export WAN_OUTPUT_DIR="${WAN_OUTPUT_DIR:-/workspace/jobs}"
export WAN_WIDTH="${WAN_WIDTH:-1280}"
export WAN_HEIGHT="${WAN_HEIGHT:-704}"
export WAN_NUM_FRAMES="${WAN_NUM_FRAMES:-120}"
export FIRST_SESSION_MAX_CLAIMS="${FIRST_SESSION_MAX_CLAIMS:-1}"

if [ -n "${CLORE_API_KEY:-}" ] || [ -n "${SUPABASE_SECRET_KEY:-}" ] || [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "Forbidden secret detected in worker environment. Refusing to start."
  exit 1
fi

python3 /workspace/app/gpu-worker/worker.py
