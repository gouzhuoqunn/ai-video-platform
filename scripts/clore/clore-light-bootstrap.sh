#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-prepare}"
ARCHIVE="${2:-/workspace/runtime-overlay.tgz}"
RUNTIME_DIR=/workspace/runtime-overlay
COMFY_DIR=/workspace/ai-runtime/ComfyUI
VENV_DIR=/workspace/ai-runtime/venv
FIXED_IMAGE='ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime@sha256:187a7eb304075863dbd3f7a1b527530a06783ad8ea0fec5e51e2b9725d1bf137'
COMFY_COMMIT='da2608926eaf68fd532bba4e1ace3402c5d21399'

prepare_overlay() {
  mkdir -p "$RUNTIME_DIR" /workspace/ai-runtime /workspace/models /workspace/logs /workspace/comfy-user
  tar -xzf "$ARCHIVE" -C "$RUNTIME_DIR"
  find "$RUNTIME_DIR" -type f -name '*.sh' -exec sed -i 's/\r$//' {} +
  chmod 0755 "$RUNTIME_DIR/entrypoint.sh"
}

docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

prepare_native() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ffmpeg python3-venv python3-dev gcc libc6-dev ca-certificates curl
    rm -rf /var/lib/apt/lists/*
  fi
  if [ ! -d "$COMFY_DIR/.git" ]; then
    rm -rf "$COMFY_DIR"
    git clone --filter=blob:none https://github.com/comfyanonymous/ComfyUI.git "$COMFY_DIR"
  fi
  git -C "$COMFY_DIR" fetch --depth 1 origin "$COMFY_COMMIT"
  git -C "$COMFY_DIR" checkout --detach "$COMFY_COMMIT"
  python3 -m venv --system-site-packages "$VENV_DIR"
  "$VENV_DIR/bin/python" -m pip install --upgrade pip setuptools wheel
  if ! "$VENV_DIR/bin/python" -c 'import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)' >/dev/null 2>&1; then
    "$VENV_DIR/bin/python" -m pip install --index-url https://download.pytorch.org/whl/cu124 'torch==2.6.0' 'torchvision==0.21.0' 'torchaudio==2.6.0'
  fi
  "$VENV_DIR/bin/python" -m pip install -r "$COMFY_DIR/requirements.txt" -r "$RUNTIME_DIR/requirements.lock"
  printf 'native\n' > /workspace/ai-runtime/bootstrap-mode
}

prepare() {
  prepare_overlay
  if docker_available; then
    docker pull "$FIXED_IMAGE"
    printf 'docker\n' > /workspace/ai-runtime/bootstrap-mode
  else
    prepare_native
  fi
  cat /workspace/ai-runtime/bootstrap-mode
}

start_runtime() {
  local profile="${2:-ampere_image_gpu}"
  local mode
  mode="$(cat /workspace/ai-runtime/bootstrap-mode)"
  mkdir -p /workspace/logs
  if [ "$mode" = docker ]; then
    docker rm -f stage3m-comfy-runtime >/dev/null 2>&1 || true
    docker run -d --name stage3m-comfy-runtime --gpus all --network host \
      -v /workspace:/workspace \
      -v "$RUNTIME_DIR:/opt/comfy-runtime:ro" \
      -e COMFY_RUNTIME_MODE=gpu -e COMFY_NODE_PROFILE=production_minimal -e "COMFY_GPU_PROFILE=$profile" \
      -e COMFY_CONTROLLER_HOST=127.0.0.1 -e COMFY_RUNTIME_DIR=/opt/comfy-runtime \
      "$FIXED_IMAGE" /opt/comfy-runtime/entrypoint.sh >/workspace/ai-runtime/runtime-container-id
  else
    if [ -s /workspace/runtime-stage3m.pid ] && kill -0 "$(cat /workspace/runtime-stage3m.pid)" 2>/dev/null; then return 0; fi
    nohup env COMFY_RUNTIME_MODE=gpu COMFY_NODE_PROFILE=production_minimal "COMFY_GPU_PROFILE=$profile" \
      COMFY_CONTROLLER_HOST=127.0.0.1 COMFY_RUNTIME_DIR="$RUNTIME_DIR" COMFYUI_DIR="$COMFY_DIR" COMFY_PYTHON="$VENV_DIR/bin/python" \
      "$RUNTIME_DIR/entrypoint.sh" >/workspace/logs/runtime-stage3m.log 2>&1 </dev/null &
    echo $! >/workspace/runtime-stage3m.pid
  fi
}

stop_runtime() {
  if [ -f /workspace/ai-runtime/bootstrap-mode ] && [ "$(cat /workspace/ai-runtime/bootstrap-mode)" = docker ]; then
    docker rm -f stage3m-comfy-runtime >/dev/null 2>&1 || true
  elif [ -s /workspace/runtime-stage3m.pid ]; then
    kill -TERM "$(cat /workspace/runtime-stage3m.pid)" 2>/dev/null || true
  fi
  rm -f /workspace/runtime-stage3m.pid /workspace/flux-r2-manifest.json
}

case "$ACTION" in
  prepare) prepare ;;
  start) start_runtime "$@" ;;
  stop) stop_runtime ;;
  *) echo "usage: clore-light-bootstrap.sh prepare|start|stop" >&2; exit 64 ;;
esac
