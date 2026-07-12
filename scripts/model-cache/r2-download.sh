#!/usr/bin/env bash
set -euo pipefail

MODE="--dry-run"
if [[ "${1:-}" == "--execute" ]]; then
  MODE="--execute"
fi

echo "R2 model cache download plan (${MODE})."
echo "Source: private Cloudflare R2 bucket/prefix from environment."
echo "Target: ${WAN_MODEL_DIR:-/workspace/models/Wan2.2-TI2V-5B}"
echo "This helper must receive read-only model-cache credentials on the GPU."

if [[ "${MODE}" != "--execute" ]]; then
  echo "Dry run only; no R2 request was made."
  exit 0
fi

echo "Execute mode is intentionally left for the real GPU session runbook."
exit 1
