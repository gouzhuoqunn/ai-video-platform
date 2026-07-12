#!/usr/bin/env bash
set -euo pipefail

MODE="--dry-run"
if [[ "${1:-}" == "--execute" ]]; then
  MODE="--execute"
fi

echo "R2 model cache upload plan (${MODE})."
echo "Source: ${WAN_MODEL_DIR:-/workspace/models/Wan2.2-TI2V-5B}"
echo "Target: private Cloudflare R2 bucket/prefix from local developer environment."
echo "Write credentials must stay on the local developer machine, never on the GPU."

if [[ "${MODE}" != "--execute" ]]; then
  echo "Dry run only; no R2 request was made."
  exit 0
fi

echo "Execute mode is intentionally left for the local cache publication runbook."
exit 1
