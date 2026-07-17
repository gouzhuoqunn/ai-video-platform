# Project Context

## 2026-07-17 Stage 3W persistent Wan retry and bounded restore timeout

- Stage 3W adds a separate idempotent Wan-only retry task, `stage3o-video-wan-20260715-retry-1`, linked to the original failed video task. The completed FLUX task and original video failure remain immutable. The selected session plan contains only Wan restore, Wan inference, persistent WebM sync, MP4/thumbnail validation, and cleanup. A one-use local operator record carries the exact two-host-before-SSH, 0.35 USD failed-deployment, 2.00 USD total, and 150-minute wall-clock limits; the real execution enablement is scoped to the Stage 3W process.
- Local video staging is now failure-safe. The remote runner downloads to `source.webm.part`, verifies nonzero size plus the runner's exact size/SHA, atomically renames to `source.webm`, and does not delete the remote staged source before local conversion. `source.webm` is never automatically deleted. The repository-bundled ffmpeg and ffprobe produce and probe `output.mp4.part` as H.264/yuv420p/faststart, atomically publish `output.mp4`, select a seed-deterministic thumbnail time in the 10%-90% duration range, and atomically publish an aspect-preserving maximum 640x360 JPEG. Workflow, metadata, and Runtime evidence are written only after media validation. Local ffmpeg failure preserves its stderr and source; the same active host then has one remote ffmpeg conversion fallback before order cancellation.
- A synthetic WebM regression executes both bundled binaries and verifies version output, browser MP4 codec/pixel format/faststart, thumbnail bounds and determinism, `.part` atomic semantics, source preservation on success and failure, and the remote-fallback-before-cleanup contract. Retry idempotency preserves the image-completed/original-video-failed history and selects only the retry task. Real-response readiness, exact SSH parsing, `/workspace` inspection, live-session cleanup ordering, local Range serving, secret scan, and typecheck all pass. No UI source changed, so a Next build was not required.
- The real Clore order was `1958708` on preferred RTX 4090 server `29167`. Fresh marketplace price was 0.240625 USD/hour; the authoritative active-order billing price was 0.2291666667 USD/hour. The exact returned endpoint was `n1.de.clorecloud.net:1253`; project Ed25519 key-only SSH succeeded without password use. Hardware was RTX 4090 with 24,564 MiB VRAM, driver 550.144.03/CUDA 12.4, 67,051,868,160 bytes RAM, 32 vCPU, and 879,203,676,160 available workspace bytes. Docker was absent and the optional network probe failed, so the existing pinned native bootstrap was used.
- Native Runtime health passed with Torch 2.6.0+cu124, CUDA available on the RTX 4090, Triton 3.2.0, controller and ComfyUI health, readable SQLite, 347-node `object_info`, all Wan workflow nodes, history/queue parsing, and a remote-local WebSocket HTTP 101 handshake. No FLUX restore or inference was executed, and the existing image remained 1,664,899 bytes with SHA256 `989b436c8c0166793d12b58c7f0e6f70c81dbdc1b7cd847b12aa475ed010de81`.
- The only real retry failed during Wan R2 restore. The restore SSH command reached its 90-minute bounded timeout and returned exactly `stage3w_wan_restore_failed:spawnSync ssh ETIMEDOUT` before the restore script emitted its final per-file verification JSON. Consequently no current-session Wan inference ran, no remote WebM was staged, and no local `source.webm`, MP4, or thumbnail exists. The retry task is truthfully failed/retryable; the original failure history remains, and the image task remains completed.
- Cleanup stopped Runtime, canceled order `1958708`, confirmed Clore orders and RunPod Pods/volumes at zero twice (and again after the session), observed a stable 12.16 USD wallet, removed watchdog/create/SSH temporary state, and restored both provider holds. Wallet balance moved from 12.67 to 12.16 USD, a 0.51 USD session delta; provider elapsed billing estimated 0.380174 USD compute before cancellation. The Chinese local API preserved the one real image across refresh and a complete Next restart, returning the 1,664,899-byte PNG. Video results remain `hasVideo=false`/`hasThumbnail=false`, so no false playable result is shown. The real image loop is complete; the real video loop remains incomplete, with the exact remaining blocker being Wan R2 restore throughput exceeding the bounded SSH restore window.

## 2026-07-17 Stage 3V remote-host-local runner and first real image

