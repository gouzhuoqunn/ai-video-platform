# AI Video Platform 开发规则

本文是本项目后续开发必须遵守的规则。无论是人类开发者还是 AI 编程助手，都必须按这些规则工作。

## 1. 工作流程

每次开发都必须遵守：

1. 先规划。
2. 再修改。
3. 再测试。
4. 最后说明结果。

每次新任务开始时，先阅读：

1. `AGENTS.md`。
2. `docs/PROJECT_CONTEXT.md`。
3. `docs/CLORE_DEPLOYMENT.md`。
4. `docs/LOCAL_LAB_MODE.md`。
5. 与当前任务直接相关的文件。

只有 `docs/PROJECT_CONTEXT.md` 信息不足或明显过期时，才需要重新阅读全部 `docs` 目录。

每次开发结束时，如果项目结构、数据库、命令、功能边界或安全边界发生变化，必须同步更新 `docs/PROJECT_CONTEXT.md`。

开始写代码前，必须先说明：

- 本次要解决什么小问题。
- 准备修改哪些文件。
- 准备用什么方式验证。

完成后，必须说明：

- 修改了哪些文件。
- 如何运行。
- 如何验证。
- 是否还有未完成或不确定的地方。

## 2. 每次只做一个小功能

每次开发只能做一个清楚的小功能。

不要一次性同时做注册、积分、任务队列、GPU 接入、云存储等多个大功能。

如果发现一个功能太大，必须拆成更小的任务。

## 3. 不得虚构完成状态

不能说某个功能已经完成，除非它真的已经实现并验证过。

不能因为文档里写了规划，就说网站已经具备这些功能。

当前文档阶段只代表规划完成，不代表功能完成。

## 4. 密钥管理

任何密钥都不能写入源代码。

禁止写入源代码的内容包括：

- 数据库密码。
- 云服务访问密钥。
- API Key。
- 登录令牌。
- 私钥。
- 服务器密码。

正确做法是：

- 使用环境变量。
- 使用本地 `.env` 文件保存开发机密信息。
- `.env` 文件必须加入忽略列表，不能提交到代码仓库。
- 可以提供 `.env.example` 作为示例，但里面只能放占位符，不能放真实密钥。

## 5. 功能范围限制

第一版不得自行添加以下功能：

- 支付。
- 邀请奖励。
- 比特币奖励。
- 设备指纹。
- 参考图片上传。
- 多模型选择。
- 自定义视频长度。
- 自动 GPU 扩缩容。
- 复杂反爬虫。

如果确实需要添加，必须先由项目负责人明确确认。

## 6. 技术选择原则

遇到不确定的技术选择时，优先采用：

- 简单的方案。
- 成熟的方案。
- 资料多的方案。
- 容易部署和维护的方案。
- 适合第一版小规模使用的方案。

不要为了炫技引入复杂架构。

## 7. 云服务与外部服务

当前阶段不要连接真实云服务。

后续如果需要连接真实云服务，必须先确认：

- 使用哪个服务。
- 用途是什么。
- 会产生什么费用。
- 密钥如何保存。
- 如何避免误删或泄露数据。

GPU Worker 相关规则：

- 第三方 GPU 服务器不得持有 `SUPABASE_SECRET_KEY` 或 `SUPABASE_SERVICE_ROLE_KEY`。
- 真实 GPU Worker 必须使用受限 `gpu_worker` 账号主动轮询。
- 不得开放 ComfyUI、Jupyter、Gradio 或公网推理端口。
- 不得在本地轻薄本下载完整 Wan2.2 权重。
- Clore.ai 是当前唯一主 GPU 租赁平台；RunPod 仅作为最后备用方案。
- Clore 相关脚本默认必须 dry-run，不得自动创建或取消真实订单。
- 第三方 GPU 服务器不得持有 `CLORE_API_KEY`，Clore API key 只能保存在本地 `.secrets/clore.env`。
- `local_lab` 是当前临时优先模式：只允许本机 `127.0.0.1`/`localhost` 访问，单用户自动登录专用 `local_tester` 测试账号，不部署公网。

## 8. 文件安全

不得删除或修改用户电脑中的其他文件。

只能在当前项目目录中工作，除非项目负责人明确要求操作其他位置。

修改文件前应先查看现有内容，避免覆盖用户已有工作。

`local-data/` 是本机生成媒体、缓存和未来语音资产目录，必须保持 Git 忽略。除非任务明确要求某个已知文件，不得让 Codex、搜索工具或测试递归读取该目录。

## 9. 测试与验证

每次完成开发后，都必须进行适合该功能的验证。

验证方式可以包括：

