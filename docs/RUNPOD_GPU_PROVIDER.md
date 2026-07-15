# RunPod GPU Provider

RunPod is the second GPU supplier adapter for the FLUX first-image recovery path. It does not replace Clore and does not change the pinned Comfy Runtime image.

## Safety boundary

- API base: `https://rest.runpod.io/v1`.
- Authentication: Bearer token loaded only from environment or ignored `.secrets/runpod.env`.
- Lifecycle: list, create, get, stop, delete, and recover an existing named Pod.
- One active Pod maximum. Create is guarded by an in-process promise and an ignored filesystem lock.
- Request timeout is 30 seconds. HTTP 429 and 5xx responses use bounded exponential retry. A create timeout checks existing Pods before another create request.
- Only Secure Cloud, one GPU, non-interruptible Pods are allowed.
- Limits: at least 16GB VRAM, 32GB RAM, 50GB container disk, 30GB `/workspace` volume, 0.70 USD/hour, and 2.50 USD/session.
- Published ports are `22/tcp` and `8080/http`; port 8188 remains private and is reached only through a loopback SSH tunnel.

## Bootstrap image

`runpod-bootstrap/Dockerfile` inherits the immutable Comfy Runtime digest and adds only OpenSSH server configuration. The container starts `sshd`, validates a single SSH public key, rejects password login, and leaves Runtime startup to the first-image executor after SSH and hardware verification. It contains no models or provider/storage credentials.

The independent `.github/workflows/runpod-bootstrap-image.yml` builds only `linux/amd64`, publishes no `latest` tag, performs an anonymous pull, and statically confirms that neither Comfy GPU Runtime nor the retired Worker starts during bootstrap.

The first hosted build attempt, run `29435088336`, failed inside `docker/build-push-action` because the hosted runner exhausted its filesystem and could not write its own diagnostic log. No bootstrap package, tag, or digest was created. The workflow now reclaims the preinstalled Android, CodeQL, .NET, and GHC payloads before Buildx. It has not been rerun because Stage 3J permits only one actual bootstrap build.

## Commands

```powershell
npm run gpu:doctor
npm run gpu:candidates -- --provider=runpod
npm run gpu:first-image -- --provider=runpod
```

Without `RUNPOD_API_KEY`, these commands report credential absence and remain read-only/dry-run. Real execution also requires a digest-pinned `RUNPOD_BOOTSTRAP_IMAGE`, SSH public/private key paths, and explicit `--execute`.

The project still records `production_ready=false` until a real GPU completes Runtime startup, R2 model restore, FLUX generation, result sync, and Pod termination.
