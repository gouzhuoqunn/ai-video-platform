# Project Context

## 2026-07-11 default-off real Clore execution checkpoint

- Added a guarded real-execution code path from local_lab confirmation to Clore `create_order` and protected `cancel_order`, but it is disabled by default with `CLORE_ORDER_EXECUTION_ENABLED=false`.
- This checkpoint was mock-tested only. It did not call real `create_order`, create an order, cancel an order, spend balance, SSH into a host, download Wan2.2, rent a GPU, or deploy publicly.
- The web confirmation now requires a nonce, exact server-and-price confirmation text, risk checkbox, queued job count, loopback guard, and a fresh server-side Clore recheck before the guarded execution helper can run.
- Real create preflight verifies no active project order, RTX 5090/on-demand/rentable candidate, normalized price cap, first-session budget 4.50 USD, 1 USD balance reserve, SSH public key, Docker image metadata, and secret-free SSH-only order body.
- Active order state is stored in ignored `.secrets/clore-active-order.json`; create calls are guarded by ignored `.secrets/clore-order-create.lock`.
- Added dry-run first GPU deployment planning for SSH-only worker upload, official Wan2.2 download/manifest verification, one synthetic text job, upload, local result viewing, pause, cleanup, and safe stop.
- New docs: `docs/REAL_CLORE_EXECUTION.md`, `docs/FIRST_WAN22_DEPLOYMENT.md`, and `docs/EMERGENCY_GPU_SHUTDOWN.md`.
- New checks: `npm run clore:execution:test`, `npm run clore:ssh:test`, `npm run first-gpu-session:test`, and `npm run check:first-gpu-session`.

## 2026-07-11 Cost-optimized GPU session checkpoint

