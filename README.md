# AI Video Platform

## 2026-07-11 Default-off real Clore execution checkpoint

- Added guarded real-execution code from local_lab confirmation to Clore `create_order`, plus protected `cancel_order`, active-order state, duplicate-create lock, SSH-only order body, and mock tests.
- It is disabled by default with `CLORE_ORDER_EXECUTION_ENABLED=false`. This checkpoint did not create/cancel a real order, spend balance, SSH, rent a GPU, download Wan2.2, or deploy publicly.
- Added first-session dry-run planning for worker deployment, official Wan2.2 download/verification, one synthetic text job, upload, local result viewing, pause, cleanup, and safe stop.
- New docs: `docs/REAL_CLORE_EXECUTION.md`, `docs/FIRST_WAN22_DEPLOYMENT.md`, and `docs/EMERGENCY_GPU_SHUTDOWN.md`.
- New checks: `npm run clore:execution:test`, `npm run clore:ssh:test`, `npm run first-gpu-session:test`, and `npm run check:first-gpu-session`.

## 2026-07-11 Local creation studio checkpoint

- `local_lab` now opens a light single-page creation studio on `/`.
- The page can accumulate multiple text prompts through the existing `create_video_job` RPC; jobs stay `queued` while the GPU session is not running.
- The right-side panel shows sanitized Clore RTX 5090 candidates, selected host details, wallet budget, session/deployment status, dry-run stop controls, and a two-step order confirmation dialog.
- Real Clore order execution is still off. `CLORE_ORDER_EXECUTION_ENABLED=false` is the default, and the web confirmation path still does not call `create_order`.
- Local result serving is loopback-only and reads only the prepared `D:\AI-Video-Library\YYYY-MM-DD\job_id` archive structure. It does not return absolute paths, raw Supabase object paths, signed URL text, or secrets.
- Latest live read-only candidate: server `95538`, exact RTX 5090, API display VRAM `31 display_gb` accepted only under the RTX 5090-specific rule, `14.99 USD/day` normalized to about `0.624583 USD/hour`, about `3.7475 USD` for 6 planned hours.
- No Clore order was created, no balance was spent, no SSH connection was opened, no GPU was rented, and no Wan2.2 weights were downloaded.

## 2026-07-11 Cost-optimized Clore session prep

- The current architecture is optimized for one user, low frequency generation, and GPU sessions up to about 6 hours.
- Prepared cache order: current Clore local model dir, optional Clore persistent volume, private R2 model cache, then official Hugging Face fallback for `Wan-AI/Wan2.2-TI2V-5B`.
- Wan2.2 model weights are not baked into the Docker image. The runtime image plan is `ghcr.io/<user>/wan22-runtime:<immutable-version>`, but no image was pushed.
- GPU disk reservation remains at least 200GB even though the official model budget is 34.2GB.
- `gpu_worker` private upload, task completion, signed URL playback/download, and permission isolation remain verified after user-executed migrations 0005, 0006, and 0007.
- GPU servers still do not need `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, or `CLORE_API_KEY`; they should receive only limited Worker credentials and optional read-only model cache credentials.
- No Clore order was created, no GPU was rented, no Wan2.2 weights were downloaded, no real R2 resources were created, and nothing was deployed publicly.
- New prep commands: `npm run cost:plan`, `npm run model-cache:plan`, `npm run runtime-image:plan`, `npm run clore:session:plan`, `npm run results:check`, and `npm run check:cost-optimized-gpu`.
- Next human-owned step is preparing the real Clore account/balance/API key/SSH key decision and selecting a compliant RTX 5090 candidate. Do not put the Clore API key on the GPU server.

## 2026-07-11 Live Clore read-only checkpoint

- Real Clore `wallets`, `marketplace`, and `my_orders` read-only calls succeeded.
- API key was read from `.secrets/clore.env` and was not printed.
- Wallet USD-like balance is 10.99; after a 1 USD reserve, planning budget is 9.99.
- Active orders: none.
- Qualified RTX 5090 candidates under current filters: 0.
- Closest rejected candidate: server `95538`, RTX 5090, 31GB API-reported GPU memory, 14.99 USD/hour, 89.94 USD for 6 hours.
- No `create_order` call was made, no order was created, no balance was consumed, no SSH connection was opened, and no Wan2.2 model was downloaded.
- `clore:create:dry` is permanently dry-run. Future real create is separated as `npm run clore:create -- --execute --server-id=<id> --max-price=<price> --confirm-project=ai-video-platform-wan22`, but it is still blocked in this checkpoint.

## 2026-07-11 Clore parser correction

- Clore on-demand USD marketplace price is now parsed as USD per 24 hours.
- Server `95538` raw price is `14.99 USD/day`, normalized to about `0.624583 USD/hour`.
- Its 6 hour planning cost is about `3.7475 USD`.
- The API-reported `31GB` VRAM display for exact RTX 5090 is accepted with an explicit RTX 5090-specific rounded/usable VRAM note. The global 32GB rule was not lowered for other GPUs.
- Current qualified RTX 5090 dry-run candidate count: 1, server `95538`.
- Still no order was created, no balance was consumed, no SSH connection was opened, and no model was downloaded.

## 2026-07-10 Clore GPU rental prep checkpoint

- Clore.ai is now the only primary GPU rental platform.
- The user has registered Clore.ai and added about 11 USD.
- `CLORE_API_KEY` is configured only in `.secrets/clore.env`; no Clore order has been created, no real GPU has been connected, no Wan2.2 weights have been downloaded, and nothing has been deployed publicly.
- Supabase migrations 0005, 0006, and 0007 have been manually executed; `gpu_worker` private video upload/completion/playback has been verified with the local Python mock Worker.
- GPU servers do not need `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, or `CLORE_API_KEY`; they should load only limited Worker credentials from `.secrets/gpu-worker.env`.
- RunPod Secure Cloud is kept only as a last-resort fallback.

