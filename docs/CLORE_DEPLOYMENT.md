# FLUX Cloud Execution

The active Clore path is an HTTP-first RTX 4090 image executor checkpoint.

- Default behavior is still no paid order. The Studio start button is disabled unless the explicit image executor readiness gate is enabled.
- The image order payload must use the pinned Comfy runtime image, expose only container port `8080` as HTTP, and set `COMFY_NODE_PROFILE=image-flux`.
- SSH is not a readiness gate for this image executor. HTTP `/healthz` is the runtime readiness check.
- The runtime container keeps ComfyUI internal on `127.0.0.1:8188`; only the controller on `0.0.0.0:8080` is exposed through Clore HTTP.
- After a known or reconciled order ID exists, runner cleanup must attempt cancellation on every terminal success or failure and verify active Clore orders return to zero.
- Source acquisition manifests are not restore manifests. Only validated restore manifests with exact size, SHA-256, runtime path, cache key, and presigned download URL may be sent to `/restore`.
