# Project Context

## Active product

The active product is an image-only, local-first FLUX creation workspace. The only active task API is `/api/local-lab/image-tasks`; tasks are stored in ignored project-local state under `.secrets/image-studio/tasks.json`.

## Image task contract

- Stack: Fluxed Up 10.2 BF16 as the complete FLUX transformer replacement, shared FLUX encoders/VAE, and AIDMA NSFW Unlock LoRA.
- Prompt is required. Reference-image tasks are intentionally deferred and blocked as `FLUX Kontext 执行器尚未完成`.
- Supported text controls: steps 25-40, LoRA 0.6-1.1, CFG 3.5-5.0, Euler or FlowMatch, and 768-2048 px dimensions in 256 px increments.
- Tasks at or below 1280 x 1280 use RTX 4090 (`低`); all larger dimensions use RTX 5090 (`高`).

## RTX 4090 executor checkpoint

- The Studio left GPU panel persists maximum hourly price, runner session state, host details, stage, timestamps, and copyable backend errors.
- The paid rental button remains disabled by default until the image executor readiness gate is explicitly satisfied.
- The HTTP-first RTX 4090 runner has a no-order dry mode, freezes selected task IDs and maximum hourly price, uses `COMFY_NODE_PROFILE=image-flux`, and never waits for SSH.
- RTX 4090 readiness now requires `IMAGE_4090_EXECUTOR_READY=true` plus either a strict local validated restore manifest or a complete first-run bootstrap configuration. Runner preflight failures are persisted to the Studio session instead of leaving stale searching progress.
- Image batch cancellation is exposed through the local image task API and cancels the matching current image Clore order directly from persisted session/order state; it is idempotent when the order is already gone and does not depend on the runner PID.
- Image create-order now uses a bounded single request and advances persisted state as soon as an order ID is known. HTTP readiness is a separate 12-minute path with deployment, endpoint, `/healthz`, elapsed-time, and cancellation diagnostics; after timeout or runner exit the API reconciles live Clore orders before deciding whether to fail, clear stale local state, or surface an active billing risk.
- Runtime `/healthz` now proves the HTTP controller is alive independently from ComfyUI; the image runner waits for `ready: true`, while `ready: false`/`runtime_failed` keeps diagnostics visible instead of becoming a proxy-level 502.
- The restricted Clore diagnostic Agent is bootstrapped from an immutable public source commit. Its controller stage fetches only the pinned Controller and workflow files by immutable raw URL and verified SHA-256; it never clones the project repository.
- Runtime bootstrap binds the HTTP controller before touching `/workspace`; initial controller state and logs live under `/tmp/image-runtime-bootstrap`, and unwritable `/workspace` failures surface as `workspace_failed` health JSON while the container stays alive.
- Before an order ID exists, the image runner may only show `creating_order` or `create_order_failed`; HTTP endpoint waiting is shown only after a real order ID exists. Transient create-order network errors persist sanitized nested fetch cause details, reconcile `/my_orders`, then retry exactly once only if no order was created.
- A local active-order JSON file or create lock is never trusted by itself. Studio refresh/start/cancel and the low-level create-order guard reconcile Clore `/my_orders`; if the provider has zero active orders, stale local order/lock/session execution state is cleared while preserving confirmed image tasks.
- After an order ID is known or reconciled, every post-order failure path attempts cancellation and verifies active Clore orders return to zero.
- If a Clore image order has an HTTP public hostname but remains `deploying` with only proxy-level `/healthz` 502 responses for 6 minutes, the runner cancels the order, preserves the image task, records a deployment failure, and temporarily denies that host for 24 hours.
- Source acquisition manifests are separate from validated R2 restore manifests. Source manifests may omit unavailable hashes; restore manifests require exact size, SHA-256, runtime destination, cache key, and presigned download URL.
- Successful PNG results are validated for signature and exact dimensions, hashed, thumbnailed, and persisted under `AI_IMAGE_LIBRARY_ROOT` (default `D:\AI-Video-Library\images`), outside the repository.
- The restricted Clore diagnostic Agent now has authenticated, fixed stages for raw immutable controller/workflow retrieval, CUDA ComfyUI bootstrap, exactly five verified model files, one fixed FLUX inference request, and authenticated PNG artifact retrieval. It never accepts shell commands, workflow JSON, arbitrary paths, permanent cloud credentials, or model destinations from the remote caller.
- The local JSON task list is the source of truth. `src/lib/image-generation/local-image-task-store.ts` serializes all reads and mutations with a cross-process lock directory, stale-lock recovery, fsync-plus-atomic JSON replacement, short local leases, hashed claim tokens, and exact-task-only finalization.
- Completed images live only in the local image library (`AI_IMAGE_LIBRARY_ROOT`, default `D:\AI-Video-Library\images`) under a dated task directory. The UI uses loopback-only `/api/local-images/<task_id>/output` and `/thumbnail` routes, which resolve only verified task-relative artifacts.
- `scripts/clore/run-image-e2e.ts` uses this local claim/finalize contract. Its pre-rental model check resolves five immutable sources with only local Civitai/Hugging Face credentials, validates advertised sizes against the pinned SHA-256 manifest, and passes only temporary signed download URLs to the Agent. It must not claim a task until the remote runtime and all five model files have succeeded; no Supabase image queue, Storage path, or cloud credential is part of this image E2E path.
- The fresh-run receipt is fsync-plus-atomic. It is persisted as `inference_submitting` before the sole inference POST, as `inference_accepted` after HTTP 202 and before any status GET, and records only sanitized terminal artifact metadata. An incomplete task with a prior `submitting`, `accepted`, or `succeeded` receipt is fail-closed and requires manual recovery before any later provider mutation. The same receipt records verified artifact download, local publication, exact task finalization, UI verification, and confirmed exact-order cancellation.

## Archived product

Wan, LTX, long-video, old image runtime, Clore video session code, related routes, and historical docs live under the archived video area and are excluded from the active TypeScript build. There is no active video page, video API, video queue, or automatic paid-cloud action in this checkpoint.
