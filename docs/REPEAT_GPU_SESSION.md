# Repeat GPU Session

Status: this is a future runbook for later sessions. No real GPU was rented in this task.

## Repeat Flow

1. Run prep checks.
2. Query Clore marketplace and wallet in read-only mode.
3. Create a dry-run session plan.
4. Start a real order only after explicit user confirmation in a future task.
5. Restore model from local instance cache, Clore volume, R2, or Hugging Face in that order.
6. Process queued local-lab jobs in a batch.
7. Upload generated videos to private Supabase Storage.
8. Sync completed results to `D:\AI-Video-Library`.
9. Drain at 5h30m.
10. Stop when no more tasks are expected within 15 minutes.
11. Cleanup/cancel only when no task is processing.

## Commands

```powershell
npm run cost:plan
npm run model-cache:plan
npm run clore:session:plan
npm run clore:session:dry
npm run clore:session:status
npm run results:sync
npm run results:check
npm run results:cleanup:dry
```

## Boundaries

- No automatic order from a single queued job.
- No public deployment.
- No public inference ports.
- No real user material in first tests.
- No R2 write credentials on GPU.
- No Supabase Secret key on GPU.
- No Clore API key on GPU.