- Comfy generation no longer depends on a client-side SSH tunnel. `/workspace/runtime-tools/comfy_remote_runner.py` uses only the GPU host's `http://127.0.0.1:8188` and `ws://127.0.0.1:8188/ws?clientId=...`, verifies `system_stats`/`object_info`, treats WebSocket as optional, submits `/prompt`, and polls `/history/{prompt_id}` plus `/queue` every two seconds. It detects structured history errors, stages the selected output under `/workspace/runtime-tools/results`, and emits one structured JSON result. A pre-model invalid-prompt probe verifies prompt validation and history/queue parsing. Local tunnel HTTP/WebSocket evidence remains separate and cannot fail Runtime or generation.
- The real Stage 3V order was `1958505` on preferred RTX 4090 host `29167` at 0.2291666667 USD/hour, using the exact returned endpoint `n1.de.clorecloud.net:1578`. The key-only automatic path authenticated the project Ed25519 key in 25 seconds; password authentication and key installation were not used. Hardware was RTX 4090 with 24,564 MiB VRAM, driver 550.144.03/CUDA 12.4, 32 vCPU, 67,051,868,160 bytes RAM, and 931,519,283,200-byte root/workspace filesystems. Docker was absent and the initial network probe lacked curl, so the existing pinned native bootstrap was used.
- Native bootstrap passed C/C++, Python headers, Torch 2.6.0+cu124 CUDA, Triton 3.2.0 import, and a real zero-error Triton vector-add probe. Controller/Comfy health, SQLite, 347-node `object_info`, and required nodes passed. The remote-host-local WebSocket returned HTTP 101; the optional tunneled WebSocket also passed on its second attempt.
- FLUX restored its three R2 objects with two resumable `.part` downloads, size/SHA verification, and atomic rename in 1,086,080 ms. The real 1024x1024, four-step, seed `20260715` inference completed without OOM fallback in 8,009 ms runner elapsed (6.71 seconds reported by Comfy). The decoded, non-black, non-single-color PNG is `D:\AI-Creative-Library\2026-07-16\stage3o-image-flux-20260715\output.png`, 1,664,899 bytes, SHA256 `989b436c8c0166793d12b58c7f0e6f70c81dbdc1b7cd847b12aa475ed010de81`. Workflow, metadata, Runtime evidence, and provider session records are archived beside it, and the image task is completed.
- Wan restored all three R2 objects with the same validation rules. The first restore SSH channel did not close after its remote process finished, so the local orchestrator was restarted against the same active order; resume accepted the already completed image and the video restoring state, revalidated/reused every Wan file, and did not regenerate the image or redownload models. The 832x480, 33-frame, 16fps remote Wan inference completed and its WebM reached a local temporary file, but local MP4 conversion called an unavailable PATH `ffmpeg`. The legacy helper omitted the spawn error and the temporary WebM was then removed, so no playable MP4 or thumbnail survived after the order cleanup. The video task truthfully remains failed with `wan_mp4_conversion_failed`, while the image remains completed.
- At the end of Stage 3V, video archiving resolved the repository-bundled ffmpeg binary and reported spawn errors, but its first implementation still removed `source.webm` after successful conversion. Stage 3W supersedes that behavior with permanent source preservation and remote conversion fallback. No second GPU order was created for the Stage 3V post-cleanup fix.
- The local image results API returned the archived PNG with the expected metadata on initial Next startup, refresh, and a complete Next restart. SHA256 and modification time stayed unchanged, proving resume/refresh did not regenerate it. The video results API truthfully reports `hasVideo=false` and `hasThumbnail=false`.
- Cleanup stopped Runtime, canceled order `1958505`, confirmed zero Clore/RunPod resources twice, observed a stable 12.67 USD wallet, disarmed remote/local watchdogs, cleared temporary SSH/password state and locks, and restored both provider holds. The wallet moved from 13.05 to 12.67 USD, for 0.38 USD total session spend. The real image loop is complete; the real video loop remains incomplete only because the generated WebM was not preserved through the local conversion failure.

## 2026-07-16 Stage 3U verified host compiler gate and WebSocket blocker

