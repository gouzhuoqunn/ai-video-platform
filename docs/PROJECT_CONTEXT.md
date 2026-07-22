# Project Context

## Active product

The active product is an image-only, local-first FLUX creation workspace. The only active task API is `/api/local-lab/image-tasks`; tasks are stored in ignored project-local state under `.secrets/image-studio/tasks.json`.

## Image task contract

- Stack: `FLUX.1-dev FP8`, `Fluxed Up 10.2`, `AIDMA NSFW Unlock LoRA`.
- Prompt is required; a reference image is optional and uses reference-aware FLUX Kontext semantics.
- Supported controls: steps 25–40, LoRA 0.6–1.1, CFG 3.5–5.0, Euler or FlowMatch, and 768–2048 px dimensions in 256 px increments.
- Tasks at or below 1280×1280 use RTX 4090 (`低`); all larger dimensions use RTX 5090 (`高`).

## Archived product

Wan, LTX, long-video, old image runtime, Clore video session code, related routes, and historical docs live under `视频部分/` and are excluded from the active TypeScript build. There is no active video page, video API, video queue, or automatic paid-cloud action.
