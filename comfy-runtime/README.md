# ComfyUI Runtime Contract

This directory records the independent unified ComfyUI runtime shape. It is separate from the existing Wan first-test runtime and must not replace `gpu-worker/Dockerfile`.

- ComfyUI is pinned to commit `da2608926eaf68fd532bba4e1ace3402c5d21399`.
- The planned image name is `ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime`.
- The Dockerfile reuses the already verified CUDA/PyTorch base digest `ghcr.io/gouzhuoqunn/wan22-runtime@sha256:4e3dd6d2610c33ab2b260e970e4a9288043dc2c762cb1b8902b6712cfdfaa96c` to avoid rebuilding the full CUDA layer locally.
- The runtime includes ComfyUI, Python dependency lock, FFmpeg from the base image, a local API controller, health checks, bootstrap entry, workflow fixtures, model/R2 mount directories, and a custom-node lock manifest.
- The runtime must not include model weights, user media, prompts, `.env` files, secrets, SSH keys, signed URLs, or R2 write credentials.
- ComfyUI must bind to `127.0.0.1:8188` or an internal container interface only. It must not expose a public inference, Jupyter, Gradio, or ComfyUI port.
- The website controller talks to the local ComfyUI API for submit, prompt status, output collection, interruption, and local model-cache cleanup.
- The base runtime intentionally does not install ComfyUI-GGUF, Kijai WanVideoWrapper, or other community nodes. They remain optional locked layers until a workflow actually needs them.
- This checkpoint defines the CI workflow and local contract tests. It does not create a Clore order, open SSH, download model weights, upload to R2, or run GPU inference.
