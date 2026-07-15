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