- 运行自动化测试。
- 启动本地开发服务。
- 手动访问页面。
- 调用本地接口。
- 检查日志。
- 检查数据库记录。

如果某次无法运行测试，必须说明原因，不能假装已经测试过。

## 10. 沟通要求

面向小白用户时，说明要尽量清楚、直接。

避免只说专业术语。必须使用专业术语时，要用简单语言解释。

每次任务结束后，必须用简短清单说明：

- 做了什么。
- 改了哪些文件。
- 怎么运行。
- 怎么验证。
## 2026-07-11 Cost Optimized GPU Session Rules

- The project is now prepared for single-user, low-frequency GPU sessions of at most about 6 hours.
- Clore.ai remains the primary GPU rental platform; RunPod is only a last-resort fallback.
- Clore scripts and session scripts must default to dry-run and must not create or cancel real orders unless a future task explicitly implements and confirms that path.
- The GPU runtime image must not contain Wan2.2 weights, `.env.local`, `.secrets`, prompts, videos, Supabase Secret keys, Clore API keys, R2 write credentials, SSH private keys, sessions, tokens, or signed URLs.
- Model cache priority is current Clore local dir, optional Clore persistent volume, private R2 cache, then official Hugging Face fallback.
- Fixed model is `Wan-AI/Wan2.2-TI2V-5B`; official size budget is 34.2GB; GPU disk reservation must stay at least 200GB.
- Real GPU servers may receive limited Worker credentials and optional read-only model cache credentials only.
- Real GPU servers must not receive `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CLORE_API_KEY`, R2 write credentials, `.env.local`, or SSH private keys.
- Do not expose ComfyUI, Jupyter, Gradio, or public inference ports.
- Local long-term results belong under `D:\AI-Video-Library` by default; remote Supabase video cleanup must stay dry-run unless future work explicitly implements verified 24h-safe deletion.

## 2026-07-11 Local Creation Studio Rules

- The local_lab web console may show Clore RTX 5090 candidates, wallet budget, session state, and dry-run order plans, but it must not call real `create_order` or `cancel_order` in this checkpoint.
- `CLORE_ORDER_EXECUTION_ENABLED=false` is the required default. Do not expose any `NEXT_PUBLIC_CLORE_*` secret or API key state to the browser.
- Order confirmation must use a short-lived one-time nonce, risk confirmation, and exact server-plus-price text.
- Local result serving must remain loopback-only, validate `job_id`, prevent directory traversal, support video Range reads, and never return absolute local paths or signed URL text.

## 2026-07-11 Default-Off Real Clore Execution Rules

- Guarded create/cancel execution code now exists, but it must remain disabled by default with `CLORE_ORDER_EXECUTION_ENABLED=false`.
- Do not run real `create_order`, real `cancel_order`, SSH, model download, or GPU rental unless a future task explicitly asks for real execution and confirms cost/risk.
- `clore:create:dry` must remain permanently dry-run and must reject `--execute`.
- Real create must require `--execute`, `--server-id`, `--max-price`, `--confirm-project=ai-video-platform-wan22`, a queued-job count, live Clore revalidation, active-order check, and create lock.
- Real cancel must verify the active project order, no processing job, no upload in progress, and final video uploaded.
- First real Wan2.2 session must process only one synthetic text prompt before pausing for user inspection.

## 2026-07-16 Clore Readiness and Host Bootstrap Rules

- Never derive or construct a Clore SSH hostname. Use the exact active-order API host and mapped port; valid Clore endpoints are not limited to one domain suffix.
- A closed order may have no endpoint even when its container was deployed. Do not classify `expired=true` as active, and do not infer readiness from a closed fixture.
- For password-parity orders, prove password SSH first, install the validated project public key, then prove key SSH in the same order. Keep the temporary password only in ignored local state and delete it during cleanup.
- Windows OpenSSH askpass must use an executable launcher such as `node.exe`; `.cmd` askpass files are not executable through its `CreateProcessW` path.
- Public Jupyter bootstrap containers may not contain `/workspace`. Create it before filesystem inspection, restore, or runtime bootstrap. Docker must remain optional for this host-native path.
- When `ssh_key` and `autossh_entrypoint=true` are sent together, Clore may install the key while disabling password authentication. Persist the observed password/key results and accept only a successful dedicated-key connection; never claim password success without evidence.
- A Clore proxy may reuse the same exact host and mapped port with a different host key for a later order. Before first contact for a newly returned order endpoint, remove only that `[host]:port` entry from the dedicated project known-hosts file and then use `StrictHostKeyChecking=accept-new`.
- Pre-bootstrap hardware inspection must report an absent PyTorch installation without failing. Runtime bootstrap owns installation of pinned Torch/ComfyUI packages.