## 2026-07-11 Clore read-only checkpoint

- Real read-only Clore wallet/status/marketplace checks passed without creating an order.
- Wallet summary: `USD-Blockchain: 10.99`; active orders: none.
- No RTX 5090 listing currently passes the project filters at `CLORE_MAX_GPU_PRICE_PER_HOUR=0.70` and the 6 hour planning window.
- Closest strong rejected candidate observed: server `95538`, RTX 5090, 31GB API-reported GPU memory, 9.90 USD/hour, 59.40 USD for 6 hours.
- `npm run clore:create:dry` writes only a safe dry-run plan under `.secrets/clore-order-plan.json`; it does not call `create_order`.

## 2026-07-11 Local lab checkpoint

- The temporary priority is a single-user local AI generation lab on this laptop.
- `npm run dev:local` binds the app to `127.0.0.1:3000`; local lab server protection rejects non-loopback Hosts.
- `npm run local-lab:setup` creates or verifies a dedicated `app_metadata.role=local_tester` Supabase account and stores credentials in `.secrets/local-lab.env`.
- The local lab UI shows `积分：∞`, but the database still uses a large finite balance and the existing扣费/退款 RPC.
- The local lab UI only exposes Wan2.2 TI2V-5B through the existing `standard-video` model key.
- Clore API has not been called, no order has been created, no GPU has been rented, and no Wan2.2 weights have been downloaded.

AI Video Platform 是一个规划中的 AI 视频生成平台。当前仓库包含产品规划文档，以及一个 Next.js 前端网页。

请注意：当前版本已经接入 Supabase 邮箱密码认证、积分账户读取、真实视频任务记录、积分扣除/退款、私有视频存储骨架和本地模拟 Worker。但仍不连接真实 GPU、支付服务或公网部署，也不运行真实视频模型。

## 当前演示界面

- 首页打开后直接显示动态视频预览画面。
- 底部显示当前视频的提示词，可以直接编辑。
- 提示词框左下角会根据模型能力显示“+”入口，用于演示添加图像素材作为首帧。
- 提示词框右下角有模型选择按钮，点击或鼠标悬停可查看不同演示模型。
- 当前有三个模型入口：轻量视频模型、标准视频模型、高质量视频模型。
- 高质量视频模型显示“即将开放”，当前不可选择。
- 右上角有头像按钮，点击后展示演示用户、邮箱、积分、充值、账号与密码、生成记录、退出登录。
- 点击账户面板外部或按 Esc 可以关闭面板。
- 充值、账号密码、真实首帧上传、真实视频生成目前都只是演示入口，没有真实功能。
- 未登录时点击生成会提示先登录。
- 已登录后右上角账户面板会尝试从 Supabase 的 `credit_accounts` 表读取真实积分余额。
- 已登录后点击生成会通过 `create_video_job` 创建真实 `video_jobs` 记录，状态为 `queued`，并按模型扣除积分。
- 轻量视频模型扣 5 积分，标准视频模型扣 10 积分，高质量视频模型仍不可用。
- 本阶段真实 GPU 尚未接入，可以用本地模拟 Worker 推进进度并上传本地演示 MP4。
- 任务取消或失败会按规则退款。
- 成功任务通过私有 Storage 路径保存，网页只请求短期签名 URL 播放或下载。
- 如果选择首帧图片，只做本地预览；提交时会提示“首帧上传将在后续版本开放”，不会上传图片或把 base64 写入数据库。

## 当前已包含页面

- `/`：沉浸式视频生成工作台。
- `/generate`：同样的生成工作台。
- `/history`：读取当前登录用户自己的真实 `video_jobs` 任务记录。
- `/login`：Supabase 邮箱密码登录/注册页。

## 当前没有实现的内容

