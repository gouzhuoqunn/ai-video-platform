
# Project Context

## 2026-07-16 Stage 3L RunPod deterministic pricing and bounded first-image attempt

- RunPod budgeting is now split into `computeHourly`, `storageHourly`, `totalHourly`, and `projectedSessionTotal`. Caps are 0.70 compute, 0.75 total hourly, and 2.50 projected/session hard limit. The legacy hourly variable is compute-only. Official running Pod storage is estimated at 0.10 USD/GB/month for both 50GB container and 30GB volume disk, about 0.0109589 USD/hour total storage.
- GPU stock is checked read-only per type. Create payloads use `gpuTypePriority=custom` and exactly one GPU ID. Secure candidates precede explicit Community fallback with public IP required. Candidate order is A40, A6000, 3090, L4, 4090, A5000, 3090 Ti.
- Historical Stage 3K logs did not retain the two rejected Pod IDs, GPU type, raw prices, or disk fields, and the RunPod list no longer returned terminated records. Their exact historical values cannot be reconstructed without fabrication. Future post-create logs and checkpoint state retain raw `costPerHr`, `adjustedCostPerHr`, disk sizes, all four derived prices, and the exact rejected field.
- Stage 3L made the maximum four create requests. A Secure A40 Pod (`ppl24zja77v75w`) passed the real price gate at compute 0.44, storage 0.0109589, total 0.4509589, and projected 1.5783562. It reached RUNNING, public SSH, authenticated SSH, hardware verification, and completed the R2 restore call, but the fixed Runtime correctly failed closed because its registry accepts only `rtx4090` and `rtx5090`, not `bootstrap_image_gpu`. The Pod was terminated.
- Two Secure RTX 4090 creates and one Community RTX 4090 create then returned RunPod HTTP 500 before a Pod existed. No second Pod entered SSH. The four-create hard limit stopped further attempts. Final RunPod active Pod count is zero, Watchdog/create lock are absent, Clore hold remains enabled, and Clore active order count is zero.
- No FLUX image or performance baseline was generated, so no PNG, benchmark, or new local archive exists. `/generate/4090` now persists a truthful Stage 3L no-image status through refresh/build restart instead of implying success.
- The two-hour emergency Colab bundle was regenerated and validated without exposing URLs. `manual_ssh` remains unconfigured. The read-only candidate watch command is `npm run runpod:candidate:watch`.
- Wan Phase 3M preparation locks the three Comfy workflow files at revision `fb1388adc906ab39ffc26ee40e96b22886b56bc4`, total 18,144,966,705 bytes, with exact SHA256 values, R2 capacity, parallel cache plan, real inference plans, workflow nodes, and status files. `wan:first-video:preflight` passes both plan booleans and triggers no cache run.

## 2026-07-15 Stage 3D Clore Rate-Limit Recovery and Connection Attempts

- All project Clore API calls now use one central scheduler: at least 1100ms between requests, at least 6000ms between creates, 60-second marketplace cache, 10-second wallet/order cache, create de-duplication, cancel priority, Retry-After handling, and bounded `2/4/8/15` second jittered recovery for HTTP 429 or Clore `code=5`. Network failures are bounded and create recovery has an active-order verification hook; deterministic non-rate errors are not retried.
- Live verification observed both HTTP 429 and Clore `code=5`; the scheduler recovered three guarded `create_order` calls without duplicate orders. It also exposed a platform-level limitation: each created order remained outside the platform `running` state for the full twelve-minute SSH window, so no SSH proxy, TCP connection, or authenticated command became available.
- Stage 3D attempted exactly three hosts: `105176` RTX 4090/order `1954464`, `105173` RTX 4090/order `1954484`, and `104878` RTX 5090/order `1954507`. All were canceled as `order_never_running`. `111125` returned deterministic Clore `code=6` before an order was created and did not incur cost or count as a connection attempt.
- Total Stage 3D charge was 0.55 USD, below the 0.80 USD failed-connection cap. Active order returned to zero, the Watchdog was disarmed, and wallet balance is 14.23 USD. No SSH, GPU inspection, Runtime boot, FLUX/Wan download, image/video generation, R2 cache, or local result occurred.

## 2026-07-15 Stage 3C FLUX First-Image Preparation