- Stage 3U hardens the native Clore bootstrap with one minimum apt transaction containing build-essential, gcc/g++, make, libc6-dev, linux-libc-dev, generic and active-version Python development headers, python3-venv, git, curl, CA certificates, pkg-config, cmake, ninja-build, and ffmpeg. ComfyUI cannot start until ordered probes verify stdlib.h, stdio.h, the sysconfig include directory, Python.h, compiled C/C++ executables, Torch CUDA on RTX 4090, Triton import, and a real Triton GPU vector-add kernel.
- Probe evidence records exact commands, timestamps, exit codes, and sanitized output. A classified missing package/path gets one in-place correction and only the failed probe is rerun. Runtime startup separately captures full logs, applies one same-host toolchain/cache correction, and retries once before cleanup.
- The real Stage 3U order was `1958422` on known host `29167` at 0.2291666667 USD/hour, using the exact returned endpoint `n1.de.clorecloud.net:1754`. Dedicated-key SSH succeeded in 26 seconds without password authentication. The host was RTX 4090 with 24,564 MiB VRAM, driver 550.144.03/CUDA 12.4, 32 vCPU, about 62.45 GiB RAM, and about 867.5 GiB workspace capacity; Docker was unavailable, so native bootstrap was used.
- Native preparation completed in about 441 seconds. Every compiler/Triton probe passed on its first run: `/usr/include/stdlib.h`, `/usr/include/stdio.h`, `/usr/include/python3.12`, Python.h, C, C++, Torch 2.6.0+cu124 CUDA, Triton 3.2.0, and GPU vector-add with zero maximum error. ComfyUI/controller health, SQLite, object_info, and required nodes also passed on the first health poll.
- The remaining execution blocker was the first local SSH-tunnel WebSocket handshake failing immediately after health passed. The order was then cleaned up by the existing exception path before any FLUX R2 restore. Tunnel verification now waits for loopback `/system_stats`, supplies a client ID, and retries the WebSocket up to three times. This change is locally verified but not yet rerun on a GPU.
- No FLUX or Wan object was restored and no image/video was generated. Both task records remain failed without false completion. The wallet moved from 13.20 to 13.05 USD. Final Clore orders, RunPod Pods/volumes, watchdogs/watchers, and create locks are zero; both provider holds are enabled and R2 caches are preserved.

## 2026-07-16 Stage 3P one-use operator retry and single Clore outcome

- Stage 3P adds a separate `clore:deployment:operator-retry` command. Its ignored record contains only creation/expiration times, the exact one-attempt/0.20 USD failed-deployment/2.50 USD session limits, a random nonce, and SHA256 integrity. It does not claim Clore support recovery. A valid support acknowledgement remains preferred; the operator record is a one-use fallback.
- The operator record is renamed atomically from available to consuming inside the existing create lock, after a fresh active-order/marketplace/wallet/price/budget recheck and immediately before the real `create_order` request. It is renamed consumed after that one request whether the request succeeds or fails. Pre-request API scheduling failures do not consume the record or host attempt.
- Stage 3P permits one Clore host attempt, excludes every known failed server ID, requires on-demand >=20GB VRAM, >=32GB RAM, >=150GB disk, <=0.70 USD/hour and <=2.50 USD projected total, and ranks GPU class followed by reliability/rating/network before price. SSH readiness is capped at 12 minutes and shortened when necessary to preserve the 0.20 USD failed-deployment budget.
- The selected host was RTX 4090 server `101767`, reliability `1`, rating `4.94`, 93.27/97.74 Mbps, at 0.170833 USD/hour. The real order was `1957188`. The create response initially omitted the numeric order ID; the local mapping was corrected from its legacy random fallback, and code now polls the live order list and refuses unresolved/non-numeric IDs instead of inventing one.
- Order `1957188` never reported Running or a usable SSH endpoint and was canceled after the single bounded wait. The exact failure is `order_never_running`. No SSH/hardware inspection, Runtime/overlay start, FLUX restore, image inference, Wan restore, video inference, or local media sync occurred.
- The USD-like wallet moved from 13.75 to 13.60 USD, so the Stage 3P failed-deployment spend was 0.15 USD. Final Clore orders, RunPod Pods/volumes, watchdogs/watchers and create locks are all zero; both provider holds are enabled. The operator override is consumed, R2 caches remain intact, and both Stage 3O tasks persist as separate failed records (image `order_never_running`, video `image_prerequisite_failed`).
- A resume-only gate now permits the already consumed override solely when the same locally recorded active order has attempt count 1 and the watchdog/billing state matches. It cannot call `create_order` again. Remote watchdog arming also waits for a fresh heartbeat for the selected server before creation.

## 2026-07-16 Stage 3O guarded image-plus-video session preparation

