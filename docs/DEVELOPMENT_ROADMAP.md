# 开发路线图

## 2026-07-11 checkpoint: default-off real Clore execution code

- Implemented guarded real create/cancel code paths, active-order state, duplicate-create lock, SSH-only create body, local_lab confirm integration, and mock tests.
- Default remains `CLORE_ORDER_EXECUTION_ENABLED=false`; no real order was created or canceled, no balance was spent, no SSH happened, no GPU was rented, and no Wan2.2 weights were downloaded.
- Added first GPU session dry-run planning and emergency shutdown docs.
- Still not done: real SSH deployment, actual Wan2.2 download, real Worker startup on Clore, real inference, and verified real cancel after upload.

## 2026-07-10 checkpoint: Clore.ai replaces Vast

- Clore.ai is now the only primary GPU rental platform.
- The user has registered Clore.ai, added about 11 USD, and configured `CLORE_API_KEY` only in `.secrets/clore.env`.
- Real read-only wallet, marketplace, and order-status queries have been verified. Wallet summary is `USD-Blockchain: 10.99`; active orders are none.
- No RTX 5090 candidate currently passes the 0.70 USD/hour cap, 6 hour planning window, and project safety filters. No order has been created, no GPU has been rented, no Wan2.2 weights have been downloaded, and nothing has been deployed publicly.
- Supabase migrations 0005, 0006, and 0007 have been manually executed and the limited Worker private upload loop has been verified.
- GPU servers do not need Supabase Secret keys or Clore API keys. They should receive only `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `GPU_WORKER_EMAIL`, `GPU_WORKER_PASSWORD`, and optionally `GPU_WORKER_USER_ID`.
- RunPod Secure Cloud remains a last-resort fallback only.
- Next human step: decide whether to wait for a compliant cheaper RTX 5090 listing or explicitly approve a higher hourly/6 hour budget before any real rental path is considered.

## 2026-07-11 checkpoint: local_lab priority

- The temporary priority is now a single-user local AI generation lab on the user's laptop, not a public commercial website.
- `local_lab` mode binds local dev/start to `127.0.0.1`, rejects non-loopback Hosts in server proxy, and auto-signs in a dedicated `app_metadata.role=local_tester` account.
- The UI shows credits as `∞`, but the database keeps a large finite `1000000000` balance and existing charge/refund RPCs still run.
- The local lab UI exposes only Wan2.2 TI2V-5B via existing `standard-video`; lightweight/high-quality/multi-model/first-frame features are hidden for now.
- Clore API usage is currently read-only only. No order, GPU rental, model download, public deployment, database migration, payment, invitation, device fingerprinting, or anti-abuse feature was added.

本路线图把 AI Video Platform 拆成可以逐项勾选的小任务。后续开发时，每次只做一个小功能，完成后再进入下一个。

注意：下面是计划清单，不代表这些功能已经完成。

## 阶段 0：项目规划

- [x] 创建 README.md，说明项目目标和边界。
- [x] 创建 MVP_REQUIREMENTS.md，说明第一版产品需求。
- [x] 创建 ARCHITECTURE.md，说明系统架构。
- [x] 创建 DEVELOPMENT_ROADMAP.md，说明开发路线。
- [x] 创建 AGENTS.md，说明后续开发规则。

## 阶段 1：本地开发基础

- [x] 选择前端框架：Next.js。
- [x] 选择后端/数据边界：当前阶段使用 Supabase Auth、RLS 和 PostgreSQL 安全函数。
- [x] 选择数据库方案：Supabase PostgreSQL。
- [x] 选择任务队列方案：第一版使用 PostgreSQL 表加 Worker RPC。
- [x] 设计环境变量文件示例，但不写入真实密钥。
- [x] 建立最小项目目录结构。
- [x] 建立本地运行说明。

## 阶段 2：用户系统

- [x] 实现用户注册。
- [x] 实现用户登录。
- [x] 实现用户退出登录。
- [x] 实现登录状态检查。
- [x] 限制未登录用户不能提交任务。
- [x] 增加基础用户数据表。
- [x] 编写用户系统验证步骤。

## 阶段 3：积分系统

- [x] 设计积分数据表。
- [x] 给用户显示积分余额。
- [x] 实现提交任务前积分检查。
- [x] 实现积分不足时拒绝提交。
- [x] 实现任务提交后的积分记录。
- [x] 编写积分系统验证步骤。

当前轻量模型扣 5 积分，标准模型扣 10 积分；取消 queued 任务或任务失败会退款。

## 阶段 4：视频任务系统

- [x] 设计视频任务数据表。
- [x] 实现提示词提交接口。
- [x] 限制每次只提交一个文字提示词。
- [x] 固定第一版视频时长为 5 秒。
- [x] 当前只允许轻量视频模型和标准视频模型，高质量视频模型不可用。
- [x] 固定第一版输出 480P 或 720P 预设。
- [x] 创建任务时设置状态为等待中。
- [x] 编写任务提交验证步骤。

当前只实现任务记录与排队骨架：任务状态创建后为 `queued`，不会自动生成视频。

## 阶段 5：异步任务队列

- [ ] 选择简单成熟的任务队列方案。
- [x] 后端提交任务到数据库排队骨架。
- [x] 本地模拟 Worker 从队列领取任务。
- [x] 本地模拟 Worker 支持一次性运行模式。
- [x] 实现等待中、生成中、成功、失败、取消状态。
- [x] 记录安全失败原因。
- [x] 编写任务队列验证步骤。

当前状态推进由本地模拟 Worker 完成；后续真实 GPU Worker 替换模拟生成部分即可。远程集成测试已经在执行 0004 后通过。

## 阶段 6：GPU 生成服务规划与接入

- [x] 选择一个能在 32GB 显存内运行的开源视频生成模型：Wan-AI/Wan2.2-TI2V-5B。
- [x] 明确模型运行环境：CUDA 12.8、PyTorch 2.7.1、Python 3.11。
- [x] 明确 GPU 服务器部署方式：受限 Worker 账号主动轮询，不开放公网推理端口。
- [x] 准备并由用户远程执行受限 GPU Worker 角色迁移 0005。
- [x] 手动执行 0007 Storage policy RLS fix 后复跑受限 Worker 上传闭环。
- [x] 准备 Python Worker、Dockerfile、Clore dry-run 和 RunPod 最后备用文档。
- [ ] 实现 GPU 服务领取任务的最小流程。
- [ ] 实现固定 5 秒视频生成。
- [ ] 实现生成失败时的错误记录。
- [ ] 编写 GPU 生成流程验证步骤。

当前只完成部署准备和本地 Mock 测试，尚未下载 Wan2.2 权重，尚未租用 GPU，尚未在 RTX 5090 上验证真实推理。

## 阶段 7：视频存储与播放

- [ ] 选择云端对象存储方案。
- [ ] 设计视频文件保存路径规则。
- [x] 保存私有视频路径到数据库。
- [x] 实现用户视频任务历史记录。
- [x] 使用短期签名 URL 播放生成成功的视频。
- [x] 下载时重新申请短期签名 URL。
- [x] 确保用户只能看到自己的任务记录。
- [x] 编写视频播放验证步骤。

当前播放的是本地模拟 Worker 上传的演示视频，不是真实 AI 生成视频。

`public/mock-videos/demo.mp4` 可通过 `npm run mock-video:generate` 自动生成，视频文件被 Git 忽略。

远程测试已确认私有 Storage 上传、跨用户访问隔离、短期签名 URL 播放和下载重新申请逻辑。

## 阶段 8：部署准备

- [ ] 明确公开网页部署位置。
- [ ] 明确后端 API 部署位置。
- [ ] 明确数据库部署位置。
- [ ] 明确 GPU 服务器部署位置。
- [ ] 明确云端存储配置方式。
- [ ] 检查所有密钥都通过环境变量管理。
- [ ] 检查用户笔记本不作为公开服务器。
- [ ] 编写部署前检查清单。

## 阶段 9：第一版验收

- [ ] 用户可以注册和登录。
- [ ] 用户可以查看积分。
- [ ] 积分不足时不能提交任务。
- [ ] 积分足够时可以提交文字到视频任务。
- [ ] 任务状态能从等待中更新到生成中。
- [ ] 任务成功后能播放视频。
- [ ] 任务失败时能看到失败状态。
- [ ] 用户可以看到自己的视频历史记录。
- [ ] 用户不能看到别人的视频。
- [ ] 没有支付、邀请、比特币、设备指纹等超出范围功能。

## 暂缓功能

以下功能明确不进入第一版，除非项目负责人后续单独确认：

- [ ] 在线支付。
- [ ] 邀请奖励。
- [ ] 比特币奖励。
- [ ] 设备指纹。
- [ ] 复杂反爬虫。
- [ ] 参考图片上传。
- [ ] 多模型选择。
- [ ] 自定义视频长度。
- [ ] 自动 GPU 扩缩容。
- [ ] 大规模并发生成。
## 2026-07-11 checkpoint: cost-optimized GPU sessions

- Prepared local-only scripts and docs for the final cost-optimized Clore architecture: short explicit GPU sessions, cache restore, local archive, dry-run session state, and runtime image checks.
- Added model cache plan for `Wan-AI/Wan2.2-TI2V-5B`: local instance, optional Clore volume, private R2, official Hugging Face fallback.
- Added session cost planning: 0.70 USD/hour cap, 6 hour session, 4.20 USD/session, 11 USD balance supports 2 full planned sessions with 1 USD reserve.
- Added idle shutdown rule: stop when no more work is expected within 15 minutes.
- Added local archive plan under `D:\AI-Video-Library`.
- Still not done: real Clore order, SSH, Wan2.2 download, R2 bucket creation, image push, public deployment, payment, real user media upload.

## 2026-07-11 checkpoint: local creation studio and protected Clore web flow

- local_lab now has a dedicated creation studio UI for batching prompts, viewing history cards, and playing local archive or Supabase fallback videos.
- Added local_lab-only API routes for jobs, results, Clore candidates, wallet, session status, order plan, order confirm, and session stop dry-run.
- Added a two-step Clore confirmation UI and backend nonce guard. Real `create_order` is still not implemented and remains blocked by `CLORE_ORDER_EXECUTION_ENABLED=false`.
- Latest live read-only scan shows server `95538` as the current compliant RTX 5090 candidate after USD/day and RTX 5090 VRAM normalization.
- Still not done: real order creation, SSH deployment, Wan2.2 model download, real GPU inference, automatic worker startup, and real cancel_order.
