# Clore.ai GPU Rental Prep

## 2026-07-11 guarded real execution code

- Added guarded create/cancel execution helpers and local_lab integration, but real execution remains off by default through `CLORE_ORDER_EXECUTION_ENABLED=false`.
- `clore:create:dry` is still permanently dry-run and rejects `--execute`.
- `clore:create` can only reach real `create_order` with `--execute`, `--server-id`, `--max-price`, and `--confirm-project=ai-video-platform-wan22`, plus a true server-only execution flag.
- `clore:cancel` can only reach real `cancel_order` for the active project order after processing/upload checks and final video verification.
- A local lock prevents duplicate create calls, and `.secrets/clore-active-order.json` records the current project order state without secrets.
- Order body generation is SSH-only, on-demand only, and refuses secret-like environment fields.
- Added `docs/REAL_CLORE_EXECUTION.md` and `docs/EMERGENCY_GPU_SHUTDOWN.md` for the future real path and emergency stop flow.
- This checkpoint did not call real `create_order` or `cancel_order`, did not rent a GPU, did not spend balance, did not SSH, and did not download Wan2.2.

## 2026-07-11 cost-optimized session update

- Added dry-run session orchestration commands: `clore:session:plan`, `clore:session:dry`, `clore:session:status`, `clore:session:stop:dry`, and `clore:session:test`.
- The session state machine is: `idle`, `planning`, `order_pending`, `booting`, `restoring_model`, `starting_worker`, `ready`, `processing`, `draining`, `uploading`, `cleaning`, `canceling`, `stopped`, `failed`.
- No queued job can automatically create a Clore order. A future real session must be started explicitly by the user.
- Duplicate orders are prevented with ignored local state at `.secrets/clore-session-state.json` plus the project tag `ai-video-platform-wan22`.
- Drain starts at 5h30m; safety cleanup/cancel planning starts around 6h20m. Do not cancel while a job is processing.
- Cost defaults are 0.70 USD/hour and 6 hours, so a full session costs 4.20 USD. With an 11 USD balance and 1 USD reserve, the plan supports 2 full sessions.
- Clore API key stays only on the local developer machine. It must not be written into code or copied to the GPU server.
- The GPU server should receive limited Worker credentials only, plus optional read-only model cache credentials. It must not receive Supabase Secret keys, Clore API key, R2 write credentials, `.env.local`, or SSH private keys.
- This update did not call real `create_order`, rent a GPU, connect SSH, download Wan2.2, push an image, or deploy publicly.

## 2026-07-11 live read-only result

- Real Clore `wallets`, `marketplace`, and `my_orders` read-only API calls succeeded.
- Auth uses the Clore `auth` request header, not `Authorization: Bearer`.
- No request headers or raw full API responses are printed.
- Wallet summary: USD-like balance is 10.99; planning budget after a 1 USD reserve is 9.99.
- Active orders: none.
- Fully compliant RTX 5090 candidates: 0.
- Closest rejected candidate: server `95538`, RTX 5090, 31GB API-reported GPU memory, 128.7286GB RAM, 24 CPU cores, 970GB disk, 2070.14 Mbps down, 881.23 Mbps up, reliability 0.9997, rating 5.0 from 10 ratings, Canada, 14.99 USD/hour, 89.94 USD for 6 hours.
- Rejection reasons: GPU memory below 32GB and price above `CLORE_MAX_GPU_PRICE_PER_HOUR=0.70`.
- Minimum billing duration was not confirmed by the marketplace fields used in the sanitized summaries. The dry-run plan shows `API not confirmed`; a future real create must verify billing on Clore's confirmation screen.
- `clore:create:dry` rejects `--execute`. `clore:create` is the separated future real entry, but this checkpoint still refuses to call `create_order`.
- Sanitized fixtures are stored under `scripts/clore/fixtures/` and contain summaries only, not wallet addresses, API keys, request headers, host owner details, SSH private keys, passwords, tokens, or raw complete payloads.

## 2026-07-11 price unit and VRAM parser fix

- Clore on-demand USD marketplace fields such as `price.usd.on_demand_usd` are parsed as USD per 24 hours.
- The normalized hourly price is computed by dividing the original day price by 24.
- Example: server `95538` reports `14.99 USD/day`, which normalizes to about `0.624583 USD/hour`.
- The raw price amount, currency, unit, and normalized hourly price are all retained in candidate output and dry-run plan files.
- BTC/day and CLORE/day are not converted to USD/hour.
- Spot prices are not used for on-demand candidates.
- `platform_total_price=null` is reported as API not confirmed; no fee is guessed.
- Exact RTX 5090 candidates use a model-specific VRAM rule: advertised VRAM is 32GB, and API display values down to 30.5GB can pass only when the GPU model normalizes exactly to `NVIDIA GeForce RTX 5090`.
- Server `95538` reports `gpuram=31 display_gb`; this is accepted as API rounded/usable VRAM for an exact RTX 5090 and is preserved in the output.
- This does not relax memory checks for RTX 4090, 24GB cards, unknown GPUs, or renamed/imprecise models.
- Current compliant RTX 5090 candidate count: 1. Cheapest candidate: server `95538` at about `0.624583 USD/hour`.