- Added local-only scaffolding for a one-user, low-frequency, maximum about 6 hour Clore GPU work session model.
- This checkpoint changed code, scripts, tests, and docs only. It did not create a real Clore order, spend Clore balance, SSH into any host, download Wan2.2 weights, create R2 resources, upload a Docker image, modify Supabase migrations, or deploy publicly.
- Model cache priority is fixed as: current Clore instance local dir, optional Clore persistent volume, private Cloudflare R2 cache, then official Hugging Face fallback.
- Fixed model: `Wan-AI/Wan2.2-TI2V-5B`. Official size budget: 34.2GB. Required GPU disk reservation: at least 200GB.
- Runtime image plan is `ghcr.io/<user>/wan22-runtime:<immutable-version>`. The Dockerfile remains a runtime image only and must not include model weights, `.env.local`, `.secrets`, prompts, videos, or secrets.
- Cost defaults: 0.70 USD/hour, 6 hour sessions, 60 minute cold start, 15 minute warm target, drain at 5h30m, cleanup/cancel safety plan at about 6h20m, 11 USD balance assumption, 1 USD reserve. This supports 2 full planned sessions.
- Idle rule: keep the GPU running only when another task is expected within 15 minutes.
- Persistent volume break-even default is about 0.23 USD/month. If Clore volume support is unavailable or too expensive, use R2 and do not block deployment.
- Clore session orchestrator state is stored in ignored `.secrets/clore-session-state.json` and contains no secrets. It is dry-run only in this checkpoint.
- Supabase is still the short-term private video relay. Local long-term archive default is `D:\AI-Video-Library` with `YYYY-MM-DD/job_id/output.mp4`, `metadata.json`, and `thumbnail.jpg`.
- Remote video cleanup is dry-run only and must require local verification plus at least 24 hours retention before any future delete.
- User-executed migrations 0005, 0006, and 0007 remain the current verified database boundary. No migration was added in this checkpoint.
- Real GPU servers must not receive `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CLORE_API_KEY`, `.env.local`, R2 write credentials, SSH private keys, Supabase sessions, access tokens, signed URLs, or full prompts in logs.
- Real GPU servers may receive only `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `GPU_WORKER_EMAIL`, `GPU_WORKER_PASSWORD`, and optional read-only model cache credentials.
- Do not open ComfyUI, Jupyter, Gradio, or public inference ports on real GPU instances.

## 2026-07-11 Live Clore read-only checkpoint

- Real Clore read-only API access was verified for `wallets`, `marketplace`, and `my_orders`.
- `CLORE_API_KEY` was read only from `.secrets/clore.env`; it was not printed, written to fixtures, sent to GPU runtime plans, or added to Docker build context.
- SSH public/private key presence was checked locally. The public key format is valid, and the private key is outside the project directory.
- Wallet summary: USD-like balance is 10.99. With a 1 USD reserve, the planning budget is 9.99.
- Active orders: none.
- Current compliant RTX 5090 candidates under hard filters: 0.
- Closest rejected RTX 5090 candidate: server `95538`, RTX 5090, API-reported 31GB GPU memory, 128.7286GB RAM, 24 CPU cores, 970GB disk, 2070.14/881.23 Mbps, reliability 0.9997, rating 5.0 from 10 ratings, Canada, 14.99 USD/hour, 89.94 USD for 6 hours.
- Rejection reasons for `95538`: GPU memory below 32GB and price above the 0.70 USD/hour maximum.
- Clore marketplace response did not expose a confirmed minimum billing duration in the sanitized candidate summaries. Dry-run plans mark minimum billing as API not confirmed and require checking the Clore order confirmation screen before any future real create.
- `clore:create:dry` is now permanently dry-run and rejects `--execute`. The future real entry is separated as `npm run clore:create -- --execute --server-id=<id> --max-price=<price> --confirm-project=ai-video-platform-wan22`, but this checkpoint still refuses to call `create_order`.
- `.secrets/clore-order-plan.json` was generated with `plan_status=dry_run_only` and no API key, password, token, or SSH private key.
- R2 setup is intentionally deferred until after the first successful real GPU video proves Wan2.2 works on the selected 5090.

## 2026-07-11 Clore price and RTX 5090 VRAM normalization fix

- Clore live marketplace `price.usd.on_demand_usd` is treated as USD per 24 hours, not USD per hour.
- Server `95538` now normalizes `14.99 USD/day` to `0.624583 USD/hour`.
- Six hour planning cost for `95538` is about 3.7475 USD.
- With the current 10.99 USD balance and 1 USD reserve, 9.99 USD covers about 15.99 hours at that normalized price.
- `specs.gpuram=31` for exact RTX 5090 is treated as an API rounded/usable VRAM display under a model-specific rule. It is not a global lowering of the 32GB memory standard.
- Non-RTX 5090 cards and unknown GPUs do not receive this tolerance.
- Current compliant RTX 5090 candidate count after the fix: 1.
- Cheapest compliant candidate: server `95538`, Canada, RTX 5090, 128.7286GB RAM, 24 CPU cores, 970GB disk, 2070.14/881.23 Mbps, reliability 0.9997, rating 5.0 from 10 ratings.
- Platform total price remains API-unconfirmed; no platform fee is guessed or added.
- A new dry-run plan was generated. No `create_order` call was made, no order was created, no balance was consumed, no SSH connection was opened, and no model was downloaded.

This file is the short working context for future development. New tasks should read `AGENTS.md`, this file, `docs/CLORE_DEPLOYMENT.md`, `docs/LOCAL_LAB_MODE.md`, and the directly relevant source files first. Read all docs only when this file is missing, stale, or insufficient.

## 2026-07-11 local creation studio checkpoint

- `local_lab` homepage now uses a dedicated light local creation studio UI while ordinary mode keeps the existing commercial/studio experience.
- Users can add multiple text prompts to the existing `video_jobs` queue through `create_video_job`; GPU-offline jobs remain `queued`.
- The page shows a main video area, prompt queue, history cards, local archive markers, and a right-side hover/pin panel for Clore host and deployment status.
- Added loopback-only local APIs for Clore candidates, wallet, session status, order plan, order confirmation, session stop dry-run, jobs, and local results.
- Clore candidate and wallet APIs return sanitized summaries only. They do not return `CLORE_API_KEY`, full raw marketplace responses, wallet deposit data, signed URLs, or secrets.
- Order planning uses a short-lived one-time nonce stored under ignored `.secrets`. Confirmation requires the text `确认租用 <server_id>` and a risk checkbox.
- `CLORE_ORDER_EXECUTION_ENABLED=false` remains the default, and the current confirm route still does not call real `create_order`, even if the future environment flag is changed.
- Local result serving is loopback-only, validates `job_id`, prevents directory traversal, supports video Range requests, and does not return absolute local paths.
- No Clore order was created, no balance was spent, no SSH connection was opened, no GPU was rented, and no Wan2.2 weights were downloaded.

## Tech Stack

- Next.js App Router
- React
- TypeScript
- Tailwind CSS
- Supabase Auth, PostgreSQL, RLS, RPC functions, and private Storage
- npm scripts for local development and checks

## Directory Map

- `src/app`: pages and API routes.
- `src/components`: shared UI and the main studio experience.
- `src/lib/supabase`: browser, server-session, and server-secret Supabase clients.
- `src/types`: shared TypeScript types and model/status configuration.
- `supabase/migrations`: manually executed SQL migrations. Do not edit old migrations.
- `docs`: architecture, setup, roadmap, worker setup, and this project context.
- `scripts`: local developer scripts such as the mock worker and Clore rental prep.
- `scripts/setup-local-lab-user.ts`, `scripts/reset-local-lab.ts`, `scripts/check-local-lab.ts`: local single-user lab account setup, reset, and verification helpers.
- `gpu-worker`: Python Wan2.2 Worker preparation code, Dockerfile, and local mock tests.
- `scripts/clore`: Clore.ai read-only marketplace/wallet helpers, mock filtering tests, order dry-run planning, and SSH-only Worker prep scripts.
- `src/components/LocalCreationStudio.tsx`: local_lab-only creation studio UI.
- `src/app/api/local-lab`: local_lab-only loopback API routes for session, jobs, Clore dry-run console, and local result serving.

## Implemented Features

- Supabase email/password registration and login.
- Logout and session checks.
- New users get a 100 credit account through `0001`.
- Users can read their own credit balance.
- Users can submit real video task records through `create_video_job`.
- Task creation now deducts credits in `0003`: 5 for lightweight, 10 for standard.
- Users can cancel their own queued tasks through `cancel_video_job`; cancellation refunds credits.
- Users can view their own task history.
- Service-role worker RPC functions can claim, heartbeat, complete, fail, and requeue stale jobs.
- Private `generated-videos` bucket is prepared for worker uploads.
- Succeeded jobs are played through short-lived signed URLs, not public URLs.
- `npm run mock-video:generate` generates and validates `public/mock-videos/demo.mp4` from synthetic ffmpeg test patterns.
- A local mock worker can process one queued task at a time using a local demo MP4, and `npm run worker:mock:once` runs one integration-friendly pass.
- `npm run verify:remote` validates Supabase env names, 0003 columns, private Storage bucket, and Worker RPC without printing secrets.
- `npm run test:integration` creates temporary Supabase test users/data, verifies the credit/worker/storage/signed URL loop, and cleans its data.
- `npm run worker:mock:once:test` verifies one-shot mock worker behavior with no queued task and with one temporary queued task.
- `npm run test:cleanup` scans and cleans only Codex-prefixed temporary test residue.
- `supabase/migrations/0005_limited_gpu_worker_role.sql` prepares a limited `gpu_worker` role so future third-party GPU hosts do not need Supabase Secret keys. The user executed it remotely on 2026-07-07.
- `supabase/migrations/0006_gpu_worker_storage_insert_grant.sql` was added after verification found that 0005's Storage insert policy also needs the table-level `grant insert on storage.objects to authenticated`. The user executed it remotely on 2026-07-09.
- `supabase/migrations/0007_gpu_worker_storage_policy_rls_fix.sql` was added after 0006 verification showed the Storage policy's direct `video_jobs` subquery is still filtered by `video_jobs` RLS for the Worker user. The user executed it remotely, and the limited Worker private Storage pipeline has been verified.
- `npm run gpu-worker:create-account` created and verified a limited Worker account locally, wrote credentials to `.secrets/gpu-worker.env`, confirmed `app_metadata.role = gpu_worker` in the JWT, and confirmed ordinary users cannot forge that role.
- `gpu-worker` prepares a Python Wan2.2 TI2V-5B Worker. Local mode is mock-only and does not download model weights.
- Clore.ai is now the only primary GPU rental platform. The user has registered Clore, added about 11 USD, and configured a local-only `CLORE_API_KEY` in `.secrets/clore.env`. Read-only wallet, marketplace, and order-status queries have been verified. No order has been created, no GPU has been rented, no Wan2.2 weights have been downloaded, and nothing has been deployed publicly.
- The verified Clore wallet summary shows `USD-Blockchain: 10.99`. The current real RTX 5090 marketplace has no compliant candidate under the configured `CLORE_MAX_GPU_PRICE_PER_HOUR=0.70` and assumed 6 hour minimum rental window.
- Closest observed strong rejected RTX 5090 candidate: server `95538`, Canada, RTX 5090, API-reported GPU memory 31GB, 128.7GB RAM, 24 CPU cores, 970GB disk, 2070/881 Mbps network, reliability 0.9997, rating 5.0 from 10 ratings, 9.90 USD/hour, 59.40 USD for 6 hours. It was rejected because GPU memory is reported below 32GB and price exceeds the configured cap/balance.
- RunPod Secure Cloud is retained only as a last-resort fallback.
- `local_lab` mode is now the temporary priority for running the app only on the user's laptop. It keeps the commercial site code but hides commercial UI, auto-signs in a dedicated `app_metadata.role=local_tester` account, displays credits as `∞`, and submits only `standard-video` mapped to Wan2.2 TI2V-5B.

## Database Tables And Functions

- `profiles`: user profile rows tied to `auth.users`.
- `credit_accounts`: one credit balance row per user.
- `credit_transactions`: immutable credit ledger rows.
- `video_jobs`: task records, progress, worker lease fields, private output path, charge/refund timestamps.

Important functions:

- `public.handle_new_user()`: creates profile, credit account, signup bonus ledger row.
- `public.create_video_job(p_prompt, p_model_key)`: authenticated user task creation and charge.
- `public.cancel_video_job(p_job_id)`: authenticated user queued cancellation and refund.
- `public.claim_next_video_job(p_worker_id, p_lease_seconds)`: service-role worker claim.
- `public.heartbeat_video_job(...)`: service-role progress and lease extension.
- `public.complete_video_job(...)`: service-role success completion.
- `public.fail_video_job(...)`: service-role failure and refund.
- `public.requeue_stale_video_jobs()`: service-role stale lease recovery.

Migration note:

- `0003` and `0004` have been executed by the user in the remote Supabase project.
- `supabase/migrations/0004_integration_fixes.sql` fixes a PL/pgSQL `user_id` ambiguity in `create_video_job` and `cancel_video_job`.
- `supabase/migrations/0005_limited_gpu_worker_role.sql` has been executed remotely by the user.
- `supabase/migrations/0006_gpu_worker_storage_insert_grant.sql` has been executed remotely by the user.
- `supabase/migrations/0007_gpu_worker_storage_policy_rls_fix.sql` has been executed remotely by the user. Do not edit old migrations.

## Environment Variables

Public browser variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

Server-only variables:

- `SUPABASE_SECRET_KEY` preferred for service-role/admin operations.
- `SUPABASE_SERVICE_ROLE_KEY` legacy fallback only.
- `MOCK_VIDEO_SOURCE` optional local MP4/WebM path for the mock worker.
- `MOCK_WORKER_POLL_INTERVAL_MS` optional mock worker polling interval.
- `MOCK_WORKER_ONCE=true` makes the mock worker claim at most one job and exit.
- Future GPU workers use only `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `GPU_WORKER_EMAIL`, `GPU_WORKER_PASSWORD`, and `GPU_WORKER_USER_ID`.
- `.secrets/gpu-worker.env` is ignored and stores generated limited Worker credentials.
- Real GPU hosts must not receive `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`.
- `CLORE_API_KEY` is local-only and is stored only in `.secrets/clore.env`; it must never be printed, committed, sent to GPU hosts, or exposed with `NEXT_PUBLIC_`.
- Clore planning variables use `CLORE_*` names and never `NEXT_PUBLIC_*`.
- Clore read-only commands may query wallet, marketplace, and order status. Current create/cancel paths remain dry-run only.
- `NEXT_PUBLIC_APP_MODE=local_lab` controls local lab browser display.
- `LOCAL_LAB_ENABLED=true` is server-only and enables loopback Host protection plus local auto-login.
- `.secrets/local-lab.env` is ignored and stores the dedicated local test account credentials.
- `CLORE_ORDER_EXECUTION_ENABLED=false` keeps web-triggered real order creation disabled.
- `CLORE_ORDER_PLAN_TTL_SECONDS` controls the short order-plan nonce lifetime.
- `CLORE_CANDIDATE_REFRESH_SECONDS`, `CLORE_IDLE_SHUTDOWN_MINUTES`, and `CLORE_AUTO_SHUTDOWN_ENABLED` are planning placeholders for the local_lab console.

