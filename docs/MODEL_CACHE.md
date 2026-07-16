# Model Cache

Status: the private Cloudflare R2 bucket contains the verified Wan2.2 Comfy cache revision. GPU inference has not been run.

## Stage 3N verified Wan cache

- GitHub Actions run: `29470206635`
- Result and duration: success, 440 seconds
- Source revision: `Comfy-Org/Wan_2.2_ComfyUI_Repackaged@fb1388adc906ab39ffc26ee40e96b22886b56bc4`
- Objects: 3, totaling `18,144,966,705` bytes
- Publication order: revision objects, immutable revision manifest, then current pointer
- Independent verification: current pointer, manifest, every size/SHA256, and read-only HEAD plus first/last 1024-byte ranges passed

The three downloads used isolated `$RUNNER_TEMP` Hugging Face caches and parallel jobs. This was the only Stage 3N dispatch. It created no GPU order and did not run inference. The authoritative readiness fields are in `comfy-runtime/model-availability.json`.

## Fixed Model

```text
Wan-AI/Wan2.2-TI2V-5B
```

Expected official model size budget:

```text
34.2GB
```

Default model directory on the GPU:

```text
/workspace/models/Wan2.2-TI2V-5B
```

## Cache Order

1. Current Clore instance local directory.
2. Optional Clore persistent volume.
3. Private Cloudflare R2 model cache.
4. Official Hugging Face repository fallback.

The Docker image contains runtime dependencies only. It does not contain model weights.

## Environment

Placeholders are in `.env.example`. Real values later belong only in:

```text
.secrets/model-cache.env
.secrets/model-cache-admin.env
.secrets/model-cache-readonly.env
```

GPU instances may receive read-only model cache credentials only when R2 restore is used. R2 write credentials stay on the local developer machine and must not be copied to the GPU.

Important placeholders:

```env
MODEL_CACHE_PROVIDER="r2"
MODEL_CACHE_BUCKET=""
MODEL_CACHE_PREFIX="wan22-ti2v-5b"
MODEL_CACHE_ENDPOINT=""
MODEL_CACHE_READ_ONLY="true"
MODEL_CACHE_LOCAL_DIR="/workspace/models/Wan2.2-TI2V-5B"
MODEL_CACHE_VOLUME_DIR="/workspace/model-cache/Wan2.2-TI2V-5B"
MODEL_CACHE_R2_ENABLED="true"
WAN_MODEL_REPO="Wan-AI/Wan2.2-TI2V-5B"
WAN_MODEL_EXPECTED_SIZE_GB="34.2"
```

## Commands

```powershell
npm run model-cache:plan
npm run model-cache:test
npm run model-cache:manifest:test
npm run model-cache:r2:test
```

Current real bucket:

```text
ai-video-platform-wan22-model-cache
```

The bucket is private. `r2.dev` public access is disabled and no custom domains are connected.

`npm run model-cache:r2:test` verifies:

- `.secrets/model-cache-admin.env`: Object Read & Write credentials scoped to the model cache bucket can list, put, get, overwrite, and delete.
- `.secrets/model-cache-readonly.env`: Object Read only credentials scoped to the model cache bucket can list and get, but cannot put, overwrite, or delete.

Both files must use:

```env
MODEL_CACHE_ACCESS_KEY_ID=""
MODEL_CACHE_SECRET_ACCESS_KEY=""
MODEL_CACHE_BUCKET="ai-video-platform-wan22-model-cache"
MODEL_CACHE_PREFIX="wan22-ti2v-5b"
MODEL_CACHE_ENDPOINT=""
MODEL_CACHE_REGION="auto"
```

The current R2 shell helpers are dry-run placeholders:

```text
scripts/model-cache/r2-download.sh
scripts/model-cache/r2-upload.sh
```

This round connected to R2 only for bucket setup and a tiny permission probe object. It did not upload Wan2.2 weights.

Latest permission test result:

- Admin boundary: list, put, get, overwrite, delete passed.
- GPU read-only boundary: list/get passed; put/overwrite/delete blocked.
- Cleanup: test objects removed; bucket object count returned to 0.

## 2026-07-12 Secure Seed Upload Flow

The first real Wan2.2 session must seed the private R2 cache without copying R2 write credentials to the GPU.

Flow:

1. GPU downloads `Wan-AI/Wan2.2-TI2V-5B` from official Hugging Face on the future rented Clore host.
2. GPU generates a manifest with model id, revision, relative paths, size, sha256, file count, total size, runtime image digest, Wan code revision, and generated time.
3. Local controller retrieves and validates the manifest. Absolute paths, drive letters, `..`, empty path segments, unknown model id, bad hashes, and sensitive fields are rejected.
4. Local controller signs short-lived object-specific R2 upload permissions. Small files use presigned PUT; large files use controller-owned multipart create/sign/complete/abort planning.
5. GPU uploads directly to R2 using only temporary signed URLs and returns size/hash or part ETags. ETag is never treated as sha256.
6. Local controller verifies uploaded objects and publishes `wan22-ti2v-5b/manifests/<model_revision>.json`, then publishes `wan22-ti2v-5b/current.json` last.
7. Future GPUs restore from R2 with `.secrets/model-cache-readonly.env`.

