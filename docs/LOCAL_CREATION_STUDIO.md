# 本地创作台

## 2026-07-11 guarded Clore execution update

- local_lab 的 Clore 确认流已经接入默认关闭的真实执行链代码。
- 默认 `CLORE_ORDER_EXECUTION_ENABLED=false`，所以当前不会真实调用 `create_order`、不会创建订单、不会扣余额、不会 SSH、不会下载 Wan2.2。
- 二次确认现在包含 server、最高小时价、首轮预算 4.50 USD、余额保留 1.00 USD、380 分钟硬上限、Worker 等待上限、SSH-only、首轮只用合成文字提示词。
- 后端会重新检查 nonce、确认文本、风险勾选、queued 任务数、loopback 访问、实时 Clore 候选、钱包余额、SSH 公钥、Docker 镜像、active order 和 create lock。
- 真实执行链说明见 `docs/REAL_CLORE_EXECUTION.md`，首轮部署 dry-run 见 `docs/FIRST_WAN22_DEPLOYMENT.md`，紧急停止见 `docs/EMERGENCY_GPU_SHUTDOWN.md`。

`NEXT_PUBLIC_APP_MODE=local_lab` 时，首页会切换为本地 Wan2.2 创作台。

当前能力：

- 输入文字提示词并加入现有 `video_jobs` 队列，模型仍固定为 `standard-video`，页面显示为 `Wan2.2 TI2V-5B`。
- GPU 未启动时任务保持 `queued`，不会自动租用 Clore 主机。
- 右侧面板显示 Clore RTX 5090 候选、价格、配置、钱包预算和 dry-run 部署状态。
- 价格同时显示原始单位和归一化小时价；`14.99 USD/day` 会显示为约 `0.624583 USD/hour`。
- exact RTX 5090 的 `31 display_gb` 只按 5090 特定规则解释为 API 可用/取整显存，不降低其他 GPU 的显存标准。
- 二次确认窗口需要勾选风险确认并输入 `确认租用 <server_id>`。
- 本轮 `CLORE_ORDER_EXECUTION_ENABLED=false`，后端会拒绝真实下单，不调用 `create_order`。
- 本地结果 API 只允许 loopback 访问，只按 `D:\AI-Video-Library\YYYY-MM-DD\job_id` 结构读取 `output.mp4`、`thumbnail.jpg` 和 `metadata.json`，不会向前端返回本地绝对路径。

启动：

```powershell
npm run local-lab:setup
npm run dev:local
```

打开：

```text
http://127.0.0.1:3000
```

真实租用仍未开启。未来如果要开启，需要先实现真实 `create_order` 路径，并保持 nonce、二次确认、价格复查、queued 任务检查、SSH-only、无公网推理端口和无 Secret 外传这些保护。

## 2026-07-12 local_lab UI and deletion checkpoint

- Desktop keeps the GPU/host sidebar expanded in a reserved 380px column; it no longer depends on hover or a collapsed desktop rail.
- Narrow screens still use a click-open drawer.
- History cards include an accessible delete button and confirmation modal with thumbnail, creation time, and prompt preview.
- `processing` jobs cannot be deleted in the UI or API.
- `queued` jobs are canceled before deletion so the existing refund RPC path runs.
- Deletion cleans local `output.mp4`, `thumbnail.jpg`, `metadata.json`, matching private Supabase generated-video objects, and the local_tester-owned job record.
- The API remains local_lab-only, loopback-only, same-origin protected, local_tester role protected, and does not return absolute local paths.
- Host sorting defaults to normalized USD/hour low-to-high and supports price desc, reliability desc, and rating desc. Raw `USD/day` labels are display/audit data only.
- A selected host is kept only while it remains rentable; otherwise the selection is cleared and the user must choose again.
- Real Clore execution remains blocked until R2 model cache and a public custom runtime image are configured and verified.

## 2026-07-12 Model Cache Seed Status

- The local_lab session panel now exposes safe model-cache seed status only.
- It may show the cache prefix, `wan22-ti2v-5b/current.json`, whether presigned PUT and multipart planning are implemented, and that the GPU credential file is `.secrets/model-cache-readonly.env`.
- It must not show R2 access keys, R2 secret keys, presigned URLs, full endpoint query strings, `.secrets/model-cache-admin.env`, SSH details, prompts, videos, or absolute remote paths.
- The page remains a local control surface; it still does not create a Clore order while `CLORE_ORDER_EXECUTION_ENABLED=false`.
