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
