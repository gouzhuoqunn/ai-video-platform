# RunPod Secure Cloud 最后备用方案

## 2026-07-10 status

- Clore.ai is now the only primary GPU rental platform.
- RunPod remains a last-resort fallback only; no Pod has been started.
- The GPU host security boundary is the same: load only limited Worker credentials, never `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, or `CLORE_API_KEY`.
- The user has executed Supabase migrations 0005, 0006, and 0007, and the limited Worker private upload loop has been verified.
- Do not download Wan2.2 weights until a real Secure Cloud GPU instance and persistent model volume are intentionally prepared.
- Do not expose ComfyUI, Jupyter, Gradio, FastAPI inference, or other public inference ports.

Only consider RunPod after an explicit future decision that Clore cannot provide an acceptable on-demand RTX 5090.

## 安全要求

- 不使用 Community Cloud 处理真实用户照片或视频。
- 不把 `SUPABASE_SECRET_KEY` 放到 Pod。
- 只使用受限 Worker 账号。
- 使用 Network Volume 保存模型。
- GPU Pod 关闭后模型卷保留。
- Pod 只运行主动轮询 Worker。
- 不公开 ComfyUI、Jupyter、Gradio 或 FastAPI 推理端口。

## 推荐结构

```text
/workspace/models/Wan2.2-TI2V-5B
/workspace/jobs/{job_id}
```

模型卷挂载到 `/workspace/models`，临时任务目录在 `/workspace/jobs`，任务结束清理 jobs 目录。

## 部署步骤

1. 创建 Secure Cloud RTX 5090 Pod。
2. 绑定 Network Volume，至少 150GB，推荐 200GB。
3. 使用本仓库 `gpu-worker/Dockerfile` 构建镜像。
4. 注入 `.secrets/gpu-worker.env` 中的受限 Worker 凭据。
5. 设置 `WAN_RUNNER=real`。
6. 下载官方 `Wan-AI/Wan2.2-TI2V-5B` 权重到 Network Volume。
7. 启动 Worker。
8. 提交测试任务，确认输出视频在 Supabase 私有 `generated-videos` bucket。

## 关闭

停止 Pod 后检查 RunPod 控制台，确认 GPU 计算资源不再计费。保留 Network Volume 会继续产生存储费用，后续不需要时再手动删除。
## 2026-07-11 cost-optimized Clore update

- RunPod remains a last-resort fallback only.
- The current primary path is Clore with explicit short sessions, local/R2/Hugging Face model cache, and local video archive.
- No RunPod Pod was started, no GPU was rented, no Wan2.2 weights were downloaded, and no public deployment happened in this checkpoint.
- If RunPod is ever reconsidered, it must keep the same boundary: no Supabase Secret key, no Clore API key, no R2 write credentials, no public ComfyUI/Jupyter/Gradio ports, and no real user media in first tests.