## 2026-07-11 local_lab web console

- Added local_lab-only web API wrappers for read-only candidate and wallet summaries.
- The wrappers reuse the existing price normalization and RTX 5090 VRAM normalization logic.
- Returned candidate data is sanitized and does not include the Clore API key, raw marketplace payloads, wallet deposit data, SSH private keys, or signed URLs.
- Web order flow is still protected dry-run: first create an order plan with a short-lived nonce, then confirm with a risk checkbox and exact text.
- `CLORE_ORDER_EXECUTION_ENABLED=false` remains the default and blocks real order creation from the web UI.
- Session stop from the web UI calls the existing dry-run stop path and does not call `cancel_order`.

Current status:

- Clore.ai is the only primary GPU rental platform for this project.
- The user has registered Clore.ai and added about 11 USD of balance.
- `CLORE_API_KEY` is configured only in `.secrets/clore.env`; it is ignored by Git and must not be printed or sent to GPU hosts.
- Read-only Clore wallet, marketplace, and order-status queries have been verified against the real API.
- No Clore order has been created.
- No GPU has been rented, no Wan2.2 weights have been downloaded, and nothing has been deployed publicly.
- RunPod Secure Cloud is retained only as a last-resort fallback.
- The current application priority is `local_lab` mode. This round did not spend Clore balance.

## 2026-07-11 Read-only Clore result

- Wallet summary: `USD-Blockchain: 10.99`.
- Active order state: none found by `clore:status`.
- Marketplace scan: no compliant RTX 5090 candidate under the current safety and budget filters.
- Current hard cap: `CLORE_MAX_GPU_PRICE_PER_HOUR=0.70`.
- Assumed minimum rental window: 6 hours.
- Required 6 hour budget at the current cap: 4.20 USD.
- Closest strong rejected candidate observed: server `95538`, Canada, RTX 5090, API-reported GPU memory 31GB, 128.7GB RAM, 24 CPU cores, 970GB disk, 2070/881 Mbps network, reliability 0.9997, rating 5.0 from 10 ratings, 9.90 USD/hour, 59.40 USD for 6 hours.
- Rejection reasons for that candidate: GPU memory reported below 32GB and price above the configured cap/balance.
- Some cheaper RTX 5090 listings were observed, but they still exceeded the 0.70 USD/hour cap and failed reliability, rentability, GPU memory, or balance checks.

## Security Boundary

Clore is a P2P marketplace. It does not provide an equivalent "Secure Cloud" guarantee for this project. Host providers can have high infrastructure-level access, so the first real test must use synthetic prompts only.

Do not upload real user faces, sensitive media, `.env.local`, `.secrets/clore.env`, Supabase Secret keys, Clore API keys, SSH private keys, logs, or model weights from the local laptop.

The GPU host may receive only the limited Worker credentials from:

```text
.secrets/gpu-worker.env
```

The GPU host must never receive:

```text
CLORE_API_KEY
SUPABASE_SECRET_KEY
SUPABASE_SERVICE_ROLE_KEY
VAST_API_KEY
```

The Worker uploads final videos directly to the private Supabase `generated-videos` bucket. The temporary GPU job directory `/workspace/jobs` should be cleaned after each task and again before canceling an instance.

## Environment

`.env.example` contains placeholders only. A future real API key belongs only in:

```text
.secrets/clore.env
```

Example placeholder:

```env
CLORE_API_KEY=""
CLORE_MAX_GPU_PRICE_PER_HOUR="0.70"
CLORE_MIN_RENTAL_HOURS="6"
CLORE_ORDER_TYPE="on-demand"
CLORE_PROJECT_TAG="ai-video-platform-wan22"
```

Do not use `NEXT_PUBLIC_` for Clore variables.

## Marketplace Rules

Clore candidates must satisfy all of these filters:

- Exact RTX 5090, not 4090 fallback.
- Exactly 1 GPU.
- Currently rentable.
- On-demand only; spot is rejected.
- At least 64GB RAM, 8 CPU cores, 200GB disk, and 32GB GPU memory.
- Reliability at least 0.99.
- Rating at least 4.7 with at least 3 ratings.
- At least 300Mbps download and 100Mbps upload.
- On-demand USD hourly price no more than 0.70 USD.
- Docker custom image support.
- SSH support.
- Host driver must be compatible with CUDA 12.8 when this information is available.

Prices are accepted only when they are clearly USD hourly on-demand prices. BTC-per-day fields are not treated as USD hourly prices.

Candidates are sorted by USD hourly cost, lowest first, and the command shows at most 5 matches. If none match, the command reports rejection reasons instead of weakening requirements.

## Privacy Risk Tiers

Tier A:

- Reliability at least 0.995.
- Rating at least 4.8.
- Rating count at least 10.
- Network and disk data complete.
- Host is online.
- Country matches the allow list when an allow list is configured.

Tier B:

- Meets the minimum filters but does not reach Tier A.

Reject:

