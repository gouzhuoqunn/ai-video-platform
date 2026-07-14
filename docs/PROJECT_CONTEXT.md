# Project Context

## 2026-07-14 Stage 2.6 Comfy Runtime CI and RTX 4090 Benchmark Prep

- FLUX.2 Klein 4B Distilled FP8 is now marked `eligible_for_benchmark` because its public primary file and auxiliary Qwen/VAE files are locked. Auxiliary source is the actual public Hugging Face repository `Comfy-Org/vae-text-encorder-for-flux-klein-4b` at commit `a9e4ca87c16db4c4e1a16406a9ddb300ab0ae246`; the `encorder` spelling is part of the real repository URL.
- FLUX.2 Klein 9B FP8 remains `gated_user_action_required` and must not be synced, benchmarked, or bypassed until the user accepts the provider terms.
- `comfy-runtime/workflows/official/` now stores official UI workflow locks, API-format prompt assets, and a manifest with SHA256 checks for FLUX.2 Klein 4B Distilled, Wan2.2 TI2V-5B, and Wan2.2 A14B I2V. The Wan assets are API-executable once models are present; the FLUX 4B asset is marked `subgraph_registration_required` because the official Comfy template uses UUID subgraph nodes.
- `src/lib/generation/workflow-registry.ts` now references the locked official workflow assets instead of loose mock templates for `image_t2i`, `video_ti2v`, and `video_i2v`. `video_flf2v` remains a second-round community placeholder.
- `.github/workflows/comfy-runtime-image.yml` now supports guarded push builds on `stage-two-five-comfy-runtime`, with path filters, default immutable tags, concurrency, and expanded no-model CPU smoke checks for Comfy routes, WebSocket handshake, invalid prompt rejection, required node classes, secret absence, no model weights, loopback bind, and no legacy Wan worker autostart.
- `benchmark/rtx4090-baseline-plan.json` defines the first RTX 4090 plan as plan-only and limited to FLUX.2 Klein 4B Distilled FP8 plus Wan2.2 TI2V-5B. FLUX.2 9B, Wan A14B, Phr00t, GGUF, Kijai, FLF2V, and Dev quantized candidates stay out of the first RTX 4090 round.
- Capacity planning now records 46.65GB for the RTX 4090 session and 182.30GB for all first-round baselines before any verified deduplication. The 200GB RTX 4090 disk floor remains larger than the 20% reserve estimate.
- New checks: `generation:workflow-assets:test`, `generation:comfy-source:test`, and `generation:4090-plan:test`; these are included in `check:stage-two-five`.
- This checkpoint did not create a Clore order, open SSH, download model weights, run GPU inference, upload models to R2, modify remote `main`, force push, reset, rebase, use the GitHub Contents API, install/build Docker locally, or mark any candidate as production.

## 2026-07-14 Stage 2.5 Candidate Audit and Comfy Runtime Scaffold

