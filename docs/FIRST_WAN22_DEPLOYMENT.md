# First Wan2.2 Deployment

Status: dry-run plan only. No real GPU host was contacted and no Wan2.2 weights were downloaded.

## First Session Rules

- Use only `Wan-AI/Wan2.2-TI2V-5B`.
- Use only synthetic text prompts for the first real run.
- Process at most one synthetic job, then pause for human video inspection.
- Use official Hugging Face fallback for the first measurement unless a verified model cache already exists on the rented host.
- Record timing and resource metrics, but do not log full prompts, signed URLs, credentials, or local file paths.

## Deployment Shape

The dry-run deployment plan uploads only:

- `gpu-worker/config.py`
- `gpu-worker/healthcheck.py`
- `gpu-worker/security.py`
- `gpu-worker/wan_runner.py`
- `gpu-worker/worker.py`
- `gpu-worker/requirements.txt`
- `scripts/clore/bootstrap-worker.sh`
- `scripts/clore/start-worker.sh`
- `scripts/clore/cleanup-worker.sh`
- `.secrets/gpu-worker.env`
- `.secrets/model-cache-readonly.env`

Forbidden uploads include `.env.local`, `.secrets/clore.env`, Supabase Secret keys, Clore API keys, R2 write credentials, SSH private keys, videos, sessions, and signed URLs.

## Expected Steps

1. Verify RTX 5090 with `nvidia-smi`.
2. Verify CUDA, PyTorch, Python, ffmpeg, git, disk, and RAM.
3. Install runtime dependencies.
4. Download `Wan-AI/Wan2.2-TI2V-5B` on the rented GPU only.
5. Generate and validate a model manifest.
6. Seed the private R2 cache through local-controller signed upload URLs.
7. Publish `wan22-ti2v-5b/current.json` only after all files verify.
8. Start the limited `gpu_worker`.
9. Process one synthetic text job.
10. Upload final video to private Supabase Storage through the limited Worker account.
11. Sync or view the result in local_lab.
12. Pause for inspection before any further jobs.

## Commands

```powershell
npm run first-gpu-session:plan
npm run first-gpu-session:test
npm run check:first-gpu-session
```

The plan command prints a dry-run structure. It does not connect SSH, start a worker, or download the model.

## Cache Seed Safety Gate

Before any future real create command is allowed, run:

```powershell
npm run model-cache:seed:test
```

This validates manifest rules, object key layout, short-lived presigned PUT, multipart planning, publish-last `current.json`, readonly restore credentials, and cleanup of tiny `_seed-test` objects. It still does not download Wan2.2, upload model weights, create a Clore order, or connect SSH.

## 2026-07-13 First Test Lockdown

- First-session Worker mode uses `FIRST_SESSION_MAX_CLAIMS=1`; the count increments immediately after a successful claim, so a failed first job still stops further claims.
- The safe first prompt is a synthetic text-only red paper boat scene with no people and no text.
- Wan code is pinned to commit `42bf4cfaa384bc21833865abc2f9e6c0e67233dc`.
- Hugging Face model revision is pinned to `921dbaf3f1674a56f47e83fb80a34bac8a8f203e`.
- Anonymous Hugging Face metadata/HEAD checks must not download weights and must not require an HF token when the public model endpoint is reachable.
- Current local network cannot reach Hugging Face reliably; this must be checked again before the first real session.
- Real create remains blocked until the remote Cloudflare Cron watchdog is active and healthy.
