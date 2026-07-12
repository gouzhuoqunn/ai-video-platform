#!/usr/bin/env bash
set -euo pipefail

if command -v pkill >/dev/null 2>&1; then
  pkill -f "/workspace/app/gpu-worker/worker.py" || true
fi

echo "Worker stop requested. Check process list and Clore order status before assuming billing has stopped."
