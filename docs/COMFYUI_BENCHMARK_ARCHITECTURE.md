# Unified ComfyUI Runtime and Benchmark Architecture

Date: 2026-07-14

This checkpoint is a preparation and mock-validation layer. It does not create Clore orders, open SSH, download models, run GPU inference, or upload model files to R2.

## Real Completion

- The existing Wan official runner and guarded Clore execution path remain unchanged.
- The local app now has stable route skeletons for `/generate/4090` and `/generate/5090`.
- Both profile pages reuse one `GenerationProfilePage` component and the confirmed light beige/white-card visual baseline.
- The homepage links to both profile pages without changing data source or Clore execution behavior.
- ComfyUI is pinned for future runtime work at commit `da2608926eaf68fd532bba4e1ace3402c5d21399`.

## 2026-07-15 Stage 3C FLUX First-Image Path

- `comfy-runtime/workflows/bootstrap/flux2-klein-4b-t2i-api.json` is a direct `/prompt` workflow and is deliberately separate from the locked official FLUX UI subgraph asset. It is statically validated against the fixed ComfyUI source audit, has injectable model slots plus prompt/seed/width/height/steps, and ends at `SaveImage`.
- Fixed ComfyUI source evidence requires `CLIPLoader(type=flux2)` for the locked single Qwen encoder. The earlier generic `DualCLIPLoader` suggestion is not executable for this FLUX.2 three-file package and is not used as a false compatibility shim.
- `scripts/clore/download-flux-klein-4b.py` permits only the three locked FLUX files and verifies immutable revision, expected byte size, and SHA256 with resumable `.part` files and atomic completion. It has not been run against a GPU host.
- `scripts/flux-first-image-executor.ts` requires a loopback SSH tunnel and verifies Runtime health, object-info node classes, WebSocket, `/prompt`, `/history`, PNG retrieval, and local archival without exposing ComfyUI publicly.
- Bootstrap GPU candidate selection is orchestration-only: NVIDIA CUDA, at least 16GB VRAM, 32GB RAM, 120GB disk, on-demand, effective hourly cost at most 0.70 USD, and five-hour projected cost at most 4.50 USD. It sorts platform reliability/rating, GPU priority, price, RAM, and disk without treating country or network history as hard filters.
- The fixed Runtime digest only accepts `COMFY_GPU_PROFILE=rtx4090|rtx5090`. Therefore `bootstrap_image_gpu` candidates cannot boot this digest and remain fail-closed until a separately authorized image change; they cannot establish `rtx4090_benchmark_verified` or `production_ready`.
- The only Stage 3C order creation call was rate limited by Clore before an order existed. No GPU hardware, Runtime, model download, image, WebSocket, or image archive result was verified. Active order is zero and the Watchdog is disarmed.

## 2026-07-15 Stage 2.8J Verified Runtime Hygiene

- CI run `29388852207` completed the required `runtime-hygiene-gate` -> `build-and-push` -> `verify-public-digest` DAG and published one linux/amd64 Runtime: `ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime:v0.1.4-runtime-hygiene-1eae628@sha256:187a7eb304075863dbd3f7a1b527530a06783ad8ea0fec5e51e2b9725d1bf137`.
- The public package passed anonymous fixed-digest pull and a complete CPU no-model API, controller, WebSocket, node-profile, model/secret absence, loopback bind, graceful SIGTERM, and GPU fail-closed smoke. The node profile reports 347 classes with required 17/17 and missing 0.
- The durable user/data directory is `/workspace/comfy-user`; ComfyUI receives `--user-directory /workspace/comfy-user` and `--database-url sqlite:////workspace/comfy-user/comfyui.db`. Preflight validates directory ownership/write/fsync and SQLite read/write before ComfyUI starts; the verified container reopens the database after restart.
- `/app/worker.py` was present only in the inherited old digest, was neither started nor referenced, and is precisely deleted from the new final rootfs. This whiteout does not erase the inherited parent layer, so a clean base rebase remains required before production.
- This Runtime is ready for a separate RTX 4090 no-model hardware startup validation only. It is not production-ready and does not verify model download, image/video generation, VRAM/RAM/speed metrics, R2 model cache, or any production model choice.

## 2026-07-15 Stage 3A Real RTX 4090 Attempt

- The first real Clore order (`1954329`, server `91005`) was intentionally limited by a 4.50 USD Watchdog budget and canceled after no SSH information was published within twelve minutes. It incurred 0.25 USD; the account had no active order after cancellation and the Watchdog was disarmed.
- No hardware or Runtime GPU evidence was collected because the SSH connection never became available. Consequently `gpu_boot_verified`, `gpu_inference_verified`, and `flux_first_image_verified` remain false.
- No FLUX model download, image generation, Wan download, video generation, R2 cache write, or local/web result occurred. The next real attempt must use a newly live, separately qualified RTX 4090 host; it must not retry server `91005` until its temporary exclusion is reviewed.

## 2026-07-15 Stage 3B Connection Publication Guard

