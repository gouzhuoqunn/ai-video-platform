# First GPU Session

Status: this is a future runbook. This task did not rent a GPU, call real Clore `create_order`, SSH into a host, download Wan2.2, push a Docker image, create R2 resources, or deploy publicly.

## 2026-07-11 default-off execution chain update

The first-session execution chain now exists as guarded code and dry-run/mock tests, but real execution is still disabled by default.

- Web confirmation can now enter a guarded server-side create path only after nonce, exact server-and-price text, risk checkbox, queued-job check, loopback guard, and live Clore revalidation.
- `CLORE_ORDER_EXECUTION_ENABLED=false` remains the default and blocks real `create_order` before any Clore request.
- `npm run first-gpu-session:plan` prints the dry-run deployment plan for SSH-only worker upload, official Wan2.2 download/verification, one synthetic text job, upload, pause, cleanup, and stop.
- `npm run check:first-gpu-session` verifies execution guards, SSH safety, first-session dry-run behavior, lint, typecheck, build, and secret scan.
- See `docs/REAL_CLORE_EXECUTION.md`, `docs/FIRST_WAN22_DEPLOYMENT.md`, and `docs/EMERGENCY_GPU_SHUTDOWN.md`.

## 2026-07-11 local_lab web console update

The local_lab page can now show sanitized Clore candidates and prepare a protected order plan from the browser. This is still not a real first GPU session.

- The web flow requires selecting a host, generating a short-lived plan nonce, checking the risk box, and typing `确认租用 <server_id>`.
- `CLORE_ORDER_EXECUTION_ENABLED=false` remains the default.
- The current implementation still returns a protected refusal instead of calling `create_order`, even if the UI reaches the final confirmation button.
- Before any future real run, re-query the marketplace, verify billing on Clore's confirmation screen, keep SSH-only ports, and use only synthetic prompts.

## Before Starting

Run local checks:

```powershell
npm run check:cost-optimized-gpu
npm run check:clore-prep
npm run check:gpu-prep
npm run secret:scan
```

Confirm:

- Clore account, balance, API key, and SSH public key are ready on the local developer machine.
- `CLORE_API_KEY` stays only in `.secrets/clore.env`.
- GPU server will not receive `CLORE_API_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `.env.local`, R2 write credentials, or SSH private keys.
- GPU server receives only limited Worker credentials and optional read-only model cache credentials.

## Planning Commands

```powershell
npm run clore:find
npm run clore:wallet
npm run clore:create:dry
npm run clore:session:plan
```

Do not proceed if the candidate breaks the 0.70 USD/hour cap, lacks RTX 5090, is spot/interruptible, lacks enough RAM/CPU/disk/network/reliability, or requires exposing public inference ports.

## Future Real Entry

The current code still blocks real order execution. `clore:create:dry` is permanently dry-run and rejects `--execute`.

The separated future real entry must require explicit execute flags and project confirmation:

```powershell
npm run clore:create -- --execute --server-id=<server_id> --max-price=<price> --confirm-project=ai-video-platform-wan22
```

As of the latest live read-only check after price and VRAM normalization, server `95538` is the current qualified RTX 5090 dry-run candidate under the `0.70 USD/hour` cap.

Update after price/VRAM normalization: server `95538` is now a qualified dry-run candidate. Clore reports `14.99 USD/day`, which normalizes to about `0.624583 USD/hour`, and reports `gpuram=31` for an exact RTX 5090. The 31GB value is treated as API rounded/usable VRAM under the RTX 5090-specific rule, not as a global memory threshold reduction.

Before real create, the user still must confirm server `95538`, the maximum hourly price `0.70`, and the Clore order confirmation screen, especially because minimum billing duration and platform total price are not confirmed by the API summary.

After a real order exists, start the worker through the Clore deployment runbook, restore the model cache, run one synthetic prompt, sync results locally, and stop the session when idle for more than 15 minutes.

Do not open ComfyUI, Jupyter, Gradio, or public HTTP inference ports.

Do not configure R2 before the first real GPU session. First prove Wan2.2 runs on the selected 5090, measure official model download time, model size, and first generation time, then decide whether R2 cache is worth adding.

## 2026-07-12 First-session Gate Status

The user authorized real test-phase execution, but the automated safety gates did not allow moving to real rental in this environment.

Completed without spending balance:

- Live Clore marketplace read-only query.
- Wallet read-only query.
- Active order read-only query.
- Dry-run order plan regeneration.
- Execution guard, SSH guard, first-session plan, local_lab, GPU prep, build, and secret scan tests.

Blocked before real order creation:

- No `wrangler` CLI was available for Cloudflare R2 setup.
- No R2 model cache env files were present.
- No `docker` CLI was available for building and pushing the runtime image.
- No `gh` CLI was available for GHCR publishing.
- The guarded create path refuses real rental while the custom public runtime image and R2 model cache are missing.

Current candidate guidance:

- Cheapest current qualified candidate: server `107713` at `0.291667 USD/hour`.
- Server `95538` is still qualified at `0.624583 USD/hour`.
- The user must choose the exact server and maximum hourly price immediately before real rental, because marketplace availability can change quickly.

Real first-session command, only after the blockers above are resolved and a queued synthetic job exists:

```powershell
npm run clore:create -- --execute --server-id=<server_id> --max-price=<price> --confirm-project=ai-video-platform-wan22 --queued-jobs=<count>
```

After a real order is created, keep only SSH open, verify hardware immediately, deploy the limited worker, process exactly one synthetic prompt, upload the result, inspect it locally, and cancel/stop the order when done.
