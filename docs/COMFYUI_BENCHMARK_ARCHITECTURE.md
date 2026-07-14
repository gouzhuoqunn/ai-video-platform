# Unified ComfyUI Runtime and Benchmark Architecture

Date: 2026-07-14

This checkpoint is a preparation and mock-validation layer. It does not create Clore orders, open SSH, download models, run GPU inference, or upload model files to R2.

## Real Completion

- The existing Wan official runner and guarded Clore execution path remain unchanged.
- The local app now has stable route skeletons for `/generate/4090` and `/generate/5090`.
- Both profile pages reuse one `GenerationProfilePage` component and the confirmed light beige/white-card visual baseline.
- The homepage links to both profile pages without changing data source or Clore execution behavior.
- ComfyUI is pinned for future runtime work at commit `da2608926eaf68fd532bba4e1ace3402c5d21399`.

## Mock Completion

- `src/lib/generation/gpu-profiles.ts` defines shared `rtx4090` and `rtx5090` hardware profiles.
- `src/lib/generation/model-registry.ts` registers the initial image/video candidate slots without downloading any model.
- `src/lib/generation/workflow-registry.ts` defines mock ComfyUI API-format workflows for image T2I, video TI2V, video I2V, and video FLF2V.
- `src/lib/generation/comfy-runtime.ts` defines the website-to-ComfyUI controller contract and a mock client for submit, status, outputs, interrupt, and cache cleanup.
- `src/lib/generation/benchmark-runner.ts` defines the benchmark result shape, error classification, and a mock state-machine runner.
- `src/lib/generation/r2-cache-plan.ts` defines the future R2 layout with benchmark staging, production, shared components, workflows, manifests, and publish-last `current.json`.
- `comfy-runtime/` records the planned runtime contract, not a built image.

## Not Yet GPU Verified

- An independent ComfyUI runtime Docker scaffold and GitHub Actions workflow now exist, but no successful ComfyUI runtime image digest has been recorded in this document yet.
- No custom ComfyUI node has been installed or verified.
- No FLUX.2 or Wan A14B metadata has been verified beyond the existing Wan2.2 TI2V-5B pin.
- No benchmark has been run on RTX 4090 or RTX 5090 hardware.
- No model cache object has been uploaded to R2 for these new profile slots.
- No benchmark winner has been promoted to production. Promotion remains a manual approval step.

## 2026-07-14 Metadata Audit and Frozen Benchmark Plan

- First-round baseline slots are now frozen as FLUX.2 Klein 4B Distilled FP8, Wan2.2 TI2V-5B, FLUX.2 Klein 9B FP8, and Wan2.2 I2V-A14B.
- Public immutable revisions are recorded for the 4B, TI2V-5B, and A14B repositories. The 9B repository is explicitly gated under a non-commercial license, so it has no guessed revision and cannot enter a real sync or benchmark until the terms are accepted.
- `benchmarks/v1/` is a fixed text/configuration suite with eight image and six video samples plus a tiny synthetic input fixture. It contains no real people, model outputs, or copyrighted reference media.
- `docs/MODEL_BENCHMARK_PLAN.md` is the source of the first-round capacity plan, smoke/quality gates, human scoring, blind-review rule, and runtime-v1 checklist.
- This is an official-metadata and mock-plan checkpoint only. No GPU benchmark, model sync, runtime image build, R2 upload, or production promotion has happened.

## 2026-07-14 Stage 2.5 Runtime Scaffold

- `comfy-runtime/Dockerfile` defines a separate `ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime` image path and does not replace the Wan first-test runtime.
- The runtime pins ComfyUI commit `da2608926eaf68fd532bba4e1ace3402c5d21399`, starts ComfyUI on `127.0.0.1:8188`, and starts a project controller on `127.0.0.1:8080`.
- The base runtime includes only native ComfyUI plus the project controller. `ComfyUI-GGUF`, Kijai WanVideoWrapper, and other community nodes are optional locked layers and are not installed in the base image.
- `.github/workflows/comfy-runtime-image.yml` is the manual CI path for building and smoke-testing the new runtime. It uses linux/amd64, immutable tags, GHCR cache, SBOM/provenance, secret scan, no-model CPU smoke checks, and process/file checks that prevent old `gpu-worker/worker.py` autostart.
- Current CI blocker: GitHub will not dispatch a newly added workflow from a non-default branch. The workflow must first land on the default branch, but this task forbids modifying remote `main`, so no Comfy runtime image digest has been produced.
- `benchmark/` now contains JSON benchmark specs alongside the code-facing `benchmarks/v1` suite. The suite has eight image cases and eight video cases and does not include real people, unclear-copyright assets, adult content, gore, or violence prompts.

## Runtime Boundary

- The future ComfyUI service must bind to `127.0.0.1:8188` or an internal container interface only.
- It must not expose ComfyUI, Jupyter, Gradio, or public inference ports.
- Runtime images must not contain model weights, user media, prompts, `.env` files, secrets, SSH private keys, signed URLs, Supabase service keys, Clore API keys, or R2 write credentials.

## Production Cache Rule

Production may eventually contain exactly four profile pointers:

- `rtx4090/image`
- `rtx4090/video`
- `rtx5090/image`
- `rtx5090/video`

Shared VAE, CLIP, and text encoder files should be stored once under `shared/` and referenced by manifests. Benchmark failures can only affect `benchmark-staging/`; they must not publish or modify production `current.json`.
