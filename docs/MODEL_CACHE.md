# Model Cache

Status: private Cloudflare R2 bucket created and connected to dry-run planning. R2 S3 credentials still require manual Dashboard creation. No Wan2.2 weights were uploaded or downloaded.

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

`npm run model-cache:r2:test` requires:

- `.secrets/model-cache-admin.env`: Object Read & Write credentials scoped to the model cache bucket.
- `.secrets/model-cache-readonly.env`: Object Read only credentials scoped to the model cache bucket.

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
