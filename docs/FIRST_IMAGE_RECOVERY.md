
# First-image Recovery

```powershell
npm run gpu:first-image -- --provider=clore
npm run gpu:first-image -- --provider=runpod
npm run gpu:first-image -- --provider=manual_ssh
npm run gpu:doctor
npm run gpu:candidates -- --provider=runpod
npm run first-image:resume
```

`manual_ssh` reads `.secrets/manual-gpu-target.json`. It may inspect hardware, pull the pinned Runtime, restore models, generate the first image, sync results, and stop Runtime. It never rents or cancels a provider order.

`runpod` reads `RUNPOD_API_KEY`, `RUNPOD_MAX_GPU_HOURLY_USD`, `RUNPOD_MAX_TOTAL_HOURLY_USD`, and `RUNPOD_MAX_SESSION_USD` only from process environment or ignored `.secrets/runpod.env`. The legacy `RUNPOD_MAX_HOURLY_USD` remains a compute-only fallback. Without a key, commands stay dry-run and do not create a Pod. Real execution uses the private `ai-video-first-image-direct-v1` template with the immutable Comfy Runtime digest. The template overrides the Runtime entrypoint with a root-only OpenSSH bootstrap, exposes only `22/tcp` and `8080/http`, mounts `/workspace`, and waits for the local executor to start Runtime over SSH.

RunPod pricing is recorded as `computeHourly`, `storageHourly`, `totalHourly`, and `projectedSessionTotal`. Running container and volume disks use the official `0.10 USD/GB/month` estimate. Compute must be at most `0.70`, total hourly at most `0.75`, and the 3.5-hour projection at most `2.50`; the Watchdog keeps `2.50` as the final spend cap and 150 minutes as the time cap. `adjustedCostPerHr` takes precedence when present. Missing, NaN, or negative price components fail closed.

Creation requests use `gpuTypePriority=custom` with exactly one `gpuTypeId`. Read-only stock checks run in this order: A40, A6000, RTX 3090, L4, RTX 4090, A5000, RTX 3090 Ti. Secure candidates are listed first; Community candidates are an explicit fallback and still require `supportPublicIp=true`. Use `npm run runpod:candidate:watch` for a read-only 2-minute/20-minute watch, or add `-- --execute` only in a fresh authorized attempt budget.

RunPod may omit `isPublic=false`, `isServerless=false`, and price fields from create responses. Template validation rejects either boolean only when explicitly `true`. A newly created Pod must report compute price plus container and volume sizes within 10 seconds and pass all three budget gates; otherwise it is deleted before SSH or model restoration.

The ignored checkpoint state advances in this order:

```text
candidate_selected
order_created
ssh_ready
hardware_verified
runtime_ready
models_restored
prompt_submitted
image_generated
result_synced
session_stopped
order_cancelled
```

Resume starts at the first incomplete stage and must not repeat verified model restoration, image generation, or result sync. Model restore checks `production/rtx4090/image/current.json` and its revision manifest before using the pinned Hugging Face fallback.

GPU-side R2 restore accepts only a two-hour presigned GET bundle. It resumes `.part` files with HTTP Range requests, downloads at concurrency two, validates full size and SHA256, and atomically renames each model. R2 administrator credentials never enter the GPU target.

Emergency Colab preparation is separate from Provider rental:

```powershell
npm run first-image:colab:bundle
npm run first-image:colab:validate
```

The ignored bundle is written to `.secrets/flux-first-image-colab-bundle.json`. `notebooks/flux-first-image-colab.ipynb` uses the fixed ComfyUI commit and never embeds a long-lived R2 credential, SSH key, or provider API key.

## FLUX R2 Restore Status

The three locked FLUX first-image files are published under revision `flux2-klein-4b-5b4408e59397-a9e4ca87c16d`. GitHub Actions run `29431562820` verified all object sizes and SHA256 values, the publish-last pointer, read-only first/last ranges, and denied write operations.

`npm run first-image:preflight` returns `r2_restore_plan_valid=true` with a total of 12,451,817,860 bytes. A future SSH GPU can restore all three files from R2 first and use the pinned Hugging Face URLs only after an R2 failure. This is restore readiness only; no GPU inference or first image has been verified.

