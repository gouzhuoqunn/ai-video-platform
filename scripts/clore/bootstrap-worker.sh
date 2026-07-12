#!/usr/bin/env bash
set -euo pipefail

echo "Clore worker bootstrap starting."
echo "This script assumes an intentionally rented SSH-only host."

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi is missing. Stop before starting the worker."
  exit 1
fi

nvidia-smi
if ! nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | grep -E "RTX 5090|GeForce RTX 5090" >/dev/null 2>&1; then
  echo "RTX 5090 was not detected. Refusing to continue."
  exit 1
fi

gpu_mem_mib="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n 1 | tr -d ' ')"
if [ "${gpu_mem_mib:-0}" -lt 32000 ]; then
  echo "GPU memory is below 32GB. Refusing to continue."
  exit 1
fi

python3 --version
ram_gb="$(awk '/MemTotal/ { printf \"%d\", $2 / 1024 / 1024 }' /proc/meminfo)"
if [ "${ram_gb:-0}" -lt 64 ]; then
  echo "System RAM is below 64GB. Refusing to continue."
  exit 1
fi

disk_gb="$(df -BG /workspace | awk 'NR==2 { gsub(\"G\", \"\", $4); print $4 }')"
if [ "${disk_gb:-0}" -lt 200 ]; then
  echo "Free /workspace disk is below 200GB. Refusing to continue."
  exit 1
fi

if [ ! -f "/workspace/gpu-worker.env" ]; then
  echo "Missing /workspace/gpu-worker.env. Upload only .secrets/gpu-worker.env from the local machine."
  exit 1
fi

mkdir -p /workspace/jobs /workspace/models/Wan2.2-TI2V-5B
if [ ! -d "/workspace/models/Wan2.2-TI2V-5B/.git" ]; then
  echo "Wan2.2 model code/weights are not present. The future execute step should download Wan-AI/Wan2.2-TI2V-5B here, not A14B."
fi

echo "Bootstrap complete. Start the worker with scripts/clore/start-worker.sh after reviewing GPU, RAM, disk, and CUDA compatibility."
