# Mock Worker Setup

本文面向没有后端经验的同学。这个 Worker 只是本地模拟流程：它不会连接真实 GPU，不会运行真实视频模型，只会把你本地准备好的 MP4 当作“生成结果”上传到 Supabase 私有桶。

## 工作原理

1. 网站创建 `queued` 任务并扣积分。
2. `npm run worker:mock` 调用 `claim_next_video_job` 领取任务。
3. Worker 依次更新进度：5、20、45、70、90。
4. Worker 上传本地演示视频到私有 `generated-videos` bucket。
5. Worker 调用 `complete_video_job` 把任务改成 `succeeded`。
6. 网页请求短期签名 URL 播放或下载视频。

## 准备步骤

1. 在 Supabase SQL Editor 依次执行：

```text
supabase/migrations/0001_auth_profiles_and_credits.sql
supabase/migrations/0002_video_jobs.sql
supabase/migrations/0003_worker_storage_credits.sql
```

2. 在 Supabase 后台找到服务器 Secret key。

不要把 Secret key 发给任何人，不要截图，不要提交到 Git。它只能放在你本地 `.env.local`。

3. 在 `.env.local` 增加：

```env
SUPABASE_SECRET_KEY="粘贴你的服务器Secret key"
```

如果你的 Supabase 后台只有旧版 service_role key，可以临时使用：

```env
SUPABASE_SERVICE_ROLE_KEY="粘贴你的service_role key"
```

4. 生成演示视频。

项目现在可以自动生成原创测试视频，不需要下载 MP4：

```powershell
npm run mock-video:generate
```

生成位置：

```text
public/mock-videos/demo.mp4
```

也可以设置：

```env
MOCK_VIDEO_SOURCE="D:\本地路径\demo.mp4"
```

生成的视频是 1280×720、24fps、约 4.5 秒、H.264、yuv420p、无声音的合成测试图案。文件已经被 Git 忽略，不要提交。

5. 启动网站：

```powershell
npm run dev
```

6. 另开一个终端启动 Worker：

```powershell
npm run worker:mock
```

如果只想让 Worker 尝试处理一条任务并退出，运行：

```powershell
npm run worker:mock:once
```

一次性模式没有任务时会正常退出；有任务时只处理一条，成功或失败后退出，适合自动集成测试。

可以用下面的命令自动验证两种分支：

```powershell
npm run worker:mock:once:test
```

该命令会先验证没有任务时正常退出，再创建临时测试用户和临时任务，确认 Worker 能领取、更新进度、上传 `demo.mp4`、完成任务、生成私有路径，并在最后清理临时数据。

7. 打开首页，登录后创建任务。

8. 观察进度从排队中变成生成中，再变成已完成。

9. 任务完成后，在首页或历史记录页播放视频。

10. 点击下载按钮测试下载。下载链接是短期签名 URL，不会永久保存。

## 测试取消、失败、余额不足

- 取消：创建任务后，在 Worker 领取前到历史页取消 queued 任务，应退还积分。
- 失败退款：可以临时把 `MOCK_VIDEO_SOURCE` 指向不存在的文件，或让上传失败，再确认任务失败并退款。
- 余额不足：多次创建任务直到余额不足，应看到明确提示，不创建任务、不写扣费流水。

## 用户需要手动完成的动作

1. 执行 0001、0002、0003、0004 迁移。
2. 在 `.env.local` 配置 `SUPABASE_SECRET_KEY`。
3. 运行 `npm run mock-video:generate`，或设置 `MOCK_VIDEO_SOURCE`。
4. 重启 `npm run dev`。
5. 另开终端运行 `npm run worker:mock`。

除此之外，本阶段不需要连接真实 GPU，不需要创建支付，不需要部署公网。

后续真实 GPU Worker 会改用 `gpu-worker/` 中的 Python 进程和受限 `gpu_worker` 账号。当前 mock Worker 仍然只用于本地开发和集成测试。