- Stage 3O has a fixed, idempotent real task-pool fixture named `stage3o`: one immediate FLUX image task (`1024x1024`, 4 steps, seed `20260715`) followed by one immediate Wan task (`1280x704`, 41 frames at 16fps, about 2.56 seconds, seed `20260715`). Re-running preparation reuses the fixed task IDs and does not debit credits or duplicate work.
- `clore:support:acknowledge` writes only a ticket/reference ID, acknowledgement time, optional numeric recommended server IDs, and SHA256 of locally sanitized support response text to ignored `.secrets/clore-support-incident-ack.json`. It rejects missing confirmation, missing ticket/response file, unsafe billing state, active resources/locks, malformed records, and records older than seven days; it never stores the response text or personal contact details.
- The single remaining manual action is `npm run clore:support:acknowledge -- --ticket=<id> --response-file=<local-text-file> --confirm-platform-recovered` (optionally add `--recommended-server-ids=<id,id>`). The response file is read locally only and is not copied into the repository or acknowledgement record.
- `generation:live-session -- --provider=clore --batch=stage3o` fails closed before any resource operation unless the support acknowledgement is valid. Its preflight then verifies zero billing, both holds, the exact armed batch, FLUX/Wan readonly current pointers and object totals, and executable workflows.
- The live plan permits at most two Clore on-demand host attempts, ten minutes to SSH per host, at least 20GB VRAM/32GB RAM/150GB disk, at most 0.70 USD/hour, 0.40 USD failed-deployment spend, 2.50 USD total spend, and 150 minutes. Support-recommended server IDs rank first; the existing light bootstrap, Ampere overlay, request limiter, and watchdog remain authoritative.
- The ignored live checkpoint records the exact image -> image sync -> FLUX unload -> Wan restore -> video -> output sync -> Runtime stop -> order cancel sequence. FLUX and Wan use temporary read-only GET URLs, two parallel resumable `.part` transfers, size/SHA verification, and atomic rename. A Wan failure preserves the successful image and records a separate video failure.
- No valid support acknowledgement currently exists. Stage 3O preparation therefore keeps Clore and RunPod holds enabled and must not create an order or SSH session until the user records the single support response action.

## 2026-07-16 Stage 3N shared generation pool and verified Wan cache

- Image and video requests now share one persistent local task pool. Normal image work arms at 3 queued tasks and normal video work arms at 2; an explicit immediate action may arm a smaller homogeneous batch. A single planned GPU session processes image work, unloads image models, processes video work, and then stops. Mixed-model inference is never concurrent.
- The persistent scheduler records the selected batch and task IDs for restart idempotency. Its market watcher is read-only, polls no faster than once per minute, backs off after 30 minutes, filters GPU compatibility and VRAM before ranking reliability/rating and projected cost, and records rejection reasons. Both Clore and RunPod deployment holds remain enabled.
- The local Chinese studio displays queued, armed, market-watching, provisioning, running, completed, failed, and canceled states; thresholds, remaining counts, hold state, market state, rejected-host reasons, and maximum projected cost are visible. Canceling an existing video task still uses the established refund RPC.
- Wan cache run `29470206635` succeeded in 440 seconds. Three independently downloaded and SHA256-verified objects totaling 18,144,966,705 bytes were published only after all cache jobs succeeded. The immutable revision manifest, current pointer, and read-only HEAD/range checks passed. No GPU order, Pod, SSH connection, Runtime build, or inference was started.
- `comfy-runtime/model-availability.json` is the single model gate. Wan restore is now ready but inference remains unverified; FLUX remains cached/restore-ready from its existing cache while real inference remains unverified. Scheduler selection fails closed for models without an executable workflow and verified restore path.
- Deployment resume is guarded by the exact `--confirm-platform-recovered` flag plus zero active orders, no create lock, an armed model-ready batch, and a local incident acknowledgement. Pause enables the hold and drains an active session without bypassing the existing watchdog budget. The generated sanitized support package covers all 11 known failed orders without inventing unknown values.

## 2026-07-16 Stage 3M Clore-only bootstrap, bounded attempts, and Wan cache dispatch