- Added a direct ComfyUI `/prompt` API workflow for FLUX.2 Klein 4B Distilled. It uses `UNETLoader`, `CLIPLoader(type=flux2)`, `CLIPTextEncode`, `FluxGuidance`, `EmptyFlux2LatentImage`, `KSampler`, `VAELoader`, `VAEDecode`, and `SaveImage`. The fixed ComfyUI commit shows that FLUX.2 Qwen uses `CLIPLoader(type=flux2)`; using `DualCLIPLoader` would be incompatible with the three locked model files.
- The first-image downloader now locks exactly three public model files by repository, immutable revision, byte size, and SHA256. It resumes through `.part`, retries each file at most once, verifies before an atomic rename, and is idempotent. No model was downloaded in this checkpoint.
- Bootstrap candidate filtering now admits CUDA-compatible NVIDIA GPUs with at least 16GB VRAM, 32GB RAM, and 120GB disk for first-image pipeline validation only. It preserves RTX 4090/5090 as the only profiles accepted by the current fixed Runtime digest; lower-tier bootstrap candidates fail closed pending a separately authorized Runtime build. No bootstrap result can set RTX 4090 benchmark or production-ready state.
- The loopback-only first-image executor checks Runtime health and `object_info`, completes a WebSocket handshake, submits `/prompt`, waits through `/history`, fetches `/view`, and archives at `D:\\AI-Creative-Library\\YYYY-MM-DD\\<session-id>\\` with `output.png`, `workflow-api.json`, `metadata.json`, and `runtime-evidence.json`. `/generate/4090` renders archived local PNG thumbnails through a loopback-protected route. No image exists yet.
- A live candidate query found server `105176` (RTX 4090, 64.23GB RAM, 1TB disk, effective 0.343 USD/hour, five-hour estimate 1.815 USD) as the first eligible non-excluded choice. The single guarded create request was blocked by a Clore API rate limit before any order existed. The Watchdog was disarmed, active order returned 0, and wallet balance remained 14.78 USD. No SSH, GPU validation, model download, inference, R2 upload, Wan work, or result archive occurred.

## 2026-07-15 Stage 3B Clore SSH Publication Repair

- Local evidence for failed order `1954329` confirmed `autossh_entrypoint=true`, `22/tcp`, a non-empty Ed25519 public key, `on-demand`, `USD-Blockchain`, and candidate daily price locking. It did not expose `8080/http`, and it used the old `wan22-runtime` digest rather than the verified Comfy Runtime digest.
- The real-order payload now requires the fixed `ai-creative-comfy-runtime@sha256:187a7eb304075863dbd3f7a1b527530a06783ad8ea0fec5e51e2b9725d1bf137`, `22/tcp`, and `8080/http`; it rejects `8188`, mutable image references, empty/invalid public keys, private-key material, and unlocked prices. The payload test covers each condition.
- Added `clore:readiness`, which waits up to fifteen minutes in ten-second intervals for running state, published SSH proxy endpoint, TCP reachability, and an authenticated `ssh true`; it classifies timeout as `order_never_running`, `image_pull_or_container_start_timeout`, `ssh_endpoint_not_published`, `ssh_tcp_unreachable`, `ssh_auth_failed`, or `runtime_start_failure`. HTTP proxy publication is recorded but is not a Runtime health verdict.
- The Stage 3B live RTX 4090 query found no new compliant candidate after the required historical exclusions. Closest candidates failed disk, RAM, or rating requirements. No Stage 3B order was created, so GPU boot, FLUX download, inference, R2 cache, and website result states remain unchanged and false.

## 2026-07-15 Stage 3A RTX 4090 First-Run Attempt

