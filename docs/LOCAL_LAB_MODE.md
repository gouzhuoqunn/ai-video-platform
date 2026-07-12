# 本地 AI 生成实验台模式

## 2026-07-11 Clore read-only checkpoint

Clore has now been queried in read-only mode only. Wallet/status/marketplace checks succeeded, but no compliant RTX 5090 candidate was found under the current `0.70` USD/hour cap and 6 hour planning window. No order was created, no GPU was rented, no SSH connection was opened, and no model weights were downloaded.

## 为什么临时改成单用户本地模式

当前优先目标是尽快跑通 Clore 云端 RTX 5090 上的 Wan2.2 真实视频生成，而不是先发布一个任何人都能访问的商业网站。所以项目新增 `local_lab` 模式：网页只在当前笔记本本机运行，只给用户本人使用。

## 暂时隐藏的商业功能

本地实验模式会隐藏或弱化：

- 注册入口。
- 充值和购买积分。
- 账号密码设置。
- 邀请奖励。
- 设备奖励。
- 商业营销说明。
- 多模型选择、首帧上传、图片模型、音频模型、超分和 15 秒视频。

这些功能没有被删除。关闭 `local_lab` 后，原来的完整网站模式仍然保留登录、积分、任务、历史、私有视频和退款逻辑。

## 仍然保留的底层功能

本地实验模式仍然使用已有的：

- Supabase Auth。
- 积分账户和扣费/退款 RPC。
- `video_jobs` 任务队列。
- Worker RPC。
- 私有 `generated-videos` Storage。
- 成功视频的短期签名 URL。

本轮不修改 0001 到 0007 迁移，也不新增数据库迁移。

## 首次启动步骤

```powershell
npm install
npm run local-lab:setup
npm run dev:local
```

浏览器打开：

```text
http://127.0.0.1:3000
```

`local-lab:setup` 会创建或确认一个专用本地测试账号，把随机强密码写入 `.secrets/local-lab.env`，并把该账号余额设置为 `1000000000`。脚本不会在终端打印完整密码。

## 日常启动步骤

```powershell
npm run dev:local
```

页面会通过 `/api/local-lab/session` 自动恢复本地测试会话，不需要每次手动输入账号密码。

## 为什么显示无限积分

本地实验模式的目标是反复测试 Wan2.2 生成流程，所以页面显示：

```text
积分：∞
```

但数据库没有使用真正的无限值，也没有使用负数。专用测试账号实际余额是一个很大的有限整数 `1000000000`，后端仍然按现有 `standard-video` 逻辑扣 10 积分，取消或失败仍按原逻辑退款。这样能保留已经验证过的积分安全边界。

## 为什么只能通过 127.0.0.1 访问

本地实验模式不是公网产品，也不允许局域网其他设备访问。`npm run dev:local` 和 `npm run start:local` 都绑定：

```text
127.0.0.1:3000
```

同时服务器端 proxy 会在 `LOCAL_LAB_ENABLED=true` 时检查请求 Host，只允许 `localhost`、`127.0.0.1` 和 IPv6 loopback。其他 Host 会返回 403。

不要使用 ngrok、Cloudflare Tunnel、Vercel、公网隧道或局域网 IP 访问本地实验台。

## 当前 GPU 尚未启动

本轮没有调用真实 Clore API，没有创建 Clore 订单，没有租 GPU，没有下载 Wan2.2 权重，也没有运行真实模型。页面会提示：

```text
云端GPU尚未启动。配置Clore并启动Worker后，此任务将自动处理。
```

## 任务为什么会停在 queued

当前没有真实 GPU Worker 在线领取任务。提交任务后，`create_video_job` 会正常写入 `video_jobs`，状态是 `queued`。等后续 Clore GPU Worker 启动后，Worker 会通过已有 RPC 自动领取并处理这些任务。

## 下一步如何接 Clore

本轮只改本地网页模式。后续真正租用前再运行只读 Clore 命令：

```powershell
npm run clore:find
npm run clore:wallet
npm run clore:create:dry
```

只有确认候选、余额、SSH、公钥、Docker 镜像和安全边界后，才进入真实订单执行任务。本轮不配置 Clore、不租 GPU。

## Wan2.2 跑通后如何增加图片模型

第一阶段只验证：

```text
Wan2.2 TI2V-5B
文生视频
5秒
1280×704
24fps
```

第一段真实视频成功后，再逐步接入文字生图、首帧生视频、图片上传和更多模型。当前 UI 不展示这些入口，避免误以为它们已经可用。

## 如何恢复完整网站模式

不要使用 local 命令，改回普通命令即可：

```powershell
npm run dev
```

并确保没有设置：

```env
NEXT_PUBLIC_APP_MODE=local_lab
LOCAL_LAB_ENABLED=true
```

普通模式会恢复真实登录、真实积分显示、普通模型菜单、充值未开放提示和完整网站流程。

## 如何安全重置本地测试数据

先 dry-run 查看会清理什么：

```powershell
npm run local-lab:reset:dry
```

确认后再执行：

```powershell
npm run local-lab:reset -- --execute
```

重置只允许操作 `app_metadata.role = local_tester` 的专用本地测试账号：删除该账号的任务、该账号路径下的私有视频对象和测试积分流水，然后把余额恢复到 `1000000000`。它不会删除普通用户、不会删除 `gpu_worker` 账号，也不会删除 Supabase 中其他用户的视频。
## 2026-07-11 local archive and cost-optimized GPU prep

- Local lab remains the temporary priority and must stay loopback-only at `127.0.0.1` or `localhost`.
- Supabase private Storage is the short-term relay; the prepared long-term local archive default is `D:\AI-Video-Library`.
- Future local archive structure is `YYYY-MM-DD/job_id/output.mp4`, `metadata.json`, and `thumbnail.jpg`.
- Remote cleanup is dry-run only in this checkpoint and must require local verification plus at least 24 hours retention before any future delete.
- The Clore GPU session plan remains explicit-start only; queued local-lab jobs must not automatically rent a GPU.
- No GPU was rented, no Wan2.2 weights were downloaded, no R2 resources were created, and no public deployment happened.

## 2026-07-11 local creation studio

- The local_lab homepage is now a light single-page creation studio, not the dark commercial demo layout.
- Users can keep adding text prompts to the existing `video_jobs` queue. The submit button is named "加入生成队列" to avoid implying the GPU is already online.
- The right-side panel shows RTX 5090 host candidates, price/budget information, deployment session state, local archive status, and dry-run stop controls.
- Host selection and "准备租用" generate only an order plan and one-time nonce. The second confirmation dialog requires a checkbox plus `确认租用 <server_id>`.
- Real order creation remains disabled by `CLORE_ORDER_EXECUTION_ENABLED=false`; this checkpoint still does not call `create_order`.
- The local results API serves only loopback requests and never exposes absolute paths, raw Supabase object paths, signed URL text, or secrets.
