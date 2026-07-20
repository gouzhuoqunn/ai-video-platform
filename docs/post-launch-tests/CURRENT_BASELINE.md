# 当前基线

- 分支：`codex/stage4g1-long-video-prompts`；Stage 4I 开始时 HEAD：`34262c7a963c3f9831c0ccfed2080b614a9f513a`。
- 历史长视频项目：`8fff4d9f-39f6-4aee-a02a-d0a6376e4f8b`，状态 failed/retryable，`nextSegmentIndex=1`。
- segment 0 已接受并保留；PNG 尾帧 SHA-256：`d5d2bccdfa9839e6f420920d6f0ec64482dd1021004c60ad97610e76f3100f77`。segment 1/2 没有尝试，禁止重新生成 segment 0。
- 已验证 RTX 4090：UltraReal image 1024×1024；Wan Remix video 832×480、33 帧、16fps。运行时 Torch 2.6.0+cu124、Triton 3.2.0、CUDA 12.4。
- 当前模型 revision：`civitai-1413133-file-1320644`、`civitai-2770795-2771407-v3`。
- 零状态预期：Clore active orders=0；RunPod Pods/Volumes=0/0；provider holds=true；无 watcher/watchdog/create lock；无活动授权。
# Stage 4J.1 checkpoint (2026-07-18)

- The final RTX5090 batch was prepared but did not complete paid acceptance. It contains two image jobs (`1536x1024` and derived `2048x2048`) and one 10-second project with two `81`-frame segments at `1280x720` generation and `1920x1080` finalization metadata.
- Exactly one real Clore create attempt was made on RTX5090 server `85138` under the `$3.00`/300-minute guard. Workspace SSH authentication failed (`Permission denied (publickey,password)`), so the guarded path canceled the same order before runtime/bootstrap/model restore. No media was generated.
- Final resource state is Clore orders `0`, RunPod Pods/volumes `0/0`, provider holds enabled, watchdog disarmed, and no create lock. The prepared batch remains for manual handoff; `production_ready=false`, `long_video_pipeline_gpu_verified=false`, and `normal_ui_pipeline_gpu_verified=false` remain unchanged.

# Stage 4J.2 checkpoint (2026-07-18)

- Exact failed phase: `ssh_public_key_rejected_at_workspace_contract_prepare`; underlying provider injection versus then-unproven local key-path mismatch remains evidence-insufficient.
- Canonical identity: `ssh-ed25519`, fingerprint `SHA256:DxIZMV2kAajL8dJqG8fxId+sYI+54SE2Un1+aIy+MZc`, private-key identifier `clore_ai_video_worker_ed25519`, public source `derived_from_private_key`.
- Future order creation sends only that derived normalized key, validates fingerprint equality immediately before create, and never reads the sidecar `.pub` as the order credential source.
- Clore key transport is deterministic across readiness, workspace, SCP, Runtime, and cleanup: exact endpoint, order-scoped known-hosts, `root`, `IdentitiesOnly=yes`, disabled agent, key-only BatchMode, bounded timeout, and no SSH TTY.
- Future password fallback is order-bound, explicit in `ssh_password`, key-first, one-attempt, authorized_keys-repair-only, and deleted during cleanup.
- Prepared batch remains two RTX5090 image jobs plus one two-segment 10-second project; duplicates `0`, short-video jobs `0`.
- `stage4j2:plan` passes with provider mutations `0` and paid execution unauthorized. Read-only provider status remains Clore `0`, RunPod `0/0`, both holds `true`, no remote watchdog/process/create lock. All still-valid Stage 4J.1 authorization files were revoked and the local watchdog task was disabled.
# Stage 4J.3 checkpoint (2026-07-19)