Fixed keys:

```text
wan22-ti2v-5b/files/<relative_path>
wan22-ti2v-5b/manifests/<model_revision>.json
wan22-ti2v-5b/current.json
wan22-ti2v-5b/staging/<session-id>/
```

Validation command:

```powershell
npm run model-cache:seed:test
```

The current seed test uses mock model files plus a tiny `_seed-test` R2 object only. It does not download Wan2.2 and does not upload model weights.

## 2026-07-13 Pinned Revisions

Fixed non-secret version constants now live in `scripts/model-cache/model-version.ts`:

```text
WAN_MODEL_REPO=Wan-AI/Wan2.2-TI2V-5B
WAN_MODEL_REVISION=921dbaf3f1674a56f47e83fb80a34bac8a8f203e
WAN_CODE_REVISION=42bf4cfaa384bc21833865abc2f9e6c0e67233dc
WAN_MODEL_EXPECTED_SIZE_GB=34.2
```

The runtime Dockerfile installs Wan code from the pinned commit instead of drifting `main`. The Python real runner refuses to start if the generated model manifest does not match the pinned model and code revisions.

## 2026-07-15 FLUX First-image Cache

FLUX uses a separate publish order:

```text
production/rtx4090/image/staging/<session>/files/<model-path>
production/rtx4090/image/revisions/<revision>/files/<model-path>
production/rtx4090/image/revisions/<revision>/manifest.json
production/rtx4090/image/current.json
```

```powershell
npm run model-cache:seed:flux4090
npm run model-cache:status:flux4090
npm run model-cache:resume:flux4090
```

GitHub Actions run `29431562820` completed the cache on 2026-07-15. Qwen used the official Hugging Face Xet client without HTTP fallback. Local files were checked by full SHA256 before AWS SDK multipart upload with 128MiB parts and were removed from each Runner after upload.

Published revision: `flux2-klein-4b-5b4408e59397-a9e4ca87c16d`.

| File | Size (bytes) | SHA256 |
| --- | ---: | --- |
| `flux-2-klein-4b-fp8.safetensors` | 4,070,624,520 | `97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6` |
| `qwen_3_4b.safetensors` | 8,044,982,048 | `6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a` |
| `flux2-vae.safetensors` | 336,211,292 | `868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3` |

The revision manifest and `production/rtx4090/image/current.json` are published. Read-only GPU credentials can read both indexes, HEAD all three objects, and read their first and last 1024-byte ranges; Put, overwrite, and Delete probes are denied. `gpu_restore_ready=true`, while `gpu_inference_verified=false` and `production_ready=false`.

Stage 3K kept this cache unchanged. Two budget-gated RunPod creates were deleted before SSH because their reported total hourly price exceeded 0.70 USD, so no R2 object was downloaded and no Hugging Face fallback was attempted. The next accepted SSH GPU still restores this published revision first with concurrency two, `.part` resume, full size/SHA256 verification, and atomic rename.

## 2026-07-16 Stage 3L Wan first-video preflight

The existing Comfy API workflow requires exactly three files from `Comfy-Org/Wan_2.2_ComfyUI_Repackaged` at revision `fb1388adc906ab39ffc26ee40e96b22886b56bc4`: the TI2V-5B UNet, FP8 UMT5 encoder, and Wan2.2 VAE. Their locked total is 18,144,966,705 bytes. Exact paths, sizes, SHA256 values, R2 additional capacity, a three-job workflow-dispatch-only cache plan, 4090/A40/A6000 inference plans, required nodes, and Phase 3M status are stored in `benchmark/wan-first-video/stage3m-plan.json` and `stage3m-status.json`.

`npm run wan:first-video:preflight` prints `wan_cache_plan_valid=true` and `wan_workflow_plan_valid=true`. It does not download Wan files, upload to R2, or trigger GitHub Actions.

## 2026-07-16 Stage 3M Wan cache attempt

The manual-only workflow `.github/workflows/wan-stage3m-model-cache.yml` separates the locked UNet, text encoder, and VAE into three parallel jobs. Each job downloads with the official Hugging Face/Xet client, verifies exact size and SHA256, and would use AWS SDK multipart upload. The publish job verifies revision objects before writing the revision manifest and publishes `current.json` last. Model files are excluded from Actions artifacts.

Run `29446260840` was dispatched exactly once on `stage-two-five-comfy-runtime`. GitHub rejected the workflow before jobs because `runner.temp` was referenced in job-level `env`. The definition is corrected to write `HF_HOME=$RUNNER_TEMP/...` to `$GITHUB_ENV` inside a step, matching the proven FLUX workflow pattern. Stage 3M did not issue a second dispatch: no Runner downloaded a Wan file, no multipart upload was created, no R2 object or pointer changed, and the existing FLUX revision remains intact.
