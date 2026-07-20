# LTX-2.3 原生音视频 Runtime 基线（Stage 2）

日期：2026-07-20。此阶段严格非付费：未创建订单、未连接 SSH、未下载权重、未调用 R2、未运行真实模型、未修改已接受媒体。

## 运行策略

选择“窄封装官方 `Lightricks/LTX-2` 的 `ltx-pipelines`”作为未来真实后端，而不是把 Wan 执行器塞入 LTX 分支，也不把 ComfyUI 工作流当作本项目的控制平面。官方仓库明确提供文本/图像到视频管线、两阶段质量路径和原生同步音视频；这种 Python API 路径可提供任务 ID、进度、取消、模型卸载和恢复身份的精确边界。ComfyUI 仍可作为未来人工验证工具，但不是 Runtime 依赖。

本仓库目前只有 TypeScript 编排合约和 mock 后端。`ltx-runtime/Dockerfile` 是无权重、无密钥、无媒体的 mock-only 镜像定义；它不能被视作真实 LTX 镜像，也不会发布。

## 目录与合约

- `src/lib/ltx-runtime/index.ts`：请求校验、后端接口、mock、进度/心跳、取消、结果清单、FFprobe 验证和预检。
- `src/lib/ltx-runtime/cache.ts`：只对本地测试文件工作的恢复计划、`.part` 续传、校验、原子发布、journal 和同一不可变包的并发抑制。
- `src/lib/ltx-runtime/session-driver.ts`：将 `video_wan_silent` 与 `video_ltx_native_audio` 映射到不同 Runtime；一个租用 GPU 同时只能加载一个模型。
- `ltx-runtime/manifests/`：不可变模型包元数据。`current.json` 不存在，且本阶段不会发布它。

请求包含 task ID、模型键与不可变 revision、模型角色、提示词、可选首帧、尺寸、FPS、8n+1 帧数、seed、质量档、GPU 类别、原生音频要求、输出路径、取消 token 和恢复身份。mock 只在本地 dry-run 时可绕过“真实 Runtime 未部署”的清单阻断。

## 原生音视频结果

成功结果必须是可 seek 的 MP4，包含至少一个视频流与一个音频流，具有非零且在容差内的时长、尺寸、FPS/帧数（可用时）、音频编码/采样率/声道、SHA-256、文件大小、精确 task/model/revision/seed 和开始结束时间。纯视频结果一律失败，不能标记为原生音频成功。

失败分类包括无输出、容器无效、缺视频、缺音频、时长不符、截断、尺寸不支持、取消、模型加载、显存/内存/磁盘不足、依赖运行时、缓存下载和未知错误。

## 模型状态

官方 `Lightricks/LTX-2.3-fp8` revision `1d756cd27fa11c0896c4dfee093cd1bf36c7f7a1` 的开发 FP8 文件有已记录的 29,145,431,166 字节和 SHA-256 `28606c…d26450`，因此仅作为兼容性基线清单。它不是本项目的静默生产替代品：完整官方辅助文件、可复现 `ltx-pipelines` 依赖锁和真实 Runtime 镜像仍未同时验证。

请求的 Sulphur 全量/蒸馏路径仍不可执行。其不可变工件、许可证、原生音视频工作流和依赖闭包未共同证明；全量 checkpoint 与蒸馏 LoRA 被明确视为互斥替代项，不能同时加载。

## 本地 dry-run

运行：`npm run ltx:runtime:dry`

该命令仅在临时目录中用 FFmpeg 制作极小的合成音视频，经过真实请求校验、mock Runtime、FFprobe 和结果清单后删除临时媒体；第二个 mock 任务验证取消。它不下载模型、不访问 R2、不创建 GPU/provider 资源，不能说明模型质量或性能。

## Stage 3 前置条件

1. 明确接受并记录许可；锁定所有真实工件与辅助文件的 revision、字节数和 SHA-256。
2. 锁定官方 `ltx-pipelines` 提交、Python/Torch/CUDA 组合并构建无密钥 Runtime 镜像。
3. 将清单状态改为 executable，完成本地/受控 RTX 5090 单条合成提示验收。
4. 由负责人明确创建受限的单次付费授权；RTX 4090 仍只能作为条件性验证目标。