- Upgraded the generation registry from loose `planned/metadata_verified` states to strict audit states: `unverified`, `public_verified`, `gated_user_action_required`, `metadata_incomplete`, `eligible_for_benchmark`, and `rejected_before_benchmark`.
- Added `docs/MODEL_CANDIDATE_AUDIT.md` with a sanitized license and user-action report for FLUX.2 Klein 4B Distilled FP8, FLUX.2 Klein 9B FP8, Wan2.2 TI2V-5B, Wan2.2 I2V-A14B, and unverified community challengers.
- Read-only public metadata was checked for the first-round official candidates. This section reflects the Stage 2.5 state; Stage 2.6 above later completed the FLUX.2 Klein 4B auxiliary file lock. FLUX.2 Klein 9B FP8 remains `gated_user_action_required` and must not be synced or benchmarked until the user accepts the Hugging Face/BFL terms.
- Added an independent `comfy-runtime/` Docker scaffold for `ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime`. It does not replace the existing Wan first-test runtime and does not modify `gpu-worker/Dockerfile`.
- The Comfy runtime scaffold pins ComfyUI to `da2608926eaf68fd532bba4e1ace3402c5d21399`, reuses the verified Wan runtime CUDA/PyTorch digest as a base layer, starts ComfyUI on `127.0.0.1:8188`, adds a local controller on `127.0.0.1:8080`, keeps `START_GPU_WORKER=false`, and includes no model weights, prompts, generated outputs, `.env.local`, `.secrets`, Clore key, Supabase service key, R2 admin credential, SSH private key, or signed URL.
- Added `.github/workflows/comfy-runtime-image.yml` as a separate manual CI workflow for the Comfy runtime image. Stage 2.6 later added the guarded temporary-branch push trigger and expanded smoke checks.
- The local checkpoint was uploaded to remote temporary branch `stage-two-five-comfy-runtime` through Git Data API with `force=false`; the remote tree was verified to match the local tree. GitHub refused `workflow_dispatch` for `comfy-runtime-image.yml` because new workflow files must exist on the default branch before they can be dispatched. Since this task forbids modifying remote `main`, no Comfy runtime image tag, digest, or CI run ID exists yet.
- Added root `benchmark/` JSON specs (`image-prompts.json`, `video-prompts.json`, `workflow-cases.json`, `scoring-schema.json`, `benchmark-plan.schema.json`) and expanded `benchmarks/v1` to eight image and eight video cases, including two-person interaction and object motion.
- R2 production structure is locked to exactly four `production/.../current.json` entries plus shared prefixes for VAE, text encoders, CLIP vision, LoRAs, workflows, and custom-node locks. Production manifests may not read from `benchmark-staging`.
- New scripts: `generation:runtime:test`, `generation:workflow:test`, `generation:benchmark-schema:test`, and aggregate `check:stage-two-five`.
- Verified locally with `check:stage-two-five`, which runs generation architecture/metadata/runtime/workflow/benchmark-schema tests, `runtime-image:test`, `model-cache:test`, `lint`, `typecheck`, `secret:scan`, and `build`. The build passes with existing Turbopack NFT trace warnings in local-lab Clore routes.
- No Clore order, SSH session, model download, R2 model upload, real GPU inference, remote-main modification, force push, reset, rebase, local Docker install, or local CUDA image build occurred in this checkpoint.

## 2026-07-14 ComfyUI Metadata Audit and Benchmark Plan

- Added a metadata-audit registry, a frozen `benchmarks/v1` suite, capacity planning, smoke/quality benchmark gates, blind-review identifiers, and a written runtime-v1 build checklist.
- First-round official baselines: FLUX.2 Klein 4B Distilled FP8, Wan2.2 TI2V-5B, FLUX.2 Klein 9B FP8, and Wan2.2 I2V-A14B. The 9B candidate is gated under a non-commercial license and remains blocked until the license is explicitly accepted and a full immutable revision can be read.
- Public metadata is recorded for 4B, TI2V-5B, and A14B. This Stage 2.5 note used a 173.93 GB preliminary cache plan; Stage 2.6 above updates the complete first-round total to 182.30 GB after locking the FLUX 4B auxiliary files.
- RTX 4090 remains exact model / 24GB VRAM / 64GB RAM hard / 96GB preferred / 200GB disk hard. RTX 5090 remains exact model / 31-32GB display tolerance only / 80GB RAM hard / 128GB preferred / 250GB disk hard. The scheduler helper uses the larger of the hard disk floor and 120% of planned sync size.
- `/generate/4090` and `/generate/5090` now show the official-first candidate order, metadata-audit/pending-benchmark phase, and planned sync volume. They still use mock data and the confirmed light visual baseline.
- No Clore order, SSH session, model download, large ComfyUI image build, GPU benchmark, R2 upload, remote-main push, or production promotion occurred in this checkpoint.

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

R2 credentials completed:

- R2 S3 credentials were created in Cloudflare Dashboard and stored only in ignored `.secrets/model-cache-admin.env` and `.secrets/model-cache-readonly.env`.
- No model files were uploaded to R2.

Safety status remains unchanged: no Clore order, no Clore balance spend, no GPU/SSH connection, and no Wan2.2 download.

## 2026-07-12 Current Infrastructure Gate