- A real Clore on-demand order `1954329` was created only after a live wallet/candidate check, successful SSH image/key preflight, and local plus remote Watchdog arming. It used server `91005`, an exact RTX 4090 candidate whose API reports `23 display_gb`; the code accepts that value only as the documented rounded display for an exact 24GB RTX 4090.
- The candidate met the configured requirements at selection time: 64.01GB RAM, 2TB disk, 501.99/466.93Mbps network, reliability 0.9994, rating 4.98 from 63 ratings, and base price 15.59 USD/day (0.649583 USD/hour). The projected 380-minute total including fees was 4.4197 USD under the 4.50 USD hard cap.
- Clore did not publish SSH information within the twelve-minute readiness window. The order was canceled as `ssh_unavailable`; active orders returned to 0, the Watchdog was disarmed, and wallet balance changed from 15.03 USD to 14.78 USD (0.25 USD actual charge).
- The only compliant candidate was temporarily excluded after this failure. A single live backup query found no remaining compliant RTX 4090 host, so the session stopped without weakening RAM, disk, network, reliability, price, or GPU identity filters.
- No real GPU hardware could be inspected, no Runtime GPU boot occurred, no FLUX files were downloaded, no inference or image was generated, no R2 cache upload happened, and no website result was added. Runtime Registry therefore records `gpuBootVerified=false`, `gpuInferenceVerified=false`, and `fluxFirstImageVerified=false`.
- The marketplace guard now supports an explicit `CLORE_TARGET_GPU` and `CLORE_MIN_GPU_VRAM_GB` configuration. Defaults remain RTX 5090/32GB; Stage 3A used RTX 4090/24GB and permits only exact RTX 4090 API display values of at least 23GB when the field is non-precise/rounded.

## 2026-07-15 Stage 2.8J Runtime Hygiene CI Verification

- GitHub Actions run `29388852207` completed the only permitted chain in order: `runtime-hygiene-gate` -> `build-and-push` -> `verify-public-digest`. There was one `packages: write` job and one linux/amd64 build/push action.
- The verified public Runtime is `ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime:v0.1.4-runtime-hygiene-1eae628@sha256:187a7eb304075863dbd3f7a1b527530a06783ad8ea0fec5e51e2b9725d1bf137`. Anonymous digest pull, manifest platform validation, and no-model CPU smoke passed.
- The Runtime uses the canonical SQLite path `sqlite:////workspace/comfy-user/comfyui.db`. Its preflight creates and fsyncs the directory, checks a SQLite transaction, and fails closed as `database_preflight_failed`; CI verified creation, read/write, and restart reopening with no `unable to open database file` log.
- The inherited old digest contained `/app/worker.py` but did not run or reference it. The new image precisely removes that path; it is absent from the final rootfs. The inherited parent layer history can still contain the file, so `clean_base_rebase_required_before_production=true` remains recorded.
- The final anonymous verification passed controller/API/WebSocket checks, 347 node classes, required 17/17 with missing 0, empty-task `queue`/`history`/`interrupt`/`free`, structured missing-model rejection, loopback-only exposure, SIGTERM shutdown, static model/secret scan, and GPU no-device fail-closed (`gpu_preflight_failed`) without CPU fallback.
- `comfy-runtime/comfy-runtime.config.json` now fixes this digest in the Runtime Registry. The prior `sha256:2cb82ccfa722065b65649d34bca0deda11860e10be9169aeb60cb4d78f8af49a` is `partial-rejected`. `production_ready=false`: real RTX 4090 hardware startup is now permitted only as a separate no-model verification, while model download, inference, measurements, R2 cache, and production selection remain uncompleted.

## 2026-07-14 Stage 2.8B Production Minimal Node Profile Gate

- Added a `production_minimal` ComfyUI node profile generated from `comfy-runtime/workflows/official/manifest.json` and `comfy-runtime/comfyui-source-audit.json`. It keeps the base `nodes.py` classes plus only `comfy_extras/nodes_flux.py`, `nodes_images.py`, `nodes_model_advanced.py`, `nodes_video.py`, and `nodes_wan.py`.
- The profile explicitly excludes the currently suspect full-builtin path entries `comfy_extras/nodes_latent.py` and `comfy_extras/nodes_post_processing.py`. Full manual builtin loading remains `unverified` and is not the default or first benchmark path.
- Added `comfy-runtime/launch_comfy.py`, which patches `nodes.init_builtin_extra_nodes` in memory without modifying `/opt/ComfyUI` source files, verifies profile/source SHA values, and fails closed if required node classes are missing.
- `smoke_cpu` and `gpu` both default to `COMFY_NODE_PROFILE=production_minimal`. The Triton import blocker is limited to `COMFY_RUNTIME_MODE=smoke_cpu`; `gpu` mode requires `COMFY_GPU_PROFILE=rtx4090|rtx5090`, runs preflight before ComfyUI import, and fails closed without falling back to CPU.
- The GitHub Actions workflow now has a single-run `[node-profile] [skip build]` path: diagnose old digest `sha256:1cfb4740fb8b310a8095500e8fe55160176c619306068d553092182f4888efd1`, run D1-D4 diagnostics, and build exactly one new `v0.1.3-production-node-profile-<sha>` image only if the production-minimal CPU boot gate passes.
- No new Runtime digest has been marked verified in the Registry yet from this local checkpoint. RTX 4090 real startup, model downloads, image/video generation, VRAM/RAM/speed measurement, R2 model cache, and production model selection remain blocked until the CI smoke produces a verified digest.