Never place server secrets in `NEXT_PUBLIC_*` variables. Never commit `.env.local`.

## Security Boundaries

- Browser code may read only the current user's allowed rows through RLS.
- Browser code cannot directly insert/update/delete `video_jobs`.
- Browser code cannot set task status, output paths, costs, worker lease fields, or credit balances.
- Worker RPCs allow `service_role` and, after 0005, authenticated users whose JWT `app_metadata.role` is `gpu_worker`.
- Remote verification confirmed the limited Worker identity, RPC path, private Storage upload, wrong-path rejection, non-video rejection, read isolation, and delete protection.
- Future GPU servers must not hold Supabase Secret or service_role keys.
- Future GPU servers must not hold Clore API keys.
- Clore is P2P infrastructure. First tests must use synthetic prompts only; do not upload real user faces or sensitive media.
- Clore rental is on-demand only. Spot, automatic RTX 4090 fallback, and automatic relaxation of privacy/reliability filters are not allowed.
- In `local_lab`, requests must come from `localhost`, `127.0.0.1`, or IPv6 loopback. Remote/LAN Hosts receive 403.
- In `local_lab`, the browser shows infinite credits, but the database stores a large finite balance of `1000000000` and existing charge/refund RPCs still run.
- `generated-videos` is private; users get short-lived signed URLs only for their own succeeded jobs.
- No public Storage bucket, public video URL, payment, invitation, device fingerprint, real GPU connection, Clore order, SSH session, or model download exists.
- Remote tests verified temporary user signup initialization, 5/10 credit charges, unique charge/refund ledgers, cancellation refund, worker claim locking, heartbeat monotonic progress, failure refunds, stale lease requeue/fail paths, private Storage upload/access isolation, short-lived signed URL access, and the limited `gpu_worker` upload/complete loop.