- GitHub CLI auth is valid and Wrangler auth is valid.
- The runtime image exists in GHCR with immutable tag `v0.1.0-pre-gpu` and digest `sha256:fd03ef72d7369f59b3af9e535d9f6a75add9430a5c1ef4e7fd5853be0e4c060a`.
- The source GitHub repository remains private, as intended.
- The GHCR runtime package is now Public. Anonymous manifest access returns 200 and the digest matches the pinned image.
- Cloudflare R2 is enabled.
- Private R2 bucket `ai-video-platform-wan22-model-cache` exists. `r2.dev` public access is disabled, no custom domains are connected, and a Wrangler OAuth put/get/delete probe passed and cleaned its test object.
- `.secrets/model-cache.env` now stores non-secret bucket, endpoint, and prefix configuration for dry-run and future deployment planning.
- `npm run model-cache:r2:test` verified that the admin credential can list, put, get, overwrite, and delete test objects.
- The same test verified that the GPU read-only credential can list and get, but cannot put, overwrite, or delete.
- All R2 permission test objects were cleaned; bucket info showed `object_count: 0`.
- GPU deployment planning now allows `.secrets/model-cache-readonly.env` and explicitly forbids `.secrets/model-cache-admin.env`.
- The first real GPU session preconditions are now satisfied from the local prep side: public GHCR runtime image, private R2 bucket, verified read-only R2 credential boundary, limited GPU Worker credentials, SSH public key, Clore dry-run, no active Clore order, and passing local checks.
- Real Clore create still requires an explicit future user command and final live confirmation; no order was created in this checkpoint.

## 2026-07-12 Model Cache Seed Flow Gate

- Added and verified a local-controller model cache seed flow for the first future Wan2.2 GPU session.
- The future GPU downloads `Wan-AI/Wan2.2-TI2V-5B` from official Hugging Face on the rented Clore GPU, generates a manifest, and asks the local controller for short-lived, object-specific R2 upload permission.
- The GPU receives only `.secrets/model-cache-readonly.env`; `.secrets/model-cache-admin.env` stays local and is never sent to Clore, Docker, SSH commands, manifests, logs, or browser responses.
- R2 object layout is fixed:
  - files: `wan22-ti2v-5b/files/<relative_path>`
  - revision manifest: `wan22-ti2v-5b/manifests/<model_revision>.json`
  - current pointer: `wan22-ti2v-5b/current.json`
  - staging: `wan22-ti2v-5b/staging/<session-id>/`
- `npm run model-cache:seed:test` now covers mock manifest validation, safe relative paths, skip/staging planning, presigned PUT, multipart planning, publish-last `current.json`, secret-free logs, and a real small R2 presigned PUT probe under `_seed-test`.
- The real probe uploaded only a tiny random test object, verified read access through the GPU readonly credential, verified other-key and readonly-write attempts are blocked, and cleaned the object.
- No Clore order was created, no balance was spent, no SSH/GPU connection was opened, no Wan2.2 model was downloaded, and no Wan2.2 model file was uploaded to R2.

## 2026-07-12 First Real Clore Order Attempt

- A real on-demand Clore order was created for live RTX 5090 server `107713`.
- Live selection used the cheapest compliant candidate at `7 USD/day`, normalized to about `0.291667 USD/hour`; six-hour planning cost was `1.75 USD`.
- The Clore create body required two real API compatibility fixes:
  - `required_price` must use the Clore marketplace day price (`7`) while local budget checks still use normalized USD/hour.
  - `currency` must match the wallet/marketplace key `USD-Blockchain`.
  - `autossh_entrypoint: true` is required for the SSH entrypoint.
- Real Clore order ID: `1947533`.
- SSH endpoint appeared with mapped port `1202`, but SSH reset/timed out for the full 30-minute readiness window.
- No GPU hardware check, model download, Worker start, video inference, Supabase video upload, local archive, or R2 model cache publish happened.
- The order was canceled through real `cancel_order` with failure cleanup issue `ssh_unavailable`.
- Final live `my_orders` showed no active order. Wallet moved from about `15.89 USD` to `15.55 USD`, so the failed attempt cost about `0.34 USD`, below the `4.50 USD` cap.
- The queued local_lab standard-video task remains queued for the next attempt.

## 2026-07-13 First Session Watchdog Safety Patch

