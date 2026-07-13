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

- No ComfyUI runtime image has been built from this plan.
- No custom ComfyUI node has been installed or verified.
- No FLUX.2 or Wan A14B metadata has been verified beyond the existing Wan2.2 TI2V-5B pin.
- No benchmark has been run on RTX 4090 or RTX 5090 hardware.
- No model cache object has been uploaded to R2 for these new profile slots.
- No benchmark winner has been promoted to production. Promotion remains a manual approval step.

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
