# Supabase 设置说明

本文面向没有数据库经验的同学。你只需要复制本项目提供的完整 SQL 文件，到 Supabase 后台执行。不要手动一列一列创建表。

## 1. 准备 Supabase 项目

1. 打开 Supabase 官网并登录。
2. 进入你的 Supabase 项目。
3. 在项目首页确认这是你准备给 AI Video Platform 使用的项目。

## 2. 配置本地环境变量

在 Supabase 项目后台找到 Project Settings，然后进入 API 页面。

你只需要复制这两个公开值：

- Project URL
- Publishable key 或 anon public key

在项目根目录创建 `.env.local`，内容格式如下：

```env
NEXT_PUBLIC_SUPABASE_URL="粘贴你的 Project URL"
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="粘贴你的 Publishable key"
```

重要提醒：

- 不要把 Secret key 写进项目。
- 不要把 service_role key 写进项目。
- 不要把数据库密码写进项目。
- 不要把 `.env.local` 发给别人。

## 3. 打开 SQL Editor

1. 回到 Supabase 项目后台。
2. 左侧菜单找到 SQL Editor。
3. 点击 New query，新建一个 SQL 查询页面。

## 4. 先执行账号与积分迁移

在本地项目中打开：

```text
supabase/migrations/0001_auth_profiles_and_credits.sql
```

这个文件会创建：

- `profiles`：用户资料表。
- `credit_accounts`：积分账户表。
- `credit_transactions`：积分流水表。
- 新用户自动初始化触发器。
- Row Level Security 安全策略。

复制完整 SQL 到 Supabase SQL Editor，点击 Run。

## 5. 再执行视频任务迁移

账号与积分迁移成功后，在本地项目中打开：

```text
supabase/migrations/0002_video_jobs.sql
```

这个文件会创建：

- `video_jobs`：真实视频任务记录表。
- `create_video_job(p_prompt, p_model_key)`：安全创建排队任务函数。
- `cancel_video_job(p_job_id)`：安全取消 queued 任务函数。
- `video_jobs_select_own`：只允许用户读取自己任务的 RLS 策略。

复制完整 SQL 到 Supabase SQL Editor，点击 Run。

重要说明：

- 本迁移不会连接 GPU。
- 本迁移不会生成真实视频。
- `0002` 阶段任务费用固定为 `0`；执行 `0003` 后会启用真实扣费和退款。
- `0002` 不会创建 Storage Bucket；执行 `0003` 后会创建私有 `generated-videos` bucket。
- 浏览器客户端不能直接 `insert`、`update`、`delete` `video_jobs`。
- 浏览器客户端不能直接修改任务状态、费用、输出地址或错误信息。

## 6. 最后执行Worker、存储和积分迁移

执行 `0001` 和 `0002` 后，在本地项目中打开：

```text
supabase/migrations/0003_worker_storage_credits.sql
```

这个文件会：

- 扩展 `video_jobs`，增加进度、Worker lease、尝试次数、私有输出路径、扣费/退款时间。
- 重写 `create_video_job`：轻量模型扣 5 积分，标准模型扣 10 积分。
- 重写 `cancel_video_job`：只能取消 queued 任务，并原子退款。
- 创建 Worker RPC：领取、心跳、完成、失败、过期恢复。
- 创建私有 `generated-videos` bucket。
- 只允许登录用户读取自己路径下的视频对象。

复制完整 SQL 到 Supabase SQL Editor，点击 Run。

重要说明：

- 仍然不会连接真实 GPU。
- 仍然不会运行真实 AI 视频模型。
- 不会创建公开视频桶。
- 不会生成永久公开视频 URL。
- Worker RPC 只授权 `service_role`，普通浏览器用户不能调用。

## 7. 复制完整 SQL

### 重要：0004 集成测试修复

用户已经执行过 `0003_worker_storage_credits.sql`。远程集成测试发现 `create_video_job` 中存在 PostgreSQL 变量名冲突，会报：

```text
column reference "user_id" is ambiguous
```

用户当前已经在远程 Supabase 项目中执行过：

```text
supabase/migrations/0004_integration_fixes.sql
```