- Added a Cloudflare Worker watchdog project at `cloudflare/clore-watchdog` with a private, separate R2 state bucket named `ai-video-platform-clore-watchdog-state`.
- The watchdog is designed for Cron-only execution every minute, with `workers_dev=false` and no public control API. Its `fetch` handler returns 404.
- `CLORE_API_KEY` is stored as a Cloudflare encrypted Worker Secret named `CLORE_API_KEY`; it is not written to code, Git, R2 state, GPU env, or logs.
- Remote watchdog state records only non-secret session data: nonce, server id, order type, `USD-Blockchain`, starting wallet balance, arm time, 350 minute draining time, 380 minute hard deadline, and a 4.50 USD hard budget with safety margin.
- A dedicated Windows scheduled task `AiVideoPlatformCloreWatchdog` now runs the local watchdog tick every minute. The local tick reads the existing local Clore secret file only on the developer machine and never prints the key.
- Real `create_order` now fails closed unless `CLORE_RENTAL_CURRENCY=USD-Blockchain`, the remote watchdog is armed and healthy for the selected server, and the local Windows watchdog task plus heartbeat are healthy.
- Worker first-session mode now uses `FIRST_SESSION_MAX_CLAIMS=1`, counted at claim time. If the first job fails, the Worker will not claim a second job in that session.
- Wan runtime code is pinned to `Wan-Video/Wan2.2` commit `42bf4cfaa384bc21833865abc2f9e6c0e67233dc`; the fixed model revision is `Wan-AI/Wan2.2-TI2V-5B` commit `921dbaf3f1674a56f47e83fb80a34bac8a8f203e`.
- The unsafe queued local_lab job was canceled through the normal `cancel_video_job` RPC path, and exactly one safe text-only `standard-video` first-test job was created.
- Current blocker: Cloudflare accepted the Worker upload, R2 binding, and encrypted secret, but the Cron schedule deployment returned 403 on the Cloudflare schedules API. Until Cron succeeds and writes a fresh remote heartbeat, real Clore create remains blocked by the new preflight.
- No Clore order was created, no SSH connection was opened, no Wan2.2 weights were downloaded, and no real inference was run in this patch.

## 2026-07-13 Clore Pricing Gate Fix

- Historical order `1949701` was checked through read-only `my_orders?return_completed=true` and saved as a sanitized fixture with only `id`, `si`, `currency`, `price`, `fee`, `creation_fee`, `spend`, `ct`, and `expired`.
- Clore marketplace prices are treated as base prices before renter fees. The project now computes:
  - `base_hourly = marketplace_on_demand_price_per_day / 24`
  - `effective_hourly = base_hourly * 1.05`
  - `projected_total = 0.10 creation_fee + effective_hourly * session_hours`
- Real create preflight now requires `effective_hourly <= 0.70 USD`, `projected_total <= 4.50 USD`, and `wallet_balance - projected_total >= 1.00 USD`.
- The Clore `required_price` field still uses the marketplace base day price and does not include the 5% renter fee or one-time creation fee.
- After a future order is created, the guard validates live `my_orders` fields: price not increased, fee not above 5%, creation fee not above `0.10`, and currency exactly `USD-Blockchain`. A pricing guard failure attempts immediate cancellation.
- Candidate summaries and local_lab order confirmation now show base hourly price, effective hourly price, one-time creation fee, and maximum-session projected total.
- This pricing fix did not create a Clore order, SSH into a host, download a model, or push to GitHub.

## 2026-07-13 Zero-cost SSH Root Cause Audit

- Historical orders `1949701` and `1949948` were checked read-only through Clore `my_orders?return_completed=true`; no Clore order was created, no SSH connection was opened, no model was downloaded, and no Git remote sync was attempted.
- Both real attempts used the pinned GHCR image `ghcr.io/gouzhuoqunn/wan22-runtime@sha256:fd03ef72d7369f59b3af9e535d9f6a75add9430a5c1ef4e7fd5853be0e4c060a`, `autossh_entrypoint: true`, and only `22/tcp`.
- The audit found a deterministic runtime-image startup issue: `gpu-worker/entrypoint.sh` previously started `worker.py` immediately, while the Clore create order intentionally did not send limited Worker credentials at order time. Missing Worker env could make the container exit before SSH/bootstrap stabilized.
- The entrypoint now creates workspace directories, runs any Clore-provided bootstrap command, and then stays alive for SSH/bootstrap when Worker credentials are absent. It starts the Worker only when `START_GPU_WORKER` is true or the limited Worker env is present.
- `runtime-image:test`, `clore:execution:test`, `clore:ssh:test`, and `typecheck` passed after the fix.