- Missing reliability or rating history.
- Reliability below 0.99.
- Serious network data gaps.
- Spot order.
- Ambiguous GPU model.
- Disk below minimum.
- Suspicious low price with incomplete data.

These tiers are a planning aid, not a guarantee that the host cannot inspect memory or disk.

## Commands

Local mock marketplace, no API key:

```powershell
npm run clore:find:mock
npm run clore:create:dry
npm run clore:cancel:dry
npm run clore:test
npm run check:clore-prep
```

Real read-only marketplace query after `.secrets/clore.env` exists:

```powershell
npm run clore:find
```

Future wallet read-only query:

```powershell
npm run clore:wallet
```

Status query:

```powershell
npm run clore:status
```

`clore:create:dry` prints `DRY RUN - NO ORDER CREATED` and does not call `create_order`. A future real create path must require `--execute`, `--server-id`, `--max-price`, and:

```powershell
--confirm-project ai-video-platform-wan22
```

This task does not implement or call real create execution.

Future cancellation must be dry-run by default, verify the local `.secrets/clore-active-order.json` state, and require explicit `--execute`. After cancellation, check the Clore order status and wallet balance to confirm compute billing stopped.

## Worker Deployment Shape

Recommended final mode:

- Custom prebuilt Docker image using the existing `gpu-worker/Dockerfile`.
- CUDA 12.8, PyTorch 2.7.1 cu128, Python 3.11.
- Wan2.2-TI2V-5B mounted at `/workspace/models/Wan2.2-TI2V-5B`.
- Jobs under `/workspace/jobs`.
- SSH only.
- No Jupyter, ComfyUI, Gradio, or public HTTP inference port.

First-test fallback mode:

- CUDA base image plus SSH: `nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04`.
- The image tag was verified through Docker Registry metadata for `linux/amd64`.
- Upload only `.secrets/gpu-worker.env`.
- Run `scripts/clore/bootstrap-worker.sh`, then `scripts/clore/start-worker.sh`.

Cleanup:

```bash
scripts/clore/cleanup-worker.sh
```

This removes temporary `/workspace/jobs` files only. It does not delete Supabase final videos.

## 2026-07-12 Live Read-only Candidate Check

The latest live read-only Clore query did not create or cancel any order.

- Active orders: none.
- USD-like wallet balance: `10.99`.
- Balance after 1 USD reserve: `9.99`.
- Qualified RTX 5090 candidates under the current hard filters: 3.
- Candidate order by normalized USD/hour: `107713`, `107921`, `95538`.
- Cheapest candidate: server `107713`, raw on-demand price `7 USD/day`, normalized `0.291667 USD/hour`, six-hour plan `1.75 USD`.
- Server `95538` remains valid: raw on-demand price `14.99 USD/day`, normalized `0.624583 USD/hour`, six-hour plan `3.7475 USD`, country `CA`, reliability `0.9997`, rating `5` with `10` ratings.
- Clore on-demand USD price fields must continue to be treated as USD per 24 hours and normalized by dividing by 24.
- RTX 5090 API display VRAM of `31 display_gb` is accepted only by the exact RTX 5090 model-specific rounded/usable VRAM rule. This is not a global lowering of the memory requirement.
- `platform_total_price` and minimum billing duration are still API-unconfirmed; verify the Clore confirmation screen before any real create.

Current real-execution blockers:

- `wrangler` was not found, so this machine cannot create or manage the Cloudflare R2 model cache yet.
- `docker` was not found, so this machine cannot build or verify-push the runtime image yet.
- `gh` was not found, so GHCR login/push cannot be completed yet.
- `.secrets/model-cache.env`, `.secrets/model-cache-admin.env`, and `.secrets/model-cache-readonly.env` are absent.

Because the custom public runtime image and private R2 model cache are not configured, do not run real `create_order` yet. The only real-create entry after those blockers are resolved remains:

```powershell
npm run clore:create -- --execute --server-id=<server_id> --max-price=<price> --confirm-project=ai-video-platform-wan22 --queued-jobs=<count>
```

Never use `clore:create:dry` for real execution; it is permanently dry-run.

## 2026-07-12 GitHub Actions Runtime Image Prep

The runtime image build path has been moved away from local Docker Desktop and into GitHub Actions.

- Local Docker Desktop is not required for the current plan.
- `.github/workflows/runtime-image.yml` is a manual `workflow_dispatch` workflow.
- It builds `gpu-worker/Dockerfile` for `linux/amd64` on GitHub-hosted Ubuntu.
- It runs `npm run secret:scan` before building.
- It logs in to `ghcr.io` with the repository `GITHUB_TOKEN`.
- It pushes immutable tags: a user-supplied version tag such as `v0.1.0-pre-gpu` and `sha-<commit>`.
- It enables SBOM and provenance.
- It must not publish `:latest` as the only reference and must not include Wan2.2 weights or secrets.

Current blocker: GitHub CLI OAuth did not complete in this environment, so the repository has not yet been created/pushed and the GitHub Actions build has not yet run. There is no GHCR image address or digest yet.

The Clore real create path must continue to refuse execution until a real GHCR image tag/digest is recorded and publicly pullable by Clore.
