# Model Benchmark Plan

Date: 2026-07-14

This is a versioned planning and metadata-audit document. It does not download a model, build a runtime image, start a GPU, create a Clore order, connect over SSH, or upload to R2.

## First-Round Official Baselines

| Profile slot | Candidate | Repository and immutable revision | License and access | Reported repository size |
| --- | --- | --- | --- | --- |
| `rtx4090/image` | FLUX.2 Klein 4B Distilled FP8 | `black-forest-labs/FLUX.2-klein-4b-fp8` at `5b4408e59397a4a37ccb46afe426d8ed86379441`, plus `Comfy-Org/vae-text-encorder-for-flux-klein-4b` at `a9e4ca87c16db4c4e1a16406a9ddb300ab0ae246` | Apache-2.0, public, anonymous metadata readable | 12.45 GB |
| `rtx4090/video` | Wan2.2 TI2V-5B | `Wan-AI/Wan2.2-TI2V-5B` at `921dbaf3f1674a56f47e83fb80a34bac8a8f203e` | Apache-2.0, public, anonymous metadata readable | 34.20 GB |
| `rtx5090/image` | FLUX.2 Klein 9B FP8 | `black-forest-labs/FLUX.2-klein-9b-fp8` | FLUX Non-Commercial, gated | 9.44 GB |
| `rtx5090/video` | Wan2.2 I2V-A14B | `Wan-AI/Wan2.2-I2V-A14B` at `206a9ee1b7bfaaf8f7e4d81335650533490646a3` | Apache-2.0, public, anonymous metadata readable | 126.21 GB |

The 9B model is intentionally **not** given a guessed revision. Its terms must be explicitly accepted before a complete SHA, files, and content hashes can be read. It is registered as a gated first-round baseline but is not executable.

Official sources: [FLUX.2 Klein 4B FP8](https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8), [FLUX.2 Klein 9B FP8](https://huggingface.co/black-forest-labs/FLUX.2-klein-9b-fp8), [Wan TI2V-5B](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B), [Wan I2V-A14B](https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B), [ComfyUI FLUX.2 guide](https://docs.comfy.org/tutorials/flux/flux-2-klein), and [ComfyUI Wan2.2 guide](https://docs.comfy.org/tutorials/video/wan/wan2_2).

## Metadata Boundary

- The registry records repository, full revision when public, license, gated state, anonymous readability, reported sizes, storage method, known Xet/content hash, architecture, dtype, required components, workflow source, commercial-use flag, and update date.
- A missing model-file SHA is `pending_download_verification`; it is never fabricated.
- FLUX.2 Klein 4B Distilled FP8 now has its public auxiliary Qwen text encoder and VAE files locked from the actual public Hugging Face repository name `Comfy-Org/vae-text-encorder-for-flux-klein-4b`. The misspelling is part of the repository URL, not a local rename.
- The official FLUX.2 Klein 4B Comfy template is locked from `Comfy-Org/workflow_templates` commit `192a158125390ce3caf4c64d38d406eaab85cd68`, but it is a subgraph workflow. It must be unpacked or registered before a real GPU smoke run.
- The official Wan native README's 80 GB A14B reference requirement is recorded separately from the RTX 5090 profile. A 5090 result is only a future offload benchmark, not a claim of official support.
- FLUX.2 Klein 9B's non-commercial license is a visible deployment blocker for this product until licensing is resolved.

## Capacity and Shared Components

Reported first-round repository totals are 182.30 GB. The conservative deduplicated total remains **182.30 GB** because only matching content hashes may deduplicate files.

| Scope | Primary repositories | With 20% reserve |
| --- | ---: | ---: |
| RTX 4090 session | 46.65 GB | 55.98 GB |
| RTX 5090 session | 135.65 GB | 162.78 GB |
| All four baseline repositories | 182.30 GB | 218.76 GB |

Potential shared components are FLUX VAE files, FLUX Qwen text encoders, and Wan UMT5/VAE files. The FLUX 4B Qwen/VAE auxiliary files and Wan native UMT5 file have recorded content hashes, but no cross-repository deduplication is performed until another exact content hash matches. Profile manifests will reference a future `shared/sha256/<hash>` object rather than copy a verified shared component.

`benchmark-staging/` may be cleaned after rejected-candidate metrics and thumbnails are retained. Production remains `staging -> complete verification -> revision manifest -> current.json last`.

## Hardware Gates

- RTX 4090: exact model, 24 GB VRAM, 32 GB RAM hard / 96 GB preferred, 200 GB disk hard, aggressive offload.
- RTX 5090: exact model, 31/32 GB display-memory tolerance only for exact RTX 5090, 80 GB RAM hard / 128 GB preferred, 250 GB disk hard, balanced offload.
- The scheduling helper takes the larger of the hard disk floor and the model-sync total plus 20%. The current hard floors remain larger than the incomplete first-round session estimates.
- Image and video models are not resident together: batch images, unload and clear CUDA cache, then load video.

## Versioned Test Suite

`benchmarks/v1/` has eight fixed image samples and eight fixed video samples. The root `benchmark/` JSON files mirror the suite for review and future runner input. Prompts, negative prompts, seeds, size, frame count, FPS, steps, input asset references, evaluation dimensions, and timeouts are versioned. The only fixture is a tiny repository-owned synthetic PPM with a recorded SHA256; there are no real people, unclear-copyright assets, adult content, gore, or violence prompts.

Smoke tests run one low-resolution image or one 480P short video twice. They verify startup, fixed nodes, OOM, valid output, no second-run memory leak, and safe unload. Quality tests require 100% smoke success and then record cold/warm timing with the same seed. Video testing stays at 480P before any 720P run; I2V and FLF2V are distinct categories.

Objective metrics are stored independently from 1–5 human review scores. Blind review IDs omit model identity. Software cannot select a winner by speed or promote any candidate to production.

## Promotion Rule

Manual approval is required after all of: smoke pass, no unrecoverable OOM, three stable runs, verified unload/switch, readable output, fixed workflow and dependencies, immutable revision, acceptable license, profile cost compliance, and passing human quality review. Only these four pointers can eventually exist: `rtx4090/image`, `rtx4090/video`, `rtx5090/image`, `rtx5090/video`.

## Runtime Build Checklist

Version one includes only the pinned ComfyUI commit, official native nodes, FFmpeg, a local API controller, health check, GPU/RAM metrics, model unload/cache cleanup, and R2 sync tooling. It excludes all model weights, ComfyUI-GGUF, Kijai, Phr00t nodes, unfixed community nodes, and secrets. ComfyUI remains bound to `127.0.0.1` or an internal container interface. Community runtime work requires a separate immutable image tag or verifiable plugin layer.
