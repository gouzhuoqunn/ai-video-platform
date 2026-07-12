# Cost Optimized GPU Architecture

Status: prepared in code, tests, and docs only. No Clore order was created, no GPU was rented, no Wan2.2 weights were downloaded, no R2 bucket was created, and nothing was deployed publicly.

## 2026-07-11 guarded execution checkpoint

- Added a default-off real execution chain with create/cancel helpers, active-order state, duplicate-create lock, live preflight checks, SSH-only order body, and mock tests.
- First-session limits are now explicit: 4.50 USD max planning budget, 1.00 USD reserve, 0.70 USD/hour cap, 380 minute hard session limit, 15 minute order boot timeout, and 120 minute Worker-ready timeout.
- local_lab order confirmation shows these limits and still relies on server-side checks; no browser `NEXT_PUBLIC_CLORE_*` state is used for secrets or authorization.
- `check:first-gpu-session` is the new focused validation command for this path.
- The session remains user-triggered only; queued jobs never auto-rent a GPU.

## 2026-07-11 local creation studio integration

- The cost-optimized session model is now visible in the local_lab web UI through a right-side Clore/session panel.
- Users can batch prompts first, then explicitly prepare a GPU session plan. Queued jobs do not automatically rent a GPU.
- The UI shows the normalized hourly price, original price unit, six-hour budget, wallet balance, and "API not confirmed" billing notes when Clore does not expose a minimum billing field.
- Session stop from the page remains dry-run and does not call `cancel_order`.
- Real order execution remains blocked; this checkpoint is UI/API/dry-run protection only.

## Goal

The project is now optimized for a single user, low frequency generation, and GPU work sessions of at most about 6 hours. The design avoids always-on GPU cost and batches work only when the user explicitly starts a session.

## Cache Priority

The Wan2.2 model is fixed to:

```text
Wan-AI/Wan2.2-TI2V-5B
```

Cache lookup order:

1. Current Clore instance local model directory.
2. Mountable Clore persistent volume, only if Clore supports it for the selected order.
3. Private Cloudflare R2 model cache.
4. Official Hugging Face repository fallback.

The official model size budget is 34.2GB. The GPU disk reservation remains at least 200GB:

- 70GB for model files and temporary restore space.
- 30GB for Docker/Python/runtime environment.
- 50GB for jobs and video temporary files.
- 50GB safety margin.

Model weights must never be baked into the Docker image.

## Runtime Image

The runtime image is a general Wan2.2 worker environment:

- CUDA 12.8 compatible base.
- Python 3.11.
- PyTorch 2.7.1 cu128.
- ffmpeg, git, rclone, `huggingface_hub`, Supabase client, and worker healthcheck dependencies.
- No model weights, prompts, videos, `.env.local`, `.secrets`, passwords, tokens, or API keys.

Runtime image built by GitHub Actions:

```text
ghcr.io/gouzhuoqunn/wan22-runtime:v0.1.0-pre-gpu
ghcr.io/gouzhuoqunn/wan22-runtime@sha256:fd03ef72d7369f59b3af9e535d9f6a75add9430a5c1ef4e7fd5853be0e4c060a
```

The package is still private at this checkpoint. Clore cannot pull it until the GHCR package visibility is changed to Public. The source repository can remain private.

## Session Cost Model

Defaults:

- GPU price cap: 0.70 USD/hour.
- Planned session: 6 hours.
- Cold start: 60 minutes.
- Target warm restore: 15 minutes.
- Hard session safety plan: 380 minutes.
- Monthly sessions: 2.
- Clore balance planning assumption: 11 USD.
- Emergency reserve: 1 USD.

At 0.70 USD/hour, one full 6 hour session costs 4.20 USD. With 11 USD balance and a 1 USD reserve, the plan supports 2 full sessions.

Idle rule: keep the GPU running only if another task is expected within 15 minutes. Otherwise shut down after results are uploaded and verified.

Persistent volume rule:

```text
volume_extra_monthly_cost <= sessions_per_month * minutes_saved_per_session / 60 * gpu_price_per_hour
```

With defaults of 2 sessions/month, 10 minutes saved/session, and 0.70 USD/hour, acceptable extra volume cost is about 0.23 USD/month. If Clore does not support cross-order persistent volumes, use R2 instead and do not block deployment.

## Latest Live Clore Read-only Result

- Wallet USD-like balance: 10.99.
- Planning budget after 1 USD reserve: 9.99.
- Active orders: none.
- Qualified RTX 5090 candidates under the current hard filters: 0.
- Closest rejected candidate: server `95538`, RTX 5090, 31GB API-reported GPU memory, 14.99 USD/hour, 89.94 USD for 6 hours.
- The current cap of 0.70 USD/hour would support about 14.27 hours after reserve, but no current real candidate is near that price.
- Minimum billing duration is not confirmed by the live marketplace fields used in the sanitized summaries; verify on Clore before any future real create.

