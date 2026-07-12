# Emergency GPU Shutdown

Status: runbook for a future real Clore order. The current project has no active real Clore order.

## First Checks

1. Stop submitting new prompts.
2. Check the local active order state:

```powershell
npm run clore:status
```

3. Confirm whether any job is still `processing` or any video upload is in progress.
4. Do not cancel while a final upload is still running unless the user explicitly accepts losing that output.

## Safe Stop Order

Preferred order:

1. Let the current job finish or fail cleanly.
2. Verify the final video is uploaded to private Supabase Storage.
3. Sync or view the local result.
4. Run worker cleanup on the GPU.
5. Run Clore cancel only for the project active order.
6. Recheck order status and wallet balance.

## Dry-Run Commands

```powershell
npm run clore:cancel:dry
npm run clore:session:stop:dry
```

## Future Real Cancel Shape

Real cancel remains disabled unless `CLORE_ORDER_EXECUTION_ENABLED=true` is intentionally set in a future approved task.

```powershell
npm run clore:cancel -- --execute --order-id=<order_id> --processing-jobs=0 --uploading=false --final-video-uploaded=true --issue="project session complete"
```

The command must refuse to cancel if:

- the order id does not match `.secrets/clore-active-order.json`;
- the active order does not have project tag `ai-video-platform-wan22`;
- a job is processing;
- an upload is in progress;
- the final video has not been verified.

## Never Do

- Do not delete Supabase final videos during emergency shutdown.
- Do not upload `.env.local`, `.secrets/clore.env`, Supabase Secret keys, Clore API key, R2 write credentials, or SSH private keys to the GPU.
- Do not open Jupyter, ComfyUI, Gradio, or public inference ports.