- Automatic rental now resolves to Clore only. RunPod has a separate ignored deployment hold and remains read-only for inventory/cleanup checks. Clore candidates accept CUDA capability 8.0+ image GPUs (including RTX 4090/5090, A40, A6000, and RTX 3090-class hosts) with at least 20GB VRAM, 32GB RAM, 120GB disk, on-demand pricing, effective hourly price at most 0.70 USD, and a 3.5-hour projection at most 2.50 USD.
- The lightweight order profile uses the official public `cloreai/jupyter:ubuntu24.04-v2` image, verified as linux/amd64 at manifest digest `sha256:0586bbd2c26a8bcfd194d9d022ce4966ede23b3a743471032069c1f2ed2abc27`. Orders expose only `22/tcp`; Runtime code/config are delivered as a small overlay after SSH rather than by rebuilding the permanent Runtime image.
- The Ampere overlay recognizes compute capability 8.0+ with at least 20GB VRAM, uses FP16 below capability 8.9, enables CPU offload below 24GB, and preserves the existing RTX 4090/5090 paths. It can bootstrap either the fixed Runtime Docker image or a native pinned ComfyUI checkout.
- Exactly three Clore hosts were attempted with a 10-minute SSH publication limit: `105175`/order `1955984`, `105181`/order `1956022`, and independent host `29169`/order `1956054`. Each order remained outside `running`, never published SSH, and was canceled after 611/606/606 seconds. No host reached hardware inspection, overlay installation, Runtime boot, R2 restore, inference, or result sync.
- Stage 3M Clore spend was 0.48 USD; wallet balance changed from 14.23 to 13.75 USD. Final Clore active orders, RunPod Pods, and RunPod network volumes are all zero. Both deployment holds are enabled, the remote Watchdog is disarmed, and the local scheduled Watchdog is disabled.
- The FLUX R2 revision and its 12,451,817,860 verified bytes were preserved without download or mutation. No PNG was generated, so `gpu_inference_verified`, `flux_first_image_verified`, and `production_ready` remain false.
- Wan cache workflow run `29446260840` was triggered once and failed workflow parsing before any job because job-level `runner.temp` is invalid. The workflow now exports isolated `HF_HOME` values from `$RUNNER_TEMP` in a step, but Stage 3M deliberately did not retry. Zero Wan objects were uploaded and no multipart upload began; the existing FLUX cache was unchanged.
- The local studio now has a persistent Chinese `图片`/`视频` switch. Image mode shows first-image state and local archived PNGs; video mode keeps the existing task/video flow. `立即生成` may arm Clore only when a compliant host exists, while normal batch auto-rent waits for the configurable threshold (default 3).

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

## 2026-07-16 Phase 3R: Clore Manual-Parity Readiness Repair

- Manual order `1957892` / server `28726` is the sanitized golden control: `cloreai/jupyter:ubuntu24.04-v2`, UI `Active` plus `Deployed`, exact SSH `root@n1.msk.cloreai.ru:1584`, password SSH success, RTX 4070 SUPER, driver 550.90.07, CUDA 12.4, Python 3.12.3, no Docker, and closed API spend `0.02130763888888889` plus the creation fee. No password is stored in Git.
- Closed Clore orders do not retain `pub_cluster` and clear `tcp_ports`. Active readiness now treats `mon_container=2` as deployed, reads the exact `pub_cluster` host and mapped TCP port, accepts exact structured endpoint or SSH command forms, and never constructs a hostname from a server id or assumed domain suffix.
- Readiness distinguishes `order_not_deployed`, `deployed_without_ssh_endpoint`, `ssh_tcp_unreachable`, `ssh_auth_failed`, `ssh_ready`, and `runtime_failed`.
- The Stage 3R create profile mirrors the successful web order: password-only minimal payload, official Jupyter image, on-demand, and only port 22/tcp. It omits env, command, public key, `required_price`, and autossh fields. A temporary strong password stays under ignored `.secrets`, is used only by askpass, and is deleted during cleanup.
- Project ED25519 private/public key matching is verified offline with `ssh-keygen -y`; only key type, line-ending class, match status, and a fingerprint suffix may be printed. Windows OpenSSH askpass uses `node.exe` with a local preload helper because `.cmd` askpass launchers fail through `CreateProcessW`.
- Real order `1958009` / server `105169` became ready in 35 seconds on an API-provided `clorecloud.net` endpoint. Password authentication, project-key installation, and key authentication all succeeded in the same order. This proves Clore was not globally down and the automatic endpoint/auth path is repaired.
- Two real host attempts were the allowed maximum. Order `1957995` cost `0.12306666666666667` including its creation fee; order `1958009` cost `0.10756979166666667` including its creation fee; combined observed cost was about `0.23063646`, below the `0.40` failed-attempt cap and `2.50` session cap.
- Image/video inference did not run. After SSH success, order `1958009` was closed because the hardware audit assumed `/workspace` already existed. The audit now creates `/workspace` before checking its filesystem, but no third order was created. `gpu_inference_verified=false`, `flux_first_image_verified=false`, and `production_ready=false` remain unchanged.
- Final cleanup verified Clore active orders 0, RunPod Pods 0, RunPod volumes 0, watchdog/process counts 0, both provider holds true, and no create lock.