- 没有用户名、头像上传、找回密码等完整账户功能。
- 没有真实视频生成。
- 没有连接 RTX 5090 GPU 服务器。
- 没有公开视频桶或永久公开视频 URL。
- 没有支付、邀请奖励、比特币奖励或设备指纹功能。
- 没有云端部署。

## Supabase 环境变量

项目使用以下公开环境变量连接 Supabase：

```env
NEXT_PUBLIC_SUPABASE_URL=""
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=""
```

请把真实值放在本地 `.env.local` 中，不要写入源代码。

普通浏览器页面不使用 Supabase `service_role` key，不使用 Secret key，也不需要数据库密码。

本地模拟 Worker 和签名 URL API 需要服务器端 Secret key：

```env
SUPABASE_SECRET_KEY=""
SUPABASE_SERVICE_ROLE_KEY=""
```

优先使用 `SUPABASE_SECRET_KEY`。旧 `SUPABASE_SERVICE_ROLE_KEY` 只作为兼容后备。不要把这两个变量改成 `NEXT_PUBLIC_`，不要提交 `.env.local`。

## 数据库迁移

迁移文件在：

```text
supabase/migrations/0001_auth_profiles_and_credits.sql
supabase/migrations/0002_video_jobs.sql
supabase/migrations/0003_worker_storage_credits.sql
```

这些 SQL 需要由你本人复制到 Supabase 后台 SQL Editor 手动执行。本项目不会自动连接远程数据库，也不会自动执行迁移。

`0002_video_jobs.sql` 会创建：

- `video_jobs`：真实视频任务记录表。
- `create_video_job`：安全创建排队任务函数。
- `cancel_video_job`：安全取消 queued 任务函数。

浏览器客户端只能读取自己的任务，不能直接插入任务、修改状态、设置费用或写入输出地址。

`0003_worker_storage_credits.sql` 会创建：

- `video_jobs` Worker 字段和进度字段。
- 创建任务扣费、取消退款、失败退款。
- Worker 领取、心跳、完成、失败和过期恢复 RPC。
- 私有 `generated-videos` bucket 和只读自有对象策略。

详细步骤见：

```text
docs/SUPABASE_SETUP.md
```

## 技术栈

- Next.js
- TypeScript
- App Router
- Tailwind CSS
- npm

## 本地安装

在 VS Code 终端中进入项目目录后运行：

```powershell
npm install
```

本地实验模式首次启动：

```powershell
npm run local-lab:setup
npm run dev:local
```

日常启动：

```powershell
npm run dev:local
```

浏览器打开：

```text
http://127.0.0.1:3000
```

## 本地启动

```powershell
npm run dev
```

启动后，在浏览器打开：

```text
http://localhost:3000
```

如果本地显示的是 `http://127.0.0.1:3000`，也可以直接打开这个地址。

## 检查命令

代码检查：

```powershell
npm run lint
```

构建检查：

```powershell
npm run build
```

统一检查：

```powershell
npm run check
```

本地模拟 Worker：

```powershell
npm run mock-video:generate
npm run worker:mock
npm run worker:mock:once
npm run worker:mock:once:test
```

远程验证与测试：

```powershell
npm run verify:remote
npm run test:unit
npm run test:integration
npm run test:cleanup
npm run check:full
npm run local-lab:test
npm run check:local-lab
npm run local-lab:reset:dry
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
npm run secret:scan
npm run check:gpu-prep
```

注意：远程集成测试需要 `.env.local` 中配置 Supabase 公共变量和服务器 Secret key。当前远程项目已经执行 `supabase/migrations/0004_integration_fixes.sql`，`npm run verify:remote`、`npm run test:integration`、`npm run worker:mock:once:test` 和 `npm run check:full` 已验证通过。

当前已验证闭环：

- 账号认证闭环已通过，临时测试用户自动获得 100 积分。
- 积分扣除与退款闭环已通过，轻量模型扣 5 积分，标准模型扣 10 积分。
- Worker 任务领取闭环已通过，多 Worker 不会重复领取同一任务。
- 私有 Storage 上传与访问控制已通过。
- 签名 URL 播放和下载重新申请已通过。
- 当前使用程序生成的模拟视频，真实 GPU 尚未连接。
- 下一步可以接真实 RTX 5090 Worker。

## Wan2.2 GPU Worker 准备状态

当前已新增部署准备文件，没有租用 GPU，没有下载模型；`0005`、`0006` 和 `0007` 已由用户远程执行，完整 Storage 上传闭环已验证通过：

