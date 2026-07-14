#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace/models /workspace/comfy-input /workspace/comfy-output /workspace/comfy-user /workspace/logs /workspace/r2-cache /workspace/workflows

COMFYUI_HOST="${COMFYUI_HOST:-127.0.0.1}"
COMFYUI_PORT="${COMFYUI_PORT:-8188}"
COMFY_CONTROLLER_HOST="${COMFY_CONTROLLER_HOST:-127.0.0.1}"
COMFY_CONTROLLER_PORT="${COMFY_CONTROLLER_PORT:-8080}"

if [ "${START_GPU_WORKER:-false}" = "true" ]; then
  echo "START_GPU_WORKER must stay false for the ComfyUI runtime" >&2
  exit 1
fi

redact_env() {
  env | sed -E 's/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SIGNED_URL)=.*/\1=[redacted]/g'
}

stop_children() {
  if [ -n "${CONTROLLER_PID:-}" ]; then
    kill "${CONTROLLER_PID}" >/dev/null 2>&1 || true
  fi
  if [ -n "${COMFY_PID:-}" ]; then
    kill "${COMFY_PID}" >/dev/null 2>&1 || true
    wait "${COMFY_PID}" >/dev/null 2>&1 || true
  fi
}
trap stop_children TERM INT EXIT

echo "starting ComfyUI runtime at commit ${COMFYUI_COMMIT}" | tee /workspace/logs/comfy-runtime.log
redact_env >/workspace/logs/environment-redacted.log

cd /opt/ComfyUI
read -r -a COMFYUI_EXTRA_ARGS_ARRAY <<< "${COMFYUI_EXTRA_ARGS:-}"
python3.11 main.py \
  --listen "${COMFYUI_HOST}" \
  --port "${COMFYUI_PORT}" \
  --input-directory /workspace/comfy-input \
  --output-directory /workspace/comfy-output \
  --user-directory /workspace/comfy-user \
  --models-directory /workspace/models \
  --disable-auto-launch \
  --dont-print-server \
  "${COMFYUI_EXTRA_ARGS_ARRAY[@]}" \
  >>/workspace/logs/comfyui.log 2>&1 &
COMFY_PID="$!"

python3.11 /opt/comfy-runtime/controller.py \
  --host "${COMFY_CONTROLLER_HOST}" \
  --port "${COMFY_CONTROLLER_PORT}" \
  --comfy-host "${COMFYUI_HOST}" \
  --comfy-port "${COMFYUI_PORT}" \
  >>/workspace/logs/controller.log 2>&1 &
CONTROLLER_PID="$!"

wait -n "${COMFY_PID}" "${CONTROLLER_PID}"