## 2026-07-16 Stage 3S: Automatic SSH Session Attempt

- Stage 3S began with Clore active orders 0, RunPod Pods/volumes 0, both provider holds enabled, no watchdog/watcher/create lock, and ready FLUX and Wan R2 pointers. A one-use operator override limited the run to two hosts, 0.40 USD failed-deployment spend, 2.50 USD total spend, and 180 minutes.
- The first automatic order was `1958175` on RTX 4090 server `105178` at about 0.23291667 USD/hour. The second and final order was `1958208` on RTX 4090 server `29167` at about 0.22916667 USD/hour. The API returned `n1.de.clorecloud.net:2060`; the endpoint was used exactly and never reconstructed.
- With the manual-parity payload containing both `ssh_key` and `autossh_entrypoint=true`, Clore installed the supplied public key but did not permit password authentication. Readiness now records the observed password/key results instead of assuming all three steps succeeded, and accepts verified key auth when password auth is disabled by that profile.
- Clore proxy host/port pairs can be reused by a later order with a different host key. Readiness now removes only the exact `[host]:port` entry from the dedicated project known-hosts file once per newly returned endpoint, then retains `StrictHostKeyChecking=accept-new` for the fresh key.
- The second host reached deployed state, TCP, and key-based SSH. `/workspace` was created. Hardware inspection then stopped before Runtime bootstrap because the pristine Jupyter host did not yet have PyTorch, while the audit imported `torch` unconditionally. The audit now records `torch_present=false` and continues so host-mode bootstrap can install the pinned runtime packages.
- The explicit post-SSH failure rule prevented a third host. FLUX and Wan files were not restored, no image or video was generated, no local media/UI completion was claimed, and the prepared real tasks remain failed with the exact prerequisite error.
- Final cleanup canceled both orders, removed temporary SSH/password target state, disarmed the watchdog, disabled its scheduled task, restored both provider holds, and confirmed twice that Clore orders, RunPod Pods, and RunPod volumes were zero. The USD wallet stabilized at 13.37 after starting at 13.45.
- `gpu_inference_verified=false`, `flux_first_image_verified=false`, `production_ready=false`, and the real video loop remains incomplete.

## 2026-07-17 Stage 3X: Production Model Lock and Token Gate

- The production defaults are now `ultrareal-flux1-dev-fp8` for images and `wan22-remix-14b-i2v-fp8` for image-to-video. RTX 4090 and RTX 5090 share each family’s exact weights; there are four execution profiles but only two R2 object families.
- The Civitai API audit is recorded in `benchmark/stage3x/civitai-model-audit.json`. UltraReal selects V4 file `1320644`, the full SafeTensor FP8 FLUX.1 Dev checkpoint with SHA256 `4e675980...28c18e`. Wan selects the matched I2V A14B V3 high/low files `2657128` and `2657705`; T2V, GGUF, FP16 alternatives, and mixed generations are not production candidates.
- UltraReal uses the creator’s DPM++ 2M, 50-step, beta-scheduler guidance. Wan uses the official two-expert I2V graph with a step-10 expert switch, a real input image, 832x480/33-frame conservative RTX 4090 profile, and 1280x704/41-frame RTX 5090 profile.
- New R2 prefixes use immutable SHA-addressed objects, revision manifests, and `current.json` published last. The GPU host fetches the current pointer, manifest, and objects directly through short-lived read-only URLs with parallel `.part` resume, size/SHA validation, atomic rename, per-object timeout, heartbeat, and local progress JSON. R2 administrator credentials never go to the GPU.
- `flux2-klein-4b` remains `legacy_verified`; `wan22-ti2v-5b` remains `legacy_cached`. Their existing R2 caches are preserved but neither is a production default.
- The local single-user prompt gate rejects sexual content involving minors and non-consensual sexual activity. The Wan family is recorded as `adult_model=true`; the main UI shows the neutral model/profile/cache metadata without promoting the source-site content rating.
- No `CIVITAI_API_TOKEN` was present in `.secrets/civitai.env`, the process environment, or GitHub Actions secrets. Therefore no GitHub cache run was dispatched, no GitHub secret was changed, no model was downloaded, and no GPU/provider resource was created.
- Manual credential completion steps:
  1. 在 Civitai 账户的 API Keys 页面创建只用于本项目的 token。
  2. 新建本地忽略文件 `.secrets/civitai.env`，仅写入 `CIVITAI_API_TOKEN=<token>`，不要提交到 Git。
  3. 运行 `npx tsx scripts/model-cache/production-model-cache.ts credential-gate`，确认精确凭证门通过。
  4. 将同一个 token 添加为当前 GitHub 仓库的 Actions secret `CIVITAI_API_TOKEN`；同时确认已有授权的 `HF_TOKEN` 与六个 R2 secrets 均存在。
  5. 只手动触发一次 `Stage 3X production model cache` workflow。两个族全部下载、SHA/大小验证、R2 HEAD/Range 验证并最后发布 `current.json` 后，再把 `model-availability.json` 的对应 `cached` 和 `restoreReady` 改为 `true`。
