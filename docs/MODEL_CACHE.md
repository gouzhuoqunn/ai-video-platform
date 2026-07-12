# Model Cache

Status: private Cloudflare R2 bucket created, connected to dry-run planning, and permission-tested with separate admin and GPU read-only S3 credentials. No Wan2.2 weights were uploaded or downloaded.

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