## Unfinished Features

- Real RTX 5090 Worker and real model inference.
- Production deployment.
- Payment/recharge.
- Reference image upload.
- Admin dashboard.
- Full observability and production job monitoring.

## Next Development Direction

The next stage should prepare a real Clore RTX 5090 Worker run only after the user explicitly accepts a higher real rental budget or the marketplace offers a compliant RTX 5090 within the current cap. The Worker process should:

- Uses the same service-role RPC functions.
- Downloads or generates model inputs safely.
- Uploads generated files to the same private bucket path format.
- Calls `complete_video_job` or `fail_video_job`.
- Uses the limited GPU Worker account and `gpu-worker/worker.py`, not the service-role mock worker.

## Design Decisions

- Use PostgreSQL RPC functions for charge/refund/task state transitions so credits and tasks update atomically.
- Use row locks and `for update skip locked` to avoid duplicate worker claims.
- Use unique credit ledger indexes for idempotent charge/refund references.
- Store private Storage paths in the database, not public URLs.
- Use polling, not Realtime, for this small first version.

## Common Commands

```powershell
npm install
npm run dev
npm run dev:local
npm run local-lab:setup
npm run local-lab:reset:dry
npm run local-lab:check
npm run local-lab:test
npm run check:local-lab
npm run worker:mock
npm run worker:mock:once
npm run worker:mock:once:test
npm run mock-video:generate
npm run test:unit
npm run test:gpu-worker-role
npm run test:cleanup
npm run gpu-worker:test
npm run clore:find:mock
npm run clore:create:dry
npm run clore:cancel:dry
npm run clore:test
npm run clore:execution:test
npm run clore:ssh:test
npm run first-gpu-session:plan
npm run first-gpu-session:test
npm run check:clore-prep
npm run check:first-gpu-session
npm run docker:check
npm run secret:scan
npm run check:gpu-prep
npm run lint
npm run typecheck
npm run build
npm run verify:remote
npm run test:integration
npm run check
npm run check:full
```

