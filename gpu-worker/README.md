# Wan2.2 GPU Worker

This worker is for a future private GPU host. It does not need a Supabase Secret key.

## Security Model

- The GPU host stores only `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `GPU_WORKER_EMAIL`, and `GPU_WORKER_PASSWORD`.
- The worker signs in as a normal Supabase Auth user.
- The database must have `app_metadata.role = gpu_worker` on that user.
- `0005_limited_gpu_worker_role.sql` makes Worker RPCs check that JWT role before allowing claim, heartbeat, complete, fail, or stale requeue calls.
- The worker never receives `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`.

## Local Mock Mode

Local mode uses `WAN_RUNNER=mock` and writes a placeholder `output.mp4`. It is for Python logic tests only and does not run Wan2.2.

## Real Mode

Real mode uses:

- Model: `Wan-AI/Wan2.2-TI2V-5B`
- Model directory: `/workspace/models/Wan2.2-TI2V-5B`
- Job output: `/workspace/jobs/{job_id}/output.mp4`
- Default size: `1280x704`
- Frames: `120` for 5 seconds at 24fps

Do not bake model weights into the image. Mount a persistent disk at `/workspace/models` and keep job scratch data under `/workspace/jobs`.

## Required Environment

```env
SUPABASE_URL=""
SUPABASE_PUBLISHABLE_KEY=""
GPU_WORKER_EMAIL=""
GPU_WORKER_PASSWORD=""
GPU_WORKER_USER_ID=""
WAN_RUNNER="mock"
WAN_MODEL_DIR="/workspace/models/Wan2.2-TI2V-5B"
WAN_OUTPUT_DIR="/workspace/jobs"
WAN_WIDTH="1280"
WAN_HEIGHT="704"
WAN_NUM_FRAMES="120"
WAN_INFERENCE_STEPS="30"
WAN_GUIDANCE_SCALE="5"
WAN_SEED="42"
WAN_CPU_OFFLOAD="true"
WORKER_POLL_INTERVAL_SECONDS="8"
WORKER_LEASE_SECONDS="300"
```

Set `WAN_RUNNER=real` only on the GPU machine after the model is mounted.
