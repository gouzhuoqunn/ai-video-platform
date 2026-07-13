# ComfyUI Runtime Contract

This directory records the future unified ComfyUI runtime shape. It is a planning and mock-contract layer only in this checkpoint.

- ComfyUI is pinned to commit `da2608926eaf68fd532bba4e1ace3402c5d21399`.
- The runtime must include ComfyUI, Python dependencies, FFmpeg, an API controller, health checks, and a bootstrap entry.
- The runtime must not include model weights, user media, prompts, `.env` files, secrets, SSH keys, signed URLs, or R2 write credentials.
- ComfyUI must bind to `127.0.0.1:8188` or an internal container interface only. It must not expose a public inference, Jupyter, Gradio, or ComfyUI port.
- The website controller talks to the local ComfyUI API for submit, prompt status, output collection, interruption, and local model-cache cleanup.
- This checkpoint does not build a new runtime image and does not run GPU inference.