- Branch baseline was `codex/stage4g1-long-video-prompts` at `baeb5f8c4866f8379ecdee8f2e3955dc6db9b3e1`; backup ref `backup/stage4j3-final-5090-20260719-005911` preserves it. Main was not touched.
- The one authorized paid order is consumed and canceled. Clore order `1962381`, RTX5090 server `85138`, exact endpoint `root@n1.de.clorecloud.net:1439`, On-Demand base `$0.31125/hour`; wallet `$11.24 -> $10.72` (`$0.52` delta).
- RTX5090/Blackwell passed: capability `12.0`, `sm_120`, Torch `2.7.1+cu128`, CUDA `12.8`, Triton `3.3.1`, real CUDA/Triton operations, required nodes, controller/ComfyUI, ffmpeg/ffprobe, RAM, VRAM, and disk.
- The two prepared images are completed and local: `1536x1024` medium SHA `c79c99476486fdcd83dbdc0cb7e90e2961ebdda85fe556a1c1a10be2558e6078`; derived `2048x2048` high-final SHA `d3b12a75c5b30086f2dec902d4d9e7e38f8418a8436c64cbca97d765623b32ac`.
- Project `a6cbf8c1-f158-4583-8f40-fa524dddd9d1` is truthfully `failed`, `nextSegmentIndex=1`. Segment 0 is accepted with exactly one attempt and a preserved 1280x720/81-frame/16fps/5.0625-second MP4; segment 1 has zero attempts. No 10-second master or 1080P final exists.
- The detached remote workflow return fix is implemented and offline-tested, but no second paid order was created. A future task requires fresh explicit authorization to resume segment 1 only; it must not regenerate segment 0 automatically.
- Current readiness: RTX5090 hardware and both image levels verified; final 720P long video, 1080P final, tail-frame chain, daily-use closure, and production readiness remain false.

# Stage 4J.4 checkpoint (2026-07-19, zero cost)

- Start HEAD was `55e7ab5d5e69f41a85ae0564033a40d7f5bb4318`; backup ref is `backup/stage4j4-before-layout-runner-fix-20260719-033915`. Main was not touched.
- Studio desktop layout is now flexible-main plus permanent 320px independently scrolling sidebar. Preview is 42vh with a 480px cap. Task columns are 8/6/4/2/1 at the documented responsive boundaries.
- Image mode contains only image tasks. Video mode contains short-video tasks and long-video projects together; the short/long switch changes only the creation editor, and every video selection updates the shared preview.
- Runner completion/status/result are separate bounded channels. The real detached PID, atomic JSON, exit code, terminal marker, completion sentinel, and deterministic attempt ID support recovery without a duplicate attempt.
- Final partial boundary is unchanged: image jobs `d3573f65-1400-4a27-9bcf-4ff6f8f34273` and `8cdc12f3-cc75-43dc-ae49-423071389f07` are reused; project `a6cbf8c1-f158-4583-8f40-fa524dddd9d1` remains failed at `nextSegmentIndex=1`; segment 0 attempt `b94faa26-e434-4c38-a67c-bacbb3bd51a6` is accepted; segment 1 `554adaa8-fc5f-40c3-a02b-331eabcd23c8` has zero attempts.
- Current plan flags remain `image_jobs_to_generate=0`, `segment_0_inference_required=false`, `video_segments_to_generate=1`, `expected_provider_orders=1`, and `paid_execution_authorized=false`. Proposed future wallet cap is `$1.25`.
- Stage 4J.4 provider mutations and spend are zero. Expected zero-resource state remains Clore `0`, RunPod `0/0`, both holds `true`, no authorization, create lock, watchdog, or watcher.

# Stage 4J.8 completed baseline (2026-07-19)

- Feature start HEAD: `66af63c4e0dfd13a4a7621579243e524b030c121`; backup: `backup/stage4j8-before-final-throughput-resume-20260719-173956`. Main is unchanged.
- Completed images remain unchanged: 1536×1024 medium SHA `c79c99476486fdcd83dbdc0cb7e90e2961ebdda85fe556a1c1a10be2558e6078`; derived 2048×2048 high SHA `d3b12a75c5b30086f2dec902d4d9e7e38f8418a8436c64cbca97d765623b32ac`.
- Project `a6cbf8c1-f158-4583-8f40-fa524dddd9d1` is `completed`, `nextSegmentIndex=2`, with accepted attempt counts exactly `1/1`. Tail-frame linkage SHA is `6260f7149b352bb4f337d8ce9a63f16f169e28c61e11052590e653e342cfb77a`.
- Final local media root: `D:\AI-Video-Library\2026-07-18\a6cbf8c1-f158-4583-8f40-fa524dddd9d1`. The 720P master is 1280×720, 10.125 seconds, SHA `95c02008a67d671a92c82f816e44852f3547ad032917957252604e4e87de5c74`. The final is 1920×1080, 10.125 seconds, SHA `befbf0ca3ac59743e81d9cf0fe2a1546616f0d264510e526c9504aeee30f5a9b`.
- Paid result: one successful order, one create request, one Wan restore, one segment-1 inference, no replacement. Wallet `$10.31 -> $9.82`, delta `$0.49`.
- Final zero state: Clore `0`, RunPod `0/0`, both holds `true`, no active authorization/lock/watchdog/watcher/temporary credential state.
- Personal daily-use closure is complete. `production_ready=false` remains deliberate because commercial/public deployment and broad release validation are out of scope.