`0004` 只重新定义 `create_video_job` 和 `cancel_video_job`，不会写入密钥，不会连接 GPU，不会创建公开 bucket。当前远程验证和集成测试已经确认 0004 生效。

```powershell
npm run test:integration
```

### 后续：0005 受限 GPU Worker 角色

本仓库已经准备：

```text
supabase/migrations/0005_limited_gpu_worker_role.sql
```

`0005` 让未来真实 GPU Worker 使用受限 Supabase Auth 用户，不再把服务器 Secret key 放到第三方 GPU 机器。当前阶段不要执行 0005；等进入真实 GPU 部署前再手动审查并执行。

从文件第一行开始，复制到最后一行。不要只复制其中一部分。

## 8. 粘贴并点击 Run

1. 把完整 SQL 粘贴到 Supabase SQL Editor。
2. 检查页面里没有多余内容。
3. 点击 Run。
4. 如果成功，Supabase 会显示执行完成。

## 9. 检查表、函数和私有bucket

执行 `0001` 成功后：

1. 打开左侧 Table Editor。
2. 找到 `profiles`。
3. 找到 `credit_accounts`。
4. 找到 `credit_transactions`。

如果三张表都能看到，说明表结构已经创建成功。

执行 `0002` 成功后：

1. 打开 Table Editor。
2. 找到 `video_jobs`。
3. 打开 Database Functions 或 SQL Editor，确认有 `create_video_job` 和 `cancel_video_job`。

执行 `0003` 成功后：

1. 打开 Table Editor。
2. 打开 `video_jobs`，确认能看到 `progress`、`worker_id`、`output_video_path` 等新字段。
3. 打开 Storage。
4. 确认存在 `generated-videos` bucket。
5. 确认 bucket 是 private，不是 public。
6. 打开 Database Functions，确认有 `claim_next_video_job`、`heartbeat_video_job`、`complete_video_job`、`fail_video_job`、`requeue_stale_video_jobs`。

## 10. 创建测试账号

1. 回到本地项目。
2. 启动网站：

```powershell
npm run dev
```

3. 浏览器打开：

```text
http://localhost:3000/login
```

4. 输入测试邮箱和密码。
5. 点击注册。

如果你的 Supabase 项目开启了邮箱确认，你需要打开邮箱，点击 Supabase 发来的确认链接。

## 11. 确认测试账号获得 100 积分

注册成功后，回到 Supabase Table Editor：

1. 打开 `profiles`，应该能看到一条新用户资料。
2. 打开 `credit_accounts`，应该能看到该用户的 `balance` 是 `100`。
3. 打开 `credit_transactions`，应该能看到一条 `signup_bonus` 积分流水，金额是 `100`。

也可以回到网站首页，点击右上角头像。如果已经登录，账户面板会尝试读取真实积分余额。

## 12. 测试真实视频任务记录

执行 `0002` 后：

1. 打开网站首页：

```text
http://localhost:3000
```

2. 确认已经登录。
3. 输入提示词。
4. 选择轻量视频模型或标准视频模型。
5. 点击“提交排队任务”。
6. 页面应该显示真实任务编号，并显示“排队中”。
7. 轻量模型会扣 5 积分，标准模型会扣 10 积分。
7. 打开：

```text
http://localhost:3000/history
```

8. 应该能看到刚刚创建的任务。
9. 刷新页面后，任务仍然存在。
10. queued 任务可以点击“取消任务”。
11. 取消后状态显示“已取消”，再次取消会被拒绝。
12. 取消 queued 任务后积分应该退回。

如果选择了首帧图片，页面只会本地预览。提交时会提示“首帧上传将在后续版本开放”，不会上传图片，也不会把 base64 写入数据库。

## 13. 配置服务器Secret key

模拟 Worker 和签名 URL API 需要服务器 Secret key。

在 Supabase 后台找到 Project Settings -> API。优先使用新的 Secret key。如果你的项目界面只有旧版 `service_role` key，可以作为兼容后备。

写入本地 `.env.local`：

```env
SUPABASE_SECRET_KEY="只放在本机，不要发给任何人"
```

或旧版兼容：

```env
SUPABASE_SERVICE_ROLE_KEY="只放在本机，不要发给任何人"
```

