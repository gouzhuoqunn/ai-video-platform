#!/usr/bin/env bash
set -euo pipefail

export HF_HUB_DISABLE_TELEMETRY=1
export DO_NOT_TRACK=1

mkdir -p /workspace/ai-video-platform /workspace/models /workspace/jobs /workspace/logs

if [ "$#" -gt 0 ]; then
  bash -lc "$*"
fi

has_worker_env() {
  [ -n "${SUPABASE_URL:-}" ] &&
    [ -n "${SUPABASE_PUBLISHABLE_KEY:-}" ] &&
    [ -n "${GPU_WORKER_EMAIL:-}" ] &&
    [ -n "${GPU_WORKER_PASSWORD:-}" ]
}

case "${START_GPU_WORKER:-}" in
  1|true|TRUE|yes|YES|on|ON)
    exec python3.11 /app/worker.py
    ;;
esac

if has_worker_env; then
  exec python3.11 /app/worker.py
fi

echo "GPU worker runtime is ready for SSH/bootstrap; worker autostart is disabled until credentials are provided."
exec tail -f /dev/null