`check:full` includes remote verification and remote integration tests. It needs a valid `.env.local`, a service Secret key, and the remote migrations already executed through `0007`.

Real Clore read-only commands after `.secrets/clore.env` exists:

```powershell
npm run clore:find
npm run clore:wallet
npm run clore:status
```

No command in the current task creates a Clore order, spends balance, connects to a GPU, downloads model weights, or opens public inference ports.

## 2026-07-12 Local Studio and Clore Final-prep Checkpoint

Current verified state:

- The local_lab creation studio now keeps the right GPU/host sidebar expanded on desktop with a reserved 380px column. Narrow screens still use a click-open drawer.
- History video deletion remains local_lab-only and loopback-only. It rejects processing jobs, cancels queued jobs before deletion/refund, deletes local result files, deletes matching private Supabase generated video objects, deletes only the local_tester-owned job record, and does not expose absolute paths.
- Clore host sorting uses normalized USD/hour, not raw daily price text. The UI keeps a selected host only while it remains in the rentable candidate list; otherwise it clears the selection and asks for a new explicit choice.
- Live Clore read-only query found 3 compliant RTX 5090 candidates under the 0.70 USD/hour cap: `107713`, `107921`, and `95538`.
- Cheapest candidate in the latest query: server `107713`, raw `7 USD/day`, normalized `0.291667 USD/hour`, six-hour plan `1.75 USD`.
- Server `95538` remains qualified: raw `14.99 USD/day`, normalized `0.624583 USD/hour`, six-hour plan `3.7475 USD`; API VRAM display is `31 display_gb`, accepted only by the exact RTX 5090 model-specific rounded/usable VRAM rule.
- Wallet read-only balance was `10.99 USD`; after the 1 USD reserve, usable planning budget is `9.99 USD`.
- `clore:create:dry` regenerated `.secrets/clore-order-plan.json` as dry-run-only and did not call `create_order`.
- Real R2 model cache creation and real public runtime image build/push are currently blocked by local tooling/config: `wrangler`, `docker`, and `gh` were not found, and `.secrets/model-cache*.env` files are absent.
- Because the R2 cache and custom published runtime image are not configured, the guarded real Clore create path must not proceed.
- No Clore order was created, no balance was consumed, no SSH connection was opened, no Wan2.2 weights were downloaded, and no public deployment was made.

