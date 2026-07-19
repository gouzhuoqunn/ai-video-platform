# 按需延后测试

以下项目不自动执行，且每次只选一个明确目标：普通图片重新验收、普通短视频重新验收、图生视频链路、推理期间真实 Next 重启、纯提示词长视频、真实 regenerate-current-segment、跨会话 pause/resume、5 分钟压力测试、RunPod 备用路径、完整 lint/NFT 清理、商业发布工作。

执行前必须确认单 GPU、费用上限、模型和提示词已锁定；完成后确认资源回到零状态。
# Deferred after Stage 4J.1

- Re-run the prepared RTX5090 batch only after a fresh one-use authorization and verified password/key parity for the exact returned Clore endpoint. The next operator must not create a second order in the current authorization and must preserve the two image tasks plus the two-segment project.
# Deferred after Stage 4J.3

- The current one-order authorization is consumed. Do not create another Clore order automatically or reuse any Stage 4J.3 authorization.
- A future task may proceed only after a new explicit paid authorization. It should resume project `a6cbf8c1-f158-4583-8f40-fa524dddd9d1` at segment 1, preserve accepted segment 0 and its last-frame SHA, exercise the detached result-return fix, generate exactly one remaining segment, then verify the tail-frame chain, 720P merge, deterministic 1080P finalization, browser playback, Range/seeking, and cleanup.
- RTX4090, short-video, RunPod fallback, broad lint, historical CI, R2 publication, and commercial-release work remain deferred.

# Deferred after Stage 4J.8 success

- No further RTX 5090 acceptance order is needed for personal daily use. Do not reuse any consumed Stage 4J authorization.
- Still deferred by scope: RTX 4090 revalidation, ordinary short-video revalidation, RunPod fallback, pure-prompt long video, real regenerate/pause-resume stress, inference-time Next restart, five-minute stress testing, broad lint and historical CI cleanup, R2 publication, public deployment, multi-user hardening, and commercial release testing.
- Any future paid task requires a new narrowly bound authorization and must begin from zero cloud state.
