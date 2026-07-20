# LTX 2.3 生产清单（Stage 3A）

本阶段没有下载模型、没有运行推理、没有写入 R2，也没有调用 GPU 或供应商。

机器可读清单位于 `ltx-runtime/manifests/production/`，其中也有单独的 Gemma、空间上采样器与可选蒸馏 LoRA 辅助资产清单。清单的 `manifestSha256` 是删去该字段后、递归按键排序的 JSON 的 SHA-256；校验失败即拒绝运行。不会使用 `current.json` 或任何浮动 `main` 引用。

首选 `Civitai/Sulphur-2-distilled-fp8` 保持 `blocked`：公开材料只能指向期望文件名 `sulphur_distil_fp8mixed.safetensors`，尚没有可审计的不可变修订、字节数、SHA-256、许可、辅助文件闭包以及官方 `DistilledPipeline` 兼容性证据。它绝不会静默降级为官方 LTX。

次选 `SulphurAI/Sulphur-2-base` 记录了已知文件 `sulphur_dev_fp8mixed.safetensors` 和 SHA-256 `41c999575859c528ff108022246a5524960a778c18742696971c9b0aadb4f70f`，但许可证、完整修订/字节数和完整两阶段辅助资产仍未锁定，因此同样阻断。

官方基线固定为 `Lightricks/LTX-2.3-fp8@1d756cd27fa11c0896c4dfee093cd1bf36c7f7a1`，并记录蒸馏 FP8 工件 SHA-256 `d9646b6f2d5c42d337b23671634c43bfeece6989644f51b4a3aa088465ccd3b2`。它是兼容性基线，不是 Sulphur 的替代执行项；Gemma 与空间上采样器尚未完成不可变资产锁定，仍不可执行。

缓存命名空间固定为 `ltx23/<internal-model-key>/<manifest-sha256>/`。未来恢复顺序为本地 Clore 缓存、可选只读 R2、经明确确认的官方源；本阶段不执行恢复或发布。
