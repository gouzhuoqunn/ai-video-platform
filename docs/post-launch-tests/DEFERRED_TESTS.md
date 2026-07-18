# 按需延后测试

以下项目不自动执行，且每次只选一个明确目标：普通图片重新验收、普通短视频重新验收、图生视频链路、推理期间真实 Next 重启、纯提示词长视频、真实 regenerate-current-segment、跨会话 pause/resume、5 分钟压力测试、RunPod 备用路径、完整 lint/NFT 清理、商业发布工作。

执行前必须确认单 GPU、费用上限、模型和提示词已锁定；完成后确认资源回到零状态。
# Deferred after Stage 4J.1

- Re-run the prepared RTX5090 batch only after a fresh one-use authorization and verified password/key parity for the exact returned Clore endpoint. The next operator must not create a second order in the current authorization and must preserve the two image tasks plus the two-segment project.