## 2026-07-13 Runtime Image SSH Bootstrap Verification

- A new GHCR runtime image digest was published from the SSH bootstrap fix: `ghcr.io/gouzhuoqunn/wan22-runtime@sha256:4e3dd6d2610c33ab2b260e970e4a9288043dc2c762cb1b8902b6712cfdfaa96c`.
- GitHub Actions run `29260394649` verified the existing digest without rebuilding: build/push was skipped, anonymous GHCR access worked, `linux/amd64` was present, `Entrypoint` remained `/app/entrypoint.sh`, the bootstrap marker was created, the container was still running after 30 seconds, and `docker top` did not show `python /app/worker.py`.
- Local ignored runtime configuration now points `CLORE_DOCKER_IMAGE` at the new pinned digest. The old digest must not be used for future real Clore create attempts.
- This verification did not create a Clore order, open SSH, download Wan2.2, or generate a video.

## 2026-07-14 Local Pending Queue, Batch Actions, and Mock Auto-rent UI

- Added a local-first task flow where `create_video_job` deducts credits immediately but creates `pending_confirmation` jobs instead of directly entering the GPU queue.
- Added batch confirmation, batch urgent confirmation, batch soft delete, and regeneration RPCs. Confirmation moves pending jobs to `queued`; urgent jobs are ordered ahead of normal jobs; delete rejects processing jobs; regeneration creates a new pending job with generation lineage.
- Added soft-delete metadata, thumbnail metadata, priority, confirmation time, queue time, and generation lineage columns to `video_jobs`.
- Queue claiming now ignores soft-deleted jobs and only claims confirmed `queued` jobs, ordered by urgent priority and confirmation time.
- Added `gpu_autorent_requests` for the local UI and mock auto-rent state machine. Real auto-rent remains disabled by default with server-only `CLORE_AUTORENT_ENABLED=false`; the UI/API report `create_order_called:false`.
- When a batch confirm/urgent action sees an active GPU session, the UI now asks whether to use the current GPU queue, wait for the current GPU to close before auto-renting, or cancel. The current-GPU path does not create an auto-rent request, preserving the one-active-GPU rule.
- The auto-rent budget display uses the existing Clore pricing rules: base hourly, effective hourly with 5% renter fee, one-time creation fee, projected 380-minute total, max effective hourly `0.70`, max projected budget `4.50`, and wallet reserve `1.00`.
- The local creation studio now shows the current job/video first, a real task list below it, checkboxes for batch actions, quick delete with optimistic removal, generation labels, hidden detailed host pricing until a candidate is selected, and a clear disabled/mock auto-rent panel while Clore is blocked.
- GPU Worker completion now uploads `output.mp4` first, then best-effort `thumbnail.jpg`. Thumbnail generation uses `ffmpeg`; thumbnail failure does not mark a successful video as failed.
- Local result deletion now removes local video, thumbnail, metadata, and matching private Supabase objects when possible, then records cleanup status. Signed video URLs are refused for soft-deleted jobs.
- Existing Clore create/cancel, watchdog, SSH timeout, max-one-active-order, and pricing guards were not relaxed. Mock auto-rent exposes a 60-second session-complete cancel deadline while real cancel remains guarded by the existing two-confirmation active-order checks. No real Clore order, SSH connection, model download, or video generation occurred in this checkpoint.
- Verified with `local-lab:test`, `local-lab:delete:test`, `local-lab:batch:test`, `test:unit`, GPU Worker unit tests, `clore:execution:test`, `clore:ssh:test`, `clore:session:test`, `lint`, `typecheck`, and `secret:scan`.

