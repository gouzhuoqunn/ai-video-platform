#!/usr/bin/env bash
set -euo pipefail

export HF_HUB_DISABLE_TELEMETRY=1
export DO_NOT_TRACK=1

python /app/worker.py
