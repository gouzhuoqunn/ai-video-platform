#!/usr/bin/env bash
set -euo pipefail

echo "Clore worker bootstrap starting."
echo "This script assumes an intentionally rented SSH-only host."

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi is missing. Stop before starting the worker."
  exit 1
fi

nvidia-smi
expected_gpu_class="${GPU_WORKER_EXPECTED_GPU_CLASS:-rtx5090}"
case "$expected_gpu_class" in
  rtx4090) expected_gpu_pattern="RTX 4090|GeForce RTX 4090"; minimum_vram_mib="${GPU_WORKER_MIN_VRAM_MIB:-23000}" ;;
  rtx5090) expected_gpu_pattern="RTX 5090|GeForce RTX 5090"; minimum_vram_mib="${GPU_WORKER_MIN_VRAM_MIB:-32000}" ;;
  *) echo "Unsupported GPU worker profile: $expected_gpu_class"; exit 1 ;;
esac
if ! nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | grep -E "$expected_gpu_pattern" >/dev/null 2>&1; then
  echo "Expected $expected_gpu_class was not detected. Refusing to continue."
  exit 1
fi

gpu_mem_mib="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n 1 | tr -d ' ')"
if [ "${gpu_mem_mib:-0}" -lt "$minimum_vram_mib" ]; then
  echo "GPU memory is below the required $expected_gpu_class profile minimum. Refusing to continue."
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

if [ "${GPU_WORKER_EXECUTION_MODE:-generic}" = "immutable_batch" ] && { [ -z "${GPU_WORKER_BATCH_ID:-}" ] || [ "${GPU_WORKER_EXPECTED_MODEL_KEY:-}" != "video_wan_silent" ] || [ "$expected_gpu_class" != "rtx4090" ]; }; then
  echo "Invalid immutable batch worker configuration."
  exit 1
fi
mkdir -p /workspace/jobs /workspace/models/Wan2.2-TI2V-5B
if [ ! -d "/workspace/models/Wan2.2-TI2V-5B/.git" ]; then
  echo "Wan2.2 model code/weights are not present. The future execute step should download Wan-AI/Wan2.2-TI2V-5B here, not A14B."
fi

echo "Bootstrap complete. Start the worker with scripts/clore/start-worker.sh after reviewing GPU, RAM, disk, and CUDA compatibility."
