# 已知限制

- RTX 4090 的 1024×1024 图片与 832×480 Wan 路径已验证；RTX 5090/Blackwell 仅有非付费兼容档案，尚未付费验证。
- 2048×2048 图片可能采用基础生成加高质量放大/精修，不能称为已验证原生尺寸。
- 1080P 视频可能采用 720P 生成加放大、H.264/yuv420p/faststart 最终化。
- 同时最多一个活动 GPU 订单；图片和视频不能进入同一执行批次。
- 创建任务不会租用 GPU；租用必须由用户在兼容任务批次上明确点击确认。
# Stage 4J.1 observed limit

- The first paid RTX5090 acceptance could create and cancel one bounded Clore order, but the selected host rejected both SSH authentication methods before workspace preparation. RTX5090 runtime and media acceptance therefore remain unverified.
# Stage 4J.3 observed limit

- RTX5090 hardware, both image sizes, UltraReal restore/unload, Wan restore, and one 5-second 720P Wan segment are verified.
- The completed remote Comfy runner left its original long SSH channel open. Segment 0 was rescued and validated locally, but the orchestrator received empty JSON after the stuck local SSH process was ended. Segment 1 was never submitted.
- The return path now uses one detached remote submission plus short result polls. This is offline-tested only; the current task permits no replacement order.
- A complete 10-second 720P master, 1080P final, and explicit segment-0-tail to segment-1-input SHA chain do not exist. Daily-use closure remains incomplete and `production_ready=false`.

# Limits after Stage 4J.8 closure

- The prior Stage 4J.3 missing-video limits are resolved: the two-segment chain, 720P master, and derived 1080P final are verified.
- The 1080P result is intentionally derived from the 720P master (`native_1080p=false`), using CUDA scaling and quality-oriented NVENC on the accepted host. It is not claimed as native 1080P Wan inference.
- The 2048×2048 image remains a derived high-final result, not a native 2048×2048 inference.
- Personal local daily use is ready. `production_ready=false` still applies to public/commercial release, multi-user scale, RunPod fallback, broad historical CI/lint cleanup, and public cloud deployment.
- The one-active-order rule remains. Real rental still requires explicit task-bound authorization; ordinary page load, task creation, browser refresh, and launcher restart do not rent a GPU.

# Limits after Stage 4J.9 queue/session work

- Queue separation, selection, persistence, stop-without-retire, model-family switching, idle cancellation, and cancellation idempotency were verified with local fixtures/mocks only. This checkpoint did not rent an RTX4090/RTX5090, deploy either family, stop a real worker, or cancel a real provider order.
- The web controller records actions for the existing safe runtime/provider driver. A real future session must still prove that the active operator process consumes those actions and completes the corresponding persisted transition; default-off execution remains mandatory.
- The local candidate feed currently follows the configured Clore target and may have no compatible RTX4090 listing when an RTX4090 queue is selected. The UI refuses to substitute an RTX5090 or another class silently.
- Personal local daily-use closure remains valid for accepted Stage 4J.8 media. Public/commercial readiness, multi-user concurrency, broad historical lint/CI cleanup, and real reusable-session acceptance remain out of scope; `production_ready=false`.

# LTX Audio-Video Stage 1 limits (2026-07-20)

- `video_ltx_native_audio` is a local queue and execution contract only. It has not downloaded, loaded, or validated an LTX or Sulphur model, audio stream, workflow, VRAM profile, or output.
- RTX4090 is planned/conditional for native audio and is not GPU-verified. RTX5090 is planned/recommended; it is likewise not verified for this model path.
- Native model audio and future local voice composition remain separate. There is no independent regenerate-audio action for a native-audio video task.

## LTX Runtime Stage 2 limits

- The Runtime backend is mock-only. The Dockerfile is a weight-free contract image, not a verified CUDA/PyTorch LTX image and not publishable production evidence.
- Official LTX FP8 is not silently substituted for Sulphur. Sulphur remains hard-blocked until immutable artifact, license, native-audio workflow and dependencies are jointly proven.
- RTX5090 is planned only; RTX4090 is conditional and both require future real, explicitly authorized validation. `production_ready=false` is unchanged.

# Audio Foundation Stage 1 limits (2026-07-20)

- The audio tables, worker queue shapes, and status mapping are contracts only. There is no user-facing audio generation action, worker implementation, voice-pack download, cloning/training, inference, audition, muxing, or audio revision migration.
- Existing libraries remain read-only compatibility roots. New writes use `local-data/` only when a future scoped feature explicitly creates them; this checkpoint does not migrate or remove legacy files.
- The folder route works only for the local Windows process and a canonical approved media file. It deliberately does not expose a raw directory-opening API, remote URL, signed URL, or browser-visible absolute path.
