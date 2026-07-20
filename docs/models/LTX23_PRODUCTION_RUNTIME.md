# LTX 2.3 生产运行时（Stage 3A）

`ltx-runtime/python/` 是围绕官方 `ltx-pipelines` 的 fail-closed 适配器。官方源码固定为 `Lightricks/LTX-2@9377758131b1ffde4b7f766804590a6617bf2ab9`，使用 `ltx-core`/`ltx-pipelines` 1.1.7 的依赖契约；不使用泛化 `DiffusionPipeline`。

适配器只允许官方 `DistilledPipeline` 或 `TI2VidTwoStagesPipeline` 的 CLI。它验证清单、文件存在和 SHA-256，拒绝自动下载、重复任务、未锁定 I2V CLI、路径逃逸及不符合 LTX 的尺寸/帧数。运行生命周期包含预检、加载、取消、退出、卸载和 `torch.cuda.empty_cache()`；进度与心跳将由下一阶段真实 worker 接入，Stage 3A 未启动任何进程。

`Dockerfile` 有两个目标：`mock` 保留 Stage 2 合约；`production` 是静态定义，采用 CUDA 12.8.1 Ubuntu 24.04、非 root、只读模型挂载、可写 jobs/output、FFmpeg/FFprobe 健康检查与 `tini` 信号转发。镜像不带权重、凭据或媒体。镜像基础 tag 在真正构建/发布前仍必须记录 registry digest。消费级 RTX 5090 是未来首测目标；RTX 4090 仅条件性支持，尚未验证。没有声称 FlashAttention 可用。

`npm run ltx:production:plan` 仅校验本地清单并输出阻断原因；它不联系 Clore/RunPod、不下载、不推理、不写缓存。

`npm run ltx:production:dependencies` 检查 Python、Torch/CUDA、FFmpeg 依赖记录和官方源码 revision；它只读锁文件，不解析或安装依赖。