# Stage 4J.9 queue and reusable-session baseline (2026-07-19, zero cost)

## 2026-07-21 Manual RTX 4090 silent-batch baseline (implementation-only)

- A local manual batch freezes only confirmed silent Wan short-video RTX 4090 tasks before candidate lookup. The persisted snapshot is exact and ordered; retry after a no-candidate result requires a new explicit click and cannot absorb tasks added later.
- Candidate discovery is read-only, fixed to exact RTX 4090, and capped at `$0.70` effective hourly price. The browser chooses the lowest compliant candidate and still requires the existing nonce/risk/exact confirmation text before a server-side provider create path is considered.
- `npm run gpu:manual-batch:test` passes with a fake runtime: one load, two frozen IDs in order, one intentionally failed task, one unload, no provider mutation. `npm run build` passes. No paid order, SSH, model load, inference, or cleanup was run.

- Start branch/HEAD: `codex/stage4g1-long-video-prompts` at `315ac207191b168c23b8b5a8c507e0e779faaf59`; backup ref: `backup/before-queue-model-family-session-20260719-231824`. Main remains untouched.
- Confirmation is queue-only and has one visible action, `确认生成`. Image/video counts are independent; short and long video share the video counts. RTX4090/RTX5090 cards may be selected and confirmed together within one family, then execution selects exactly one GPU queue at a time.
- The persisted session has explicit rented-GPU, deployed-family, and activity fields. One rented GPU runs one model family at a time. Safe stop preserves the GPU/order and starts a 120-second idle-retire deadline; the same compatible GPU/order can switch model family after stop. Provider cancellation remains separate and uses one controller path.
- Rental is still manual and default-off. Nonce/risk/exact server-plus-price confirmation is bound to the selected family/GPU/task IDs. No threshold or refresh action can rent a GPU.
- Offline/controller and browser fixture checks passed with provider mutations `0`, hydration errors `0`, and no accepted-media changes. Personal-use closure remains valid; `production_ready=false`.

# Audio Foundation Stage 1 baseline (2026-07-20, non-billable)

- The current feature branch adds a project-local, ignored `local-data/` layout for future media, voice packs, worker state, cache, temp files, logs, and migration manifests. Existing image/video libraries remain readable fallbacks and were not moved or modified.
- The only new local-media action is an identity-based, loopback-only Windows Explorer selection route. It resolves canonical files below approved roots and never exposes an absolute local path to the browser.
- Audio Foundation is metadata and contract work only: RLS-protected voice, dialogue, inference, immutable revision, and composition tables plus local worker/status TypeScript contracts. There is no voice model, training, inference, audio muxing, media migration, GPU, provider, SSH, or paid execution.

# LTX Audio-Video Integration Stage 1 baseline (2026-07-20, non-billable)

- Silent Wan and planned LTX native-audio video tasks have typed sound mode, quality tier, model key, GPU class, and audio origin. They aggregate into four video queues without changing image queues or accepted media.
- Session state now records an exact deployed-model identity in addition to the compatibility family. Stopping a model is a retained-rental contract only; no real controller, provider order, SSH action, or model unload was invoked.
- Official LTX FP8 is the recommended evidence-backed candidate. Sulphur remains Runtime-blocked until immutable artifact, license, compatible workflow, and dependencies are all proven. `production_ready=false` remains intentional.

## LTX Runtime Stage 2 baseline (2026-07-20, non-billable)

- The four-video-queue browser fixture now restores the exact audible RTX5090 selection after refresh; silent counts are `2/1`, audible counts `1/1`, with zero hydration/provider mutations.
- Mock native-audio Runtime, FFprobe validation, cache/preflight and model-session lifecycle tests pass. The only output is deleted temporary FFmpeg synthetic media; no real LTX/Sulphur model, 4090/5090 Runtime, provider, R2 or accepted media was used.
## Stage 3A.1 audible correction

Audible video now means locally validated dialogue WAV conditioning, not native model dialogue generation. Seven profiles and four sound/GPU queues are the current baseline; all LTX audible presets remain blocked and non-billable.
## 2026-07-21 Stage 3A.2B local repair

The local Studio rental-start path now uses a shared eligibility result, shows immediate read-only candidate-search progress, and cannot create an order before the existing explicit confirmation path. The pyopenjtalk workflow is constrained to this feature branch and related files; no run or local wheel install is recorded until GitHub is reachable.