## 2026-07-14 Remote 0008 and Visual Baseline Verification

- `supabase/migrations/0008_pending_confirmation_batch_autorent.sql` was applied manually by the user through the correct Supabase project's SQL Editor. It must not be re-run automatically.
- Remote read checks confirmed the new `video_jobs` fields, including `thumbnail_path`, are selectable, and `gpu_autorent_requests` is readable through the authenticated local_tester path.
- Remote RPC checks confirmed the batch functions are present: `confirm_video_jobs`, `mark_video_jobs_urgent`, `soft_delete_video_jobs`, `create_gpu_autorent_request`, `cancel_gpu_autorent_request`, and `regenerate_video_job`. Anonymous access to `confirm_video_jobs` is denied.
- Existing local_tester queued jobs had already migrated to `pending_confirmation`; no visible queued or processing test task needed stale recovery.
- A real browser session created a new local_tester task with prompt prefix `visual pending real page`. It was created as `pending_confirmation`, charged 10 credits once, appeared immediately in the Studio as `未生成`, and the selected checkbox displayed the batch action bar.
- The test task was cleaned through the normal authenticated `soft_delete_video_jobs` RPC. The first delete refunded 10 credits and set `deleted_at`; a second delete attempt returned `deleted_count=0` and did not change the balance, verifying single refund behavior.
- The Studio visual entry has been simplified so all modes render `LocalCreationStudio`; `NEXT_PUBLIC_APP_MODE` no longer switches to the old neon commercial page. Global CSS uses the confirmed light beige baseline.
- Screenshot artifacts were regenerated under ignored `artifacts/visual-check/`: `01-home.png`, `02-pending-selected.png`, and `03-host-detail.png`. The host detail screenshot uses the explicit local-only `?visual_mock=1` fixture and never calls `create_order`.

## 2026-07-14 Unified ComfyUI Runtime and Benchmark Mock Infrastructure

- Added a preparation-only ComfyUI runtime contract under `comfy-runtime/`. It pins ComfyUI to commit `da2608926eaf68fd532bba4e1ace3402c5d21399`, requires a local/internal bind address, and explicitly excludes model weights, user files, secrets, SSH private keys, and signed URLs.
- Added shared GPU profile logic for `rtx4090` and `rtx5090`. RTX 4090 requires exact `NVIDIA GeForce RTX 4090`, at least 24GB VRAM, 64GB RAM hard minimum, 96GB preferred RAM, 200GB disk hard minimum, 250GB preferred disk, and aggressive offload. RTX 5090 requires exact `NVIDIA GeForce RTX 5090`, the existing 31/32GB VRAM tolerance, 80GB RAM hard minimum, 128GB preferred RAM, 250GB disk hard minimum, 300GB preferred disk, and balanced offload.
- Added a model profile registry for `rtx4090_image`, `rtx4090_video`, `rtx5090_image`, and `rtx5090_video`. The registry only records candidates; unknown repositories, revisions, and sha256 values remain empty instead of being guessed. No model was downloaded.
- Added a workflow registry with mock ComfyUI API-format templates for `image_t2i`, `video_ti2v`, `video_i2v`, and `video_flf2v`, including version, required model slots, required custom nodes, output node mapping, and prompt/seed/size/frame injection rules.
- Added a mock ComfyUI controller contract for health, workflow submit, prompt status, output collection, interruption, and model-cache cleanup.
- Added a future benchmark state-machine contract that records startup, model sync/load, cold and hot generation, peak resources, output path/hash, workflow version, model revision, GPU model, driver, success/failure, and error class. The current runner is mock-only and never promotes a benchmark winner to production.
- Added R2 cache planning for `benchmark-staging`, `production`, `shared`, `workflows`, and `manifests`; production is constrained to exactly four profile pointers and `current.json` must publish last.
- Added lightweight `/generate/4090` and `/generate/5090` routes using one shared `GenerationProfilePage` component and the confirmed beige/white-card visual baseline. These pages use mock registry data only and do not connect to Clore or ComfyUI.
- Verified through targeted mock tests only. No Clore order was created, no SSH connection was opened, no GPU inference ran, no large model was downloaded, and no model cache was uploaded to R2.
