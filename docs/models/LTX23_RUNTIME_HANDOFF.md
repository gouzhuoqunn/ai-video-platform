# LTX23 Runtime Handoff

`video_ltx_native_audio` is a typed queue and execution contract only. Before any Runtime work, a maintainer must capture a full immutable revision, exact artifact size and digest/Xet identity, license approval, all supporting files, a compatible audio-video workflow, and pinned package versions. The Runtime preflight must verify 24 GB VRAM minimum, 32 GB RAM minimum, 64 GB recommended RAM, disk, CUDA/runtime, model load, an MP4 video stream, an MP4 audio stream, seekability, duration tolerance, SHA-256, cancellation recovery, and task/result identity.

Do not load a Sulphur full checkpoint with a distill LoRA at the same time. They are alternatives until source documentation proves otherwise.

## Stage 2 handoff update

The selected future implementation is a narrow adapter over the official `Lightricks/LTX-2` `ltx-pipelines` package, not a Wan conditional and not a production ComfyUI dependency. The repository now has a mock-only Runtime contract, native-audio FFprobe validator, cache planner, preflight, and model-scoped session driver. Its local command is `npm run ltx:runtime:dry`; it creates and deletes only temporary synthetic media.

`Lightricks/LTX-2.3-fp8` revision `1d756cd27fa11c0896c4dfee093cd1bf36c7f7a1` is a compatibility baseline with a verified development-FP8 artifact digest, but it remains non-executable until auxiliary files and the official Python Runtime lock are closed. Sulphur remains blocked.
