# First-image Recovery

```powershell
npm run gpu:first-image -- --provider=clore
npm run gpu:first-image -- --provider=manual_ssh
npm run first-image:resume
```

`manual_ssh` reads `.secrets/manual-gpu-target.json`. It may inspect hardware, pull the pinned Runtime, restore models, generate the first image, sync results, and stop Runtime. It never rents or cancels a provider order.

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

## FLUX R2 Restore Status

The three locked FLUX first-image files are published under revision `flux2-klein-4b-5b4408e59397-a9e4ca87c16d`. GitHub Actions run `29431562820` verified all object sizes and SHA256 values, the publish-last pointer, read-only first/last ranges, and denied write operations.

`npm run first-image:preflight` returns `r2_restore_plan_valid=true` with a total of 12,451,817,860 bytes. A future SSH GPU can restore all three files from R2 first and use the pinned Hugging Face URLs only after an R2 failure. This is restore readiness only; no GPU inference or first image has been verified.