## 2026-07-14 Stage 2.6 Anonymous Comfy Runtime Pull Gate

- The GHCR package `gouzhuoqunn/ai-creative-comfy-runtime` was changed to Public by the user while the source repository stayed private.
- Anonymous GHCR Registry API access now returns the fixed OCI index digest `sha256:d88dd518253f27ac8a7841d07b2e02c79a8cda0a940c85b9c579446f105c26bc`, and the index contains `linux/amd64`.
- Draft PR smoke run `29326808838` used only `contents: read`, did not log in to GHCR, skipped build and push, and anonymously pulled the fixed digest successfully after freeing runner disk space.
- The same run did not pass the no-model Runtime smoke: the container exited before controller health with `ExitCode=1`, not OOM, after logging only `starting ComfyUI runtime at commit da2608926eaf68fd532bba4e1ace3402c5d21399`.
- Because the no-model API/WebSocket/node smoke did not pass, `comfy-runtime/comfy-runtime.config.json` is not promoted to a verified digest state. RTX 4090 benchmark, model download, image generation, video generation, VRAM/RAM/speed measurement, R2 model cache, and production model selection remain blocked.
- The temporary Draft PR `#1` and base branch `ci/comfy-runtime-smoke-base` remain open for failure inspection. Remote `main` was not modified. No Clore order, SSH session, model download, GPU inference, or R2 model upload occurred.

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
- New scripts: `generation:runtime:test`, `generation:workflow:test`, `generation:ben…8447 tokens truncated…mpt cost about `0.34 USD`, below the `4.50 USD` cap.
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

## 2026-07-15 Phase 3E: Deployment Hold and First-image Recovery

- Clore deployment is locally paused with `CLORE_DEPLOYMENT_HOLD=true` state after three current orders (`1954464`, `1954484`, `1954507`) never entered running or published SSH/HTTP endpoints. Candidate and wallet reads remain available; every real create path fails closed while the hold is enabled.
- `npm run clore:support:export` generates sanitized files under `artifacts/clore-support/`. They contain only identifiers, safe payload booleans/ports, endpoint state, timing, observed spend and final active-order state; no keys, passwords, environment dumps, full SSH public keys, or raw create payloads.
- FLUX cache code uses `production/rtx4090/image/` staging objects, a revision manifest, then `current.json` last. The R2 boundary keeps admin credentials local and GPU credentials read-only.
- On 2026-07-15 the FLUX seed made no model upload: Hugging Face metadata HEAD succeeded, while the first actual ranged data connection timed out before a part was received. R2 admin and read-only boundary probes passed. `current.json` was not published.
- `GpuTarget`, `manual_ssh`, `gpu:first-image`, and `first-image:resume` provide a checkpointed recovery path. `manual_ssh` reads only `.secrets/manual-gpu-target.json`, does not manage payment/cancellation, and keeps host/key material outside Git.
- No new Clore order, SSH session, model inference, Runtime rebuild, or remote `main` update occurred. `production_ready` remains false.

## 2026-07-15 Phase 3I: FLUX Cache Published

- Fixed invalid job-level `runner.temp` expressions by exporting independent Qwen and VAE `HF_HOME` paths from `$RUNNER_TEMP` in executable steps. YAML parsing, DAG context regression tests, and actionlint passed before the remote run.
- GitHub Actions run `29431562820` started the existing FLUX verification, Qwen cache, and VAE cache jobs in parallel, then ran publish-and-verify only after all three succeeded. Total wall time was about 9 minutes 43 seconds. No Runtime image build ran.
- The existing FLUX object and newly cached Qwen/VAE objects total 12,451,817,860 bytes. Their exact sizes and SHA256 values are recorded in `docs/MODEL_CACHE.md` and `MODEL_CACHE_REGISTRY`. Qwen completed with the official Xet client and did not use HTTP fallback.
- Published revision `flux2-klein-4b-5b4408e59397-a9e4ca87c16d` has an independently read revision manifest and final `production/rtx4090/image/current.json` pointer. GPU read-only credentials passed GET, HEAD, and first/last Range probes; Put, overwrite, and Delete were denied.
- `gpu_restore_ready=true` and `r2_restore_plan_valid=true`. No Clore order, SSH connection, GPU inference, image generation, Runtime build, or model artifact in Git/Actions artifacts occurred. `gpu_inference_verified=false` and `production_ready=false`.

## 2026-07-16 Phase 3J: Second GPU Provider Preparation

- Added a unified `GpuProvider` contract with `clore`, `runpod`, and `manual_ssh` adapters. The first-image entry command no longer imports Clore order functions directly.
- Added a RunPod REST adapter for Pod list/create/get/stop/delete/recovery with 30-second request timeout, bounded 429/5xx retries, create idempotency, one-active-Pod enforcement, SSH readiness, post-create price enforcement, and a 15-minute termination Watchdog plan.
- Added a separate SSH bootstrap image inheriting the immutable Comfy Runtime digest. It adds only OpenSSH, accepts one public key, disables password login, exposes 22/tcp and 8080/http only, and does not automatically start GPU Runtime.
- GPU-side R2 recovery now uses two concurrent downloads, `.part` Range resume, streaming size/SHA256 checks, atomic rename, and no R2 administrator credential on the GPU.
- Added a two-hour presigned GET bundle generator and `notebooks/flux-first-image-colab.ipynb` as an emergency manual check. Colab is not part of automated provider rental and contains no long-lived credentials.
- `/generate/4090` can display Provider, GPU model, and generation duration from an archived first-image result without adding a database or changing image storage semantics.
- Local RunPod credentials are absent, so Stage 3J executed only mock tests and dry-run; no Pod, SSH session, GPU inference, model upload, model download, or provider charge occurred. Clore deployment hold remains enabled and live Clore active order count remains zero.
- The FLUX R2 cache remains ready at 12,451,817,860 bytes. `gpu_inference_verified=false`, `flux_first_image_verified=false`, and `production_ready=false` remain unchanged until a real GPU succeeds.
- RunPod bootstrap build run `29435088336` passed checkout, dependency install, static bootstrap tests, secret scan, Buildx setup, and GHCR login, then the hosted runner exhausted disk during the single build. GitHub recorded `No space left on device` while writing the runner diagnostic log. No `ai-creative-runpod-bootstrap` package, tag, or digest was created, so anonymous pull was not reached. A disk-reclaim step is prepared but was not executed because this phase does not permit a second actual build.

## 2026-07-16 Phase 3K: Direct RunPod Template and Budget-Gated Attempts

- RunPod now uses private template `ai-video-first-image-direct-v1` (`9lqpel7bc1`) with the fixed Comfy Runtime digest `sha256:187a7eb304075863dbd3f7a1b527530a06783ad8ea0fec5e51e2b9725d1bf137`. It overrides the image entrypoint with `/bin/bash -lc`, installs and starts OpenSSH as root from a public key, mounts a 30GB volume at `/workspace`, uses a 50GB container disk, exposes `22/tcp` and `8080/http`, and does not expose 8188. No bootstrap image build or Runtime build ran.
- Live RunPod `GET /templates` omits false-valued `isPublic` and `isServerless` fields. Validation now accepts omitted or explicit `false`, while still rejecting explicit `true`; every other returned template field matched the expected private Pod template.
- Two real Pod create attempts were the permitted maximum. Both were deleted before SSH because RunPod reported a post-create total hourly price above the configured 0.70 USD cap. The first attempt also exposed that create responses can omit price; the provider now waits up to 60 seconds for `GET Pod` to return a concrete price and fails closed when it remains unavailable or exceeds the cap. Active Pods returned to zero and no model transfer or provider session proceeded.
- The Watchdog is armed before create, records a Pod when price validation succeeds, terminates on parent exit/time/budget, and is now immediately disarmed when create-stage failure leaves no managed Pod. The first-image checkpoint remains at `candidate_selected`, so no completed restoration or generation stage can be falsely recorded.
- R2 remains ready at revision `flux2-klein-4b-5b4408e59397-a9e4ca87c16d` with all three verified objects totaling 12,451,817,860 bytes. No SSH, GPU hardware inspection, Runtime GPU boot, R2/HF model download, inference, PNG archive, or website result occurred. `gpu_inference_verified=false`, `flux_first_image_verified=false`, and `production_ready=false` remain unchanged.