Validation completed:

```powershell
npm run clore:find
npm run clore:wallet
npm run clore:status
npm run clore:create:dry
npm run clore:session:plan
npm run cost:plan
npm run local-lab:delete:test
npm run check:local-lab
npm run check:gpu-prep
npm run check:first-gpu-session
```

Build passes, with non-fatal Next/Turbopack file-tracing warnings from local_lab routes importing server-side script helpers.

## 2026-07-12 GitHub/GHCR/R2 Infrastructure Prep Attempt

Goal: prepare GitHub, GHCR runtime image build, and Cloudflare R2 model cache without creating a Clore order, spending Clore balance, connecting SSH/GPU, or downloading Wan2.2 weights.

Completed locally:

- Installed GitHub CLI through winget.
- Installed project-local `wrangler` as a dev dependency.
- Replaced `.github/workflows/runtime-image.yml` with a manual GitHub Actions workflow that builds `gpu-worker/Dockerfile` on a GitHub-hosted Ubuntu runner, logs in to GHCR with `secrets.GITHUB_TOKEN`, pushes immutable tags, and enables SBOM/provenance.
- Updated runtime image tests to require GHCR push permissions, linux/amd64, SBOM/provenance, `npm run secret:scan`, and no `:latest` image tag.
- Verified `.env.local` and `.secrets/*` paths are ignored.
- Verified local site still responds at `http://127.0.0.1:3000`.
- Verified Clore status remains read-only with no active order.

