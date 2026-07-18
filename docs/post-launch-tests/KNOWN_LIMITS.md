# 已知限制

- RTX 4090 的 1024×1024 图片与 832×480 Wan 路径已验证；RTX 5090/Blackwell 仅有非付费兼容档案，尚未付费验证。
- 2048×2048 图片可能采用基础生成加高质量放大/精修，不能称为已验证原生尺寸。
- 1080P 视频可能采用 720P 生成加放大、H.264/yuv420p/faststart 最终化。
- 同时最多一个活动 GPU 订单；图片和视频不能进入同一执行批次。
- 创建任务不会租用 GPU；租用必须由用户在兼容任务批次上明确点击确认。
# Stage 4J.1 observed limit

- The first paid RTX5090 acceptance could create and cancel one bounded Clore order, but the selected host rejected both SSH authentication methods before workspace preparation. RTX5090 runtime and media acceptance therefore remain unverified.