R2 remains deferred until after the first successful real GPU video. The first session should use the official Hugging Face fallback to measure real model download time, actual model size, and first generation time.

## Corrected Clore Candidate Economics

- Clore on-demand USD market price fields are parsed as USD per 24 hours.
- Server `95538`: raw price `14.99 USD/day`, normalized price `0.624583 USD/hour`.
- One hour cost: about 0.6246 USD.
- Six hour planned session: about 3.7475 USD.
- Two six hour sessions: about 7.50 USD.
- Current balance: 10.99 USD.
- Budget after 1 USD reserve: 9.99 USD.
- Covered runtime after reserve at the normalized price: about 15.99 hours.
- Estimated balance after two six hour sessions: about 3.49 USD.
- Minimum billing duration is still API-unconfirmed; show both actual-minute and 6 hour planning models before any real order.

## Session Orchestrator

Prepared states:

```text
idle, planning, order_pending, booting, restoring_model, starting_worker, ready,
processing, draining, uploading, cleaning, canceling, stopped, failed
```

Rules:

- Dry-run by default.
- A single queued job never automatically creates a Clore order.
- A real session requires explicit user start in a future task.
- Duplicate orders are blocked through ignored local state at `.secrets/clore-session-state.json`.
- The state file must not contain secrets, prompts, tokens, signed URLs, passwords, or SSH keys.
- Drain starts at 5h30m.
- Safety cleanup/cancel planning starts around 6h20m.
- Do not force-cancel while tasks are processing.
- Dynamic IP is acceptable because the worker polls Supabase.

## Commands

```powershell
npm run cost:plan
npm run clore:session:plan
npm run clore:session:dry
npm run clore:session:status
npm run clore:session:stop:dry
npm run check:cost-optimized-gpu
```

## 2026-07-12 Updated Live Cost Snapshot

The latest live read-only Clore query found cheaper qualified RTX 5090 capacity than the earlier 95538-only planning example.

- Wallet balance: `10.99 USD`.
- Planning budget after 1 USD reserve: `9.99 USD`.
- Qualified RTX 5090 candidates: 3.
- Cheapest current candidate: server `107713`, raw price `7 USD/day`, normalized `0.291667 USD/hour`, six-hour cost `1.75 USD`.
- At `0.291667 USD/hour`, `9.99 USD` after reserve covers about `34.25` hours.
- Two six-hour sessions on server `107713` would cost about `3.50 USD`, leaving about `7.49 USD`.
- Server `95538` remains valid but more expensive: raw `14.99 USD/day`, normalized `0.624583 USD/hour`, six-hour cost `3.7475 USD`, after-reserve coverage about `15.99` hours.

The architecture rule is unchanged: all host ordering and budget math must use normalized USD/hour, while preserving raw price amount and unit for audit.

R2/private model cache and a publicly pullable runtime image remain required before the guarded real create path should proceed. The runtime image exists in GHCR, but the package is still private. Cloudflare R2 is still not enabled for the account, so model-cache buckets and credentials are absent.

## 2026-07-12 Infrastructure Prep Update

- GitHub CLI is installed and authenticated.
- The private GitHub repository `gouzhuoqunn/ai-video-platform` exists. Native `git push` was unreliable on this network, so repository files were uploaded through GitHub Contents API.
- GitHub Actions built and pushed `ghcr.io/gouzhuoqunn/wan22-runtime:v0.1.0-pre-gpu`.
- Runtime image digest: `sha256:fd03ef72d7369f59b3af9e535d9f6a75add9430a5c1ef4e7fd5853be0e4c060a`.
- The GHCR package is not public yet; anonymous manifest checks return `401`.
- Project-local Wrangler is installed and authenticated, but Cloudflare R2 itself is not enabled for the account. R2 bucket listing returns Cloudflare code `10042`.
- Local Docker Desktop remains unnecessary; runtime image builds are intended to run in GitHub Actions.
- The runtime image workflow pushes immutable tags with SBOM and provenance.
- R2 remains empty/not created in this checkpoint. No Wan2.2 model files were uploaded.
- Model cache credentials are still absent and must remain ignored under `.secrets/`.

Next successful checkpoint should record:

- GHCR package visibility changed to Public while keeping the source repository private.
- R2 bucket name, private status, endpoint, and prefix.
- Admin and GPU read-only R2 credential files created locally without printing their values.
