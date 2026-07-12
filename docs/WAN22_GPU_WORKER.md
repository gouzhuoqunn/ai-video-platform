# Wan2.2 GPU Worker Deployment Prep

## 2026-07-11 first deployment dry-run chain

- Added dry-run first-session planning for deploying the limited GPU Worker over SSH, verifying RTX 5090/CUDA/PyTorch/disk/RAM, downloading `Wan-AI/Wan2.2-TI2V-5B` on the rented GPU only, validating a manifest, starting the Worker, processing one synthetic text job, uploading the video, and pausing for inspection.
- The deployment whitelist allows only Worker code, bootstrap/start/cleanup scripts, and `.secrets/gpu-worker.env`.
- Forbidden uploads include `.env.local`, `.secrets/clore.env`, Clore API keys, Supabase Secret keys, R2 write credentials, SSH private keys, sessions, signed URLs, prompts, and videos.
- Added `npm run first-gpu-session:plan`, `npm run first-gpu-session:test`, and `docs/FIRST_WAN22_DEPLOYMENT.md`.
- This checkpoint did not connect SSH, start a real Worker, download Wan2.2, rent a GPU, or call real Clore order APIs.

## 2026-07-11 cost-optimized runtime update

- Runtime image remains dependency-only: CUDA 12.8, Python 3.11, PyTorch 2.7.1 cu128, ffmpeg, git, rclone, `huggingface_hub`, Supabase client, Worker startup, and healthcheck dependencies.
- Wan2.2 weights must not be baked into the image. The image plan is `ghcr.io/<user>/wan22-runtime:<immutable-version>`, but this checkpoint did not push any image.
- Model cache order is current Clore local dir, optional Clore persistent volume, private R2 cache, then official Hugging Face fallback.
- Fixed model: `Wan-AI/Wan2.2-TI2V-5B`; expected official size budget: 34.2GB; GPU disk reservation: at least 200GB.
- The limited `gpu_worker` private upload path remains verified after migrations 0005, 0006, and 0007 were manually executed by the user.
- GPU servers still do not need Supabase Secret keys or Clore API keys. They only need limited Worker credentials and optional read-only model cache credentials.
- This checkpoint did not rent a GPU, connect a real GPU, download Wan2.2, create R2 resources, or deploy publicly.

## 2026-07-11 live Clore readiness update

- Real Clore wallet, marketplace, and order-status read-only checks succeeded.
- Current active orders: none.
- Current qualified RTX 5090 candidates under the project filters: 0.
- Closest rejected candidate is server `95538`, rejected because Clore reports 31GB GPU memory and 14.99 USD/hour.
- `clore:create:dry` remains dry-run only and rejects `--execute`.
- Future real create entry is separated as `npm run clore:create -- --execute --server-id=<id> --max-price=<price> --confirm-project=ai-video-platform-wan22`, but this checkpoint still refuses to call `create_order`.
- First real Worker session should use synthetic prompts only and official Hugging Face model source. R2 cache should wait until after a successful first video.

Current status: the limited `gpu_worker` Supabase pipeline is verified, but no GPU has been rented, no real GPU has been connected, no Wan2.2 weights have been downloaded, and nothing has been deployed publicly.

The temporary priority is local single-user lab mode. The page submits `standard-video` tasks displayed as Wan2.2 TI2V-5B, and those tasks stay queued until a Clore GPU Worker is intentionally started.

## Supabase Status

- `0005_limited_gpu_worker_role.sql` has been manually executed by the user.
- `0006_gpu_worker_storage_insert_grant.sql` has been manually executed by the user.
- `0007_gpu_worker_storage_policy_rls_fix.sql` has been manually executed by the user.
- `npm run verify:remote` passes: `generated-videos` remains private, ordinary users cannot upload, and `gpu_worker` can upload only owned `output.mp4` or `output.webm` for the claimed processing job.
- `npm run test:gpu-worker-role` passes: charge, claim, heartbeat, Python mock render, private upload, `complete_video_job`, signed URL access, cross-user denial, credit isolation, and failure refund are verified.

## Worker Identity

Real GPU servers must not hold:

- `SUPABASE_SECRET_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- database passwords
- `CLORE_API_KEY`
- legacy Vast API keys

Real GPU servers should load only limited Worker runtime credentials:

```env
SUPABASE_URL=""
SUPABASE_PUBLISHABLE_KEY=""
GPU_WORKER_EMAIL=""
GPU_WORKER_PASSWORD=""
GPU_WORKER_USER_ID=""
WAN_RUNNER="mock"
```

Use `WAN_RUNNER="real"` only on the real GPU machine after the model is mounted.

## Verified Storage Rule

The Worker can upload only:

```text
user_id/job_id/output.mp4
user_id/job_id/output.webm
```

The job must be `processing`, and `video_jobs.worker_id` must equal the current Worker Auth user id. The Worker cannot upload other paths, upload non-mp4/webm objects, delete generated videos, read unrelated user objects, modify credit balances, or write credit transactions.

## Wan2.2 Model Plan

- Model: `Wan-AI/Wan2.2-TI2V-5B`
- Model directory: `/workspace/models/Wan2.2-TI2V-5B`
- Job output directory: `/workspace/jobs/{job_id}/output.mp4`
- Do not bake model weights into the Docker image.
- Do not download weights on the local lightweight laptop.
- Do not expose ComfyUI, Jupyter, Gradio, or public inference ports.

Default planned runtime settings:

```env
WAN_WIDTH="1280"
WAN_HEIGHT="704"
WAN_NUM_FRAMES="120"
WAN_INFERENCE_STEPS="30"
WAN_GUIDANCE_SCALE="5"
WAN_CPU_OFFLOAD="true"
```

## Clore Rental Preparation

Clore.ai is now the only primary GPU rental platform. The user has about 11 USD in Clore balance, `CLORE_API_KEY` is configured only in `.secrets/clore.env`, and read-only wallet/marketplace/status queries have been verified. No order has been created.

Current real read-only result:

- Wallet summary: `USD-Blockchain: 10.99`.
- Active orders: none.
- Compliant RTX 5090 candidates: none under `CLORE_MAX_GPU_PRICE_PER_HOUR=0.70` and the 6 hour rental planning window.
- Closest strong rejected candidate: server `95538`, RTX 5090, API-reported GPU memory 31GB, 9.90 USD/hour, 59.40 USD for 6 hours. It fails the 32GB GPU-memory rule and price/balance rule.

Use only on-demand RTX 5090 candidates. Do not use spot, do not fall back to RTX 4090, and do not upload real user photos for the first test. The Clore host is third-party P2P infrastructure, so the GPU receives only limited `gpu_worker` credentials and never Supabase Secret keys or Clore API keys.

Detailed commands and risk rules are in `docs/CLORE_DEPLOYMENT.md`.

## Verification Commands

```powershell
npm run gpu-worker:test
npm run clore:test
npm run clore:find:mock
npm run clore:wallet
npm run clore:status
npm run clore:create:dry
npm run check:clore-prep
npm run verify:remote
npm run test:gpu-worker-role
npm run check:gpu-prep
```

As of this checkpoint, no real GPU rental, model download, SSH connection, or public deployment has happened. The next human decision is whether to wait for cheaper compliant RTX 5090 capacity or explicitly approve a higher hourly/6 hour budget before any real order path is considered.