Blocked by required browser OAuth / account setup:

- `gh auth login --web` did not complete, so GitHub user identity, repo creation, first commit, push, Actions trigger, GHCR package creation, image digest, and package visibility could not be completed.
- `npx wrangler login` opened Cloudflare OAuth but timed out before the callback completed, so R2 account availability, bucket creation, S3 credentials, and R2 permission tests could not be completed.

No Clore order was created, no `create_order` call was made, no Clore balance was consumed, no SSH/GPU connection was opened, no Wan2.2 model was downloaded, and no model files were uploaded to R2.

## 2026-07-12 GitHub Actions Runtime Image Success

Completed after GitHub OAuth:

- Created private GitHub repository: `gouzhuoqunn/ai-video-platform`.
- Configured current-repo-only Git identity from the real GitHub account.
- Created local commit `checkpoint: local creation studio and gpu deployment pipeline`.
- Native `git push` to `github.com:443` was unreliable in this network, so repository files were uploaded through GitHub Contents API instead.
- Triggered GitHub Actions workflow `Runtime Image`.
- First run failed because the GitHub-hosted runner ran out of disk space while building the CUDA/PyTorch image.
- Added a workflow step to free runner disk space and reran the workflow.
- Successful run: `29177649384`.
- Runtime image: `ghcr.io/gouzhuoqunn/wan22-runtime`.
- Immutable tag: `v0.1.0-pre-gpu`.
- Commit tag: `sha-b7076f466d5c8d5de6f5c5d8e9b18c326f8666e4`.
- Digest: `sha256:fd03ef72d7369f59b3af9e535d9f6a75add9430a5c1ef4e7fd5853be0e4c060a`.
- The runtime image was built from `gpu-worker/Dockerfile`, for `linux/amd64`, with SBOM/provenance enabled, and without Wan2.2 weights.
- Local ignored state `.secrets/runtime-image-state.json` records the non-secret image metadata.
- `.secrets/clore.env` now contains non-secret `CLORE_DOCKER_IMAGE` pointing at the pinned digest.

Still blocked:

- GHCR package is still private. Anonymous manifest check returns `401`, so Clore cannot pull it yet. The package visibility must be changed to Public in GitHub Package settings or through a refreshed GitHub token with package scopes.
- Cloudflare R2 is still not enabled for the account. `npx wrangler r2 bucket list` returns Cloudflare code `10042`, so no bucket or R2 S3 credentials were created.
- No model files were uploaded to R2.

Safety status remains unchanged: no Clore order, no Clore balance spend, no GPU/SSH connection, and no Wan2.2 download.

## 2026-07-12 Current Infrastructure Gate

- GitHub CLI auth is valid and Wrangler auth is valid.
- The runtime image exists in GHCR with immutable tag `v0.1.0-pre-gpu` and digest `sha256:fd03ef72d7369f59b3af9e535d9f6a75add9430a5c1ef4e7fd5853be0e4c060a`.
- The source GitHub repository remains private, as intended.
- The GHCR runtime package is still private and must be made Public before Clore can pull it.
- Cloudflare R2 must be enabled in the Cloudflare Dashboard before bucket creation and limited S3 credentials can proceed.
- Until those two gates are resolved, the real Clore create path must remain blocked.
