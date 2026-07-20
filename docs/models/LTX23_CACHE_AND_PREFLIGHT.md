# LTX 缓存恢复与硬件预检（Stage 2）

缓存来源顺序固定为：当前本地缓存、未来只读 R2 缓存、上游模型站。Stage 2 只在临时假文件中实现计划与恢复，不读取 R2 凭据、不会访问上游，也不会发布或修改远端对象。

每个不可变清单声明模型键、角色、源仓库、revision、文件路径/字节数/SHA-256、许可证、Runtime 兼容版本、总大小、磁盘/RAM/VRAM下限、GPU 类别、T2V/I2V/原生音频能力、工作流 adapter 和 executable 状态。没有签名 URL，也没有 floating branch。

恢复器对每文件使用 `.part`，校验已存在最终文件，续写可恢复部分，校验 SHA-256 后原子重命名；写入恢复 journal，并将同一 `cacheRoot + modelKey + revision` 的并发调用合并为一次。取消清理当前 `.part`；过期 `.part` 清理由显式策略完成。测试覆盖本地命中、局部续传、校验不符、缺辅助文件、取消、并发抑制与 revision 匹配。

预检的硬性要求为：至少 24GB 可用显存、32GB 系统 RAM、模型包加临时空间所需的磁盘、PyTorch CUDA 可用、支持文件存在、不可变清单存在且 executable。64GB RAM 为建议值。RTX 5090 满足证据时是 planned pass；RTX 4090 返回条件 warning，直到真实验证。任意 Sulphur blocked 清单会产生 hard block。
## Stage 3A.1 preset gates

The 720p RTX4090, 720p RTX5090, and 1080p RTX5090 audible presets are blocked. Preflight must additionally prove input-audio conditioning, preservation, and the exact immutable dependency layout before any preset can become executable.