- New orders are bound to the verified immutable Comfy Runtime digest and expose only `22/tcp` for SSH plus `8080/http` for the controller proxy. Direct ComfyUI `8188` remains forbidden. The payload contains only the local SSH public key and rejects private-key material.
- Order readiness is now a layered fifteen-minute check: platform running state, SSH endpoint publication, TCP connection, then authenticated `ssh true`. A published HTTP proxy is tracked separately and does not substitute for Runtime health.
- No new qualified RTX 4090 was available during this live query, so no Stage 3B GPU order or image workflow ran. This is a marketplace-capacity stop, not a GPU Runtime pass or failure.

## Mock Completion

- `src/lib/generation/gpu-profiles.ts` defines shared `rtx4090` and `rtx5090` hardware profiles.
- `src/lib/generation/model-registry.ts` registers the initial image/video candidate slots without downloading any model.
- `src/lib/generation/workflow-registry.ts` defines mock ComfyUI API-format workflows for image T2I, video TI2V, video I2V, and video FLF2V.
- `src/lib/generation/comfy-runtime.ts` defines the website-to-ComfyUI controller contract and a mock client for submit, status, outputs, interrupt, and cache cleanup.
- `src/lib/generation/benchmark-runner.ts` defines the benchmark result shape, error classification, and a mock state-machine runner.
- `src/lib/generation/r2-cache-plan.ts` defines the future R2 layout with benchmark staging, production, shared components, workflows, manifests, and publish-last `current.json`.
- `comfy-runtime/` records the planned runtime contract, not a built image.

## Not Yet GPU Verified

- An independent ComfyUI runtime Docker scaffold and GitHub Actions workflow now exist. The Stage 2.8J no-model digest is CI-verified; this does not substitute for a real GPU or model benchmark.
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

## 2026-07-14 Stage 2.6 Runtime CI and Official Workflow Locks

- PR-only anonymous digest smoke attempt: run `29326808838` verified that the public GHCR package can be pulled anonymously by fixed digest, with build and push skipped. The container then exited before controller health, with `ExitCode=1`; no API/WebSocket/node smoke pass has been recorded yet.
- `.github/workflows/comfy-runtime-image.yml` now has a guarded push trigger for `stage-two-five-comfy-runtime` with path filters, concurrency, default immutable push tags, and the same limited permissions: `contents: read` and `packages: write`.
- The CI smoke test now covers `/healthz`, `/object_info`, `/system_stats`, `/history`, `/queue`, `/free`, `/interrupt`, WebSocket `/ws`, invalid `/prompt` rejection, required Comfy node classes, no `0.0.0.0:8188` bind, no model-weight files, no secret env, and no legacy `gpu-worker/worker.py` process.
- `comfy-runtime/workflows/official/` locks the official Wan2.2 TI2V-5B and Wan2.2 A14B I2V UI workflows from `comfyanonymous/ComfyUI_examples` commit `3eb0ae663ac044729494be42cb0f17a8c4151ec5`, plus API-format conversions for future smoke runs.
- The FLUX.2 Klein 4B Distilled official template is locked from `Comfy-Org/workflow_templates` commit `192a158125390ce3caf4c64d38d406eaab85cd68`. It is stored as a subgraph workflow and marked `subgraph_registration_required`; it must be unpacked or registered before a real GPU benchmark.
- `comfy-runtime/comfyui-source-audit.json` records the fixed ComfyUI routes and required node classes checked against commit `da2608926eaf68fd532bba4e1ace3402c5d21399`.
- `benchmark/rtx4090-baseline-plan.json` limits the first RTX 4090 plan to FLUX.2 Klein 4B Distilled FP8 and Wan2.2 TI2V-5B. It excludes FLUX.2 9B, Wan A14B, Phr00t, GGUF, Kijai, FLF2V, and Dev quantized candidates from the first 4090 round.
- This checkpoint still does not create a Clore order, SSH into a GPU, download model weights, run inference, upload to R2, or promote any production candidate.

## 2026-07-14 Stage 2.8B Kornia/TorchScript Diagnosis Gate

- `production_minimal` is the default node profile for both `smoke_cpu` and future `gpu` mode. It is derived from the locked official FLUX.2 Klein 4B Distilled, Wan2.2 TI2V-5B, and Wan2.2 I2V-A14B workflow requirements.
- The profile loads only `comfy_extras/nodes_flux.py`, `comfy_extras/nodes_images.py`, `comfy_extras/nodes_model_advanced.py`, `comfy_extras/nodes_video.py`, and `comfy_extras/nodes_wan.py`, plus base classes from `nodes.py`.
- `full_manual` remains an unverified metadata placeholder. It is not default and does not enter the first RTX 4090 benchmark path.
- CI diagnosis uses the old public digest `sha256:1cfb4740fb8b310a8095500e8fe55160176c619306068d553092182f4888efd1` to record exact dependency versions, Kornia import sources, D1 minimal Kornia import behavior, D2 temporary `torch.jit.script` identity behavior, D3 builtin-extra crash location, and D4 production-minimal no-model boot.
- A new Runtime build is gated behind D4 success. The build passes the exact Kornia version observed in the old digest as a build argument, avoiding speculative PyTorch/Triton/Kornia/comfy-kitchen upgrades.
- This architecture update does not claim GPU boot or inference. RTX 4090 hardware startup remains a separate future verification after a CI-verified digest exists.

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