安全提醒：

- Secret key 可以绕过普通用户权限，不能截图发给别人。
- 不能写进 `NEXT_PUBLIC_` 变量。
- 不能提交到 Git。
- 修改 `.env.local` 后需要重启 `npm run dev` 和 `npm run worker:mock`。

## 14. 确认视频不是公开URL

成功任务的数据库里只保存 `output_video_path`，例如：

```text
user_id/job_id/output.mp4
```

不要把公开视频 URL 写进数据库。网页播放时会请求：

```text
/api/video-jobs/[id]/signed-url
```

这个接口只给当前登录用户自己的 succeeded 任务返回 15 分钟短期链接。

## 15. 常见错误

### 登录页提示缺少 Supabase 环境变量

说明 `.env.local` 没有配置，或变量名写错了。请检查：

```env
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
```

修改 `.env.local` 后，停止并重新启动 `npm run dev`。

### 注册后没有看到 100 积分

可能原因：

- 迁移 SQL 没有执行成功。
- Supabase 要求邮箱确认，但你还没有确认邮箱。
- 你注册的是旧账号，触发器只会在新用户创建时自动执行。

可以重新创建一个新的测试邮箱账号再试。

### 页面可以登录，但积分显示读取失败

可能原因：

- 没有执行迁移 SQL。
- RLS 策略没有创建成功。
- 当前登录账号不是积分记录对应的账号。

请重新确认 `credit_accounts` 表里有当前用户对应的记录。

### 首页提示无法读取视频任务或任务提交失败

可能原因：

- 没有执行 `supabase/migrations/0002_video_jobs.sql` 或 `0003_worker_storage_credits.sql`。
- 只复制了 SQL 的一部分。
- `0002` 执行前没有先执行 `0001`，导致 `set_updated_at` 触发器函数不存在。
- 当前没有登录，匿名用户不能提交或读取任务。

请先完整执行 `0001`，再完整执行 `0002`，最后完整执行 `0003`。

### Worker启动后提示缺少Secret key

说明 `.env.local` 没有配置 `SUPABASE_SECRET_KEY` 或 `SUPABASE_SERVICE_ROLE_KEY`。配置后重启 Worker。

### Worker提示没有本地演示视频

请准备：

```text
public/mock-videos/demo.mp4
```

或设置：

```env
MOCK_VIDEO_SOURCE="D:\本地路径\demo.mp4"
```

### 超过3条活跃任务

同一用户最多只能有3条 `queued` 或 `processing` 任务。请等待后续 Worker 处理，或在历史记录页取消 queued 任务。

### SQL Editor 报错

请不要手动拆分 SQL。重新打开迁移文件，复制完整内容，再粘贴执行。

如果报“already exists”一类提示，通常说明部分对象已经创建过。当前迁移尽量使用了 `if not exists` 和 `drop policy if exists`，可以再次整体执行。

## 16. 安全提醒

- 不要泄露 Secret key。
- 不要泄露 service_role key。
- 不要泄露数据库密码。
- 不要把 `.env.local` 提交到 Git。
- 不要在聊天窗口、截图或文档里展示真实密钥。
- 普通网页只使用 Publishable key；模拟 Worker 和签名 URL API 才使用服务器 Secret key。
- 不要通过浏览器直接修改任务状态、费用或视频输出地址。
- 不要手动写入 `generation_charge` 或 `generation_refund`，应通过数据库函数完成。

## 17. 用户最终需要手动完成的动作

1. 在 Supabase SQL Editor 依次执行 `0001`、`0002`、`0003`、`0004`。
2. 确认 `generated-videos` bucket 是 private。
3. 在 `.env.local` 配置 `SUPABASE_SECRET_KEY`。
4. 运行 `npm run mock-video:generate` 生成 `public/mock-videos/demo.mp4`，或设置 `MOCK_VIDEO_SOURCE`。
5. 重启网站：

```powershell
npm run dev
```

6. 另开终端运行：

```powershell
npm run worker:mock
```

7. 登录网站创建任务，观察进度、播放和下载。

真实 GPU 部署前，再审查并执行 `0005_limited_gpu_worker_role.sql`。