- `supabase/migrations/0005_limited_gpu_worker_role.sql`：受限 `gpu_worker` 身份和 Storage 上传策略，已由用户远程执行。
- `supabase/migrations/0006_gpu_worker_storage_insert_grant.sql`：补充 Storage 表级 insert grant，已由用户远程执行。
- `supabase/migrations/0007_gpu_worker_storage_policy_rls_fix.sql`：修复 Storage policy 查询 `video_jobs` 时被 RLS 过滤的问题，已由用户远程执行。
- `gpu-worker/`：Python Worker、MockWanRunner、RealWanRunner 骨架和 Dockerfile。
- `scripts/clore/`：Clore.ai RTX 5090 本地 mock、只读查询、dry-run 订单计划和 SSH-only Worker 准备脚本。
- `docs/WAN22_GPU_WORKER.md`：Wan2.2 Worker 说明。
- `docs/CLORE_DEPLOYMENT.md`：Clore 安全部署准备、P2P 风险、候选筛选和 dry-run 命令。
- `docs/RUNPOD_FALLBACK.md`：RunPod Secure Cloud 最后备用方案。

真实 GPU 服务器只能保存受限 Worker 凭据，不能保存 Supabase Secret key 或 Clore API key。首次真实测试只允许合成提示词，不上传真实用户照片。

## npm audit 状态

当前 `npm audit` 报 2 个 moderate，来源是生产依赖 `next` 内部依赖的 `postcss <8.5.10`。`npm audit fix` 无法安全修复，npm 建议的 `--force` 会降级到不兼容的 Next 9 大版本，因此本阶段不执行 `npm audit fix --force`。后续应等待 Next.js 发布兼容修复版本后再升级。

## 文档说明

- `docs/MVP_REQUIREMENTS.md`：第一版产品需求。
- `docs/ARCHITECTURE.md`：系统架构规划，包含 Mermaid 架构图。
- `docs/DEVELOPMENT_ROADMAP.md`：开发路线图。
- `docs/PROJECT_CONTEXT.md`：精简项目上下文，后续开发优先阅读。
- `docs/MOCK_WORKER_SETUP.md`：本地模拟 Worker 设置与测试步骤。
- `AGENTS.md`：后续开发规则。

## 重要原则

- 不把任何密钥、密码、令牌写入源代码。
- `.env.example` 只能放示例占位符，不能放真实配置。
- 不连接真实云服务，除非后续明确进入部署阶段并确认费用和风险。
- 不虚构已经完成的功能。
- 不删除或修改用户电脑中的其他文件。
- 每次只开发一个小功能，完成后说明修改了什么、如何运行、如何验证。

## 2026-07-12 local_lab / Clore 状态

- local_lab 首页右侧 GPU 主机栏在桌面端默认常驻，占用 380px 布局列；窄屏仍使用点击抽屉。
- 历史视频有删除入口；processing 任务不能删除，queued 任务会先取消退款，删除只限本机 local_tester 自己的任务和文件。
- Clore 候选排序按归一化 USD/hour，不按原始 `USD/day` 文本排序。
- 本次 live read-only 查询找到 3 台合规 RTX 5090：`107713`、`107921`、`95538`。
- 当前最便宜候选是 `107713`：`7 USD/day`，约 `0.291667 USD/hour`，6 小时约 `1.75 USD`。
- `95538` 仍通过：`14.99 USD/day`，约 `0.624583 USD/hour`，6 小时约 `3.7475 USD`；31GB API 显存显示只按精确 RTX 5090 的型号特定规则接受。
- `.secrets/clore-order-plan.json` 已重新生成为 dry-run-only；没有调用 `create_order`，没有创建订单，没有消耗余额。
- 真实下单仍被前置条件阻止：本机缺少 `wrangler`、`docker`、`gh`，并且尚未配置 R2 模型缓存 env 文件。

真实创建订单的唯一入口仍是：

```powershell
npm run clore:create -- --execute --server-id=<server_id> --max-price=<price> --confirm-project=ai-video-platform-wan22 --queued-jobs=<count>
```

只有在 R2 模型缓存、公开 runtime 镜像、SSH、公钥、queued synthetic job、余额、价格和 Clore live revalidation 全部通过后才能运行。`clore:create:dry` 永远不会真实下单。

## 2026-07-12 GitHub / GHCR / R2 基础设施状态

- 已通过 winget 安装 GitHub CLI。
- 已安装项目内 Wrangler dev dependency。
- Runtime 镜像构建改为 GitHub Actions 云端构建，不要求本机安装 Docker Desktop。
- `.github/workflows/runtime-image.yml` 已准备为手动触发、GHCR 推送、不可变 tag、SBOM、provenance、linux/amd64。
- GitHub OAuth 尚未完成，所以私有仓库、首个提交、push、Actions 构建、GHCR 镜像和 digest 尚未创建。
- Cloudflare OAuth 尚未完成，所以 R2 bucket、管理写入凭据、GPU 只读凭据和权限测试尚未完成。
- 没有创建 Clore 订单，没有消耗余额，没有连接 GPU/SSH，没有下载 Wan2.2，没有上传模型到 R2。
