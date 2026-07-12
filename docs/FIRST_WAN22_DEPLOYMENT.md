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

Forbidden uploads include `.env.local`, `.secrets/clore.env`, Supabase Secret keys, Clore API keys, R2 write credentials, SSH private keys, videos, sessions, and signed URLs.

## Expected Steps

1. Verify RTX 5090 with `nvidia-smi`.
2. Verify CUDA, PyTorch, Python, ffmpeg, git, disk, and RAM.
3. Install runtime dependencies.
4. Download `Wan-AI/Wan2.2-TI2V-5B` on the rented GPU only.
5. Generate and validate a model manifest.
6. Start the limited `gpu_worker`.
7. Process one synthetic text job.
8. Upload final video to private Supabase Storage through the limited Worker account.
9. Sync or view the result in local_lab.
10. Pause for inspection before any further jobs.

## Commands

```powershell
npm run first-gpu-session:plan
npm run first-gpu-session:test
npm run check:first-gpu-session
```

The plan command prints a dry-run structure. It does not connect SSH, start a worker, or download the model.