- Until those manual steps succeed, both production model gates fail closed with `metadata_locked_token_blocked`; the UI may create pending local tasks, but the scheduler cannot create a paid order.

## 2026-07-17 Stage 3Y: Cache Credential Gate and Final-model Preflight

- Stage 3Y remained non-billable. Preflight confirmed Clore orders `0`, RunPod Pods/volumes `0/0`, watchdog/watcher/create lock `0`, both provider holds `true`, and a clean worktree before implementation.
- `.secrets/civitai.env` now exists with a non-empty `CIVITAI_API_TOKEN`. Authenticated HEAD checks succeeded without downloading weights for UltraReal file `1320644` and Wan Remix files `2657128` and `2657705`; all returned HTTP `307` and retained the exact Stage 3X sizes and SHA256 locks.
- Public auxiliary access succeeded for CLIP-L, T5XXL, UMT5, and Wan VAE with HTTP `302`. The locked FLUX VAE `black-forest-labs/FLUX.1-schnell@741f7c3ce8b383c54771c7003378a50191e9efe9:ae.safetensors` returned HTTP `401`. Its exact size is `335304388` and SHA256 is `afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38`.
- The Civitai token was added to the current repository as the GitHub Actions secret `CIVITAI_API_TOKEN` through stdin. All R2 admin and readonly secret names remain present. No local `HF_TOKEN` exists and the repository does not have an `HF_TOKEN` secret, so the production cache workflow was intentionally not dispatched.
- Required user action: accept the FLUX.1-schnell repository terms while signed into the intended Hugging Face account, create a read token for that account, store it locally as `.secrets/huggingface.env` with `HF_TOKEN=<token>`, and add the same value to the repository Actions secret `HF_TOKEN` through stdin. Then rerun the Stage 3Y access gate before triggering the cache workflow.
- The single cache workflow is prepared with a 75-minute timeout, non-canceling concurrency, two parallel family jobs, per-family parallel downloads, Civitai Authorization headers, Hugging Face Xet, full size/SHA verification, AWS SDK multipart upload, immutable SHA object keys, independent manifest/current-last publication, and a final readonly verification job that depends on both families. No model weights use GitHub artifacts.
- Production `current.json` now binds the full revision manifest SHA. Object uploads carry SHA metadata; verification reads first/last byte ranges. The readonly verifier checks current, manifest SHA, every object HEAD/ranges, and denial of write, overwrite, and delete.
- The no-GPU direct-restore preflight verifies exact R2-to-ComfyUI paths, direct host downloads, parallelism `3/4`, independent heartbeat, stall timeout, reconnect/resume, `.part` atomic rename, size/SHA rejection, and required free disk. Workflow structures and the RTX 4090/5090, RAM `>=32GB`, disk `>=200GB`, On-Demand-only policy are ready.
- Because the locked FLUX VAE is not accessible and neither production R2 pointer has been published, both production entries are `metadata_locked_aux_auth_blocked`; `ultrareal_cache_ready=false`, `wan_remix_cache_ready=false`, `production_gpu_restore_ready=false`, and `final_model_session_ready=false`. The Chinese UI correctly remains at “等待凭证”; it was not falsely changed to “缓存已就绪”.
