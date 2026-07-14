# Model Candidate Audit

Date: 2026-07-14

This report is a metadata and license-risk record, not legal advice. It does not approve production use, download model weights, upload to R2, run GPU inference, or create a Clore order.

## Audit Status Legend

- `unverified`: repository, revision, files, license, or dependency lock is missing.
- `public_verified`: public repository metadata is readable, but benchmark dependencies are not fully locked.
- `gated_user_action_required`: metadata or files are gated and require the user to accept terms on the provider website.
- `metadata_incomplete`: public primary metadata exists, but auxiliary files or workflow dependencies remain incomplete.
- `eligible_for_benchmark`: repository, immutable revision, files, license, and native dependencies are locked for a future smoke benchmark.
- `rejected_before_benchmark`: excluded before benchmark because of license, hardware, or missing metadata.

## Candidate Matrix

| Slot | Candidate | Status | Repository / revision | Files locked in this checkpoint | License / access | User action |
| --- | --- | --- | --- | --- | --- | --- |
| `rtx4090/image` | FLUX.2 Klein 4B Distilled FP8 | `eligible_for_benchmark` | `black-forest-labs/FLUX.2-klein-4b-fp8` / `5b4408e59397a4a37ccb46afe426d8ed86379441`; auxiliary repo `Comfy-Org/vae-text-encorder-for-flux-klein-4b` / `a9e4ca87c16db4c4e1a16406a9ddb300ab0ae246` | `flux-2-klein-4b-fp8.safetensors`, `qwen_3_4b.safetensors`, and `flux2-vae.safetensors` with public SHA256 values | Apache-2.0, public | Official Comfy subgraph template must be unpacked or registered before a real GPU smoke run. |
| `rtx4090/image` | FLUX.2 Klein 4B Base FP8 | `unverified` | Not proven | Not proven | Pending metadata verification | Find exact official repository, revision, file, and license before any benchmark. |
| `rtx4090/video` | Wan2.2 TI2V-5B native ComfyUI workflow | `eligible_for_benchmark` | `Wan-AI/Wan2.2-TI2V-5B` / `921dbaf3f1674a56f47e83fb80a34bac8a8f203e` | VAE, 3 diffusion shards, and UMT5 encoder public LFS SHA256 values are recorded | Apache-2.0, public | None before a smoke benchmark. Real model download still requires an explicit future GPU task. |
| `rtx4090/video` | Phr00t Wan2.2 Rapid All-in-One | `unverified` | Not proven | Not proven | Pending metadata verification | Must lock exact repository, revision, version directory, safetensors file, workflow, CLIP, VAE, and license. |
| `rtx4090/video` | Wan2.2 A14B GGUF Q4/Q5 | `unverified` | Not proven | Not proven | Pending metadata verification | Must lock quantized repository, file, license, and fixed ComfyUI-GGUF commit. |
| `rtx4090/video` | Kijai WanVideoWrapper FP8 | `unverified` | Not proven | Not proven | Pending metadata verification | Must lock wrapper repository commit and only use it when native ComfyUI lacks the needed workflow. |
| `rtx5090/image` | FLUX.2 Klein 9B FP8 | `gated_user_action_required` | `black-forest-labs/FLUX.2-klein-9b-fp8` / `902d9d510b51533e07729f19211414a3648b77d2` | `flux-2-klein-9b-fp8.safetensors` public metadata visible, but download is gated | FLUX Non-Commercial License, gated | User must log in to Hugging Face and accept the BFL gated prompt and license before any sync or benchmark. |
| `rtx5090/image` | FLUX.2 Dev NVFP4 / Blackwell quantized candidate | `unverified` | Not proven | Not proven | Pending metadata verification | Must find an official Blackwell/NVFP4 repository and license. NVFP4 is 5090-only in this project. |
| `rtx5090/image` | FLUX.2 Klein 4B Distilled FP8 speed baseline | `eligible_for_benchmark` | Same as `rtx4090/image` | Same primary and auxiliary files as `rtx4090/image` | Apache-2.0, public | Same subgraph unpack/register requirement applies before real execution. |
| `rtx5090/video` | Wan2.2 A14B I2V FP8 native ComfyUI workflow | `eligible_for_benchmark` | `Wan-AI/Wan2.2-I2V-A14B` / `206a9ee1b7bfaaf8f7e4d81335650533490646a3` | High-noise shards, low-noise shards, VAE, and UMT5 encoder public LFS SHA256 values are recorded | Apache-2.0, public | None before a smoke benchmark. 5090 fit remains an offload benchmark question, not a support claim. |
| `rtx5090/video` | Wan2.2 A14B GGUF Q5/Q6 | `unverified` | Not proven | Not proven | Pending metadata verification | Must lock exact GGUF files and fixed ComfyUI-GGUF commit. |
| `rtx5090/video` | Phr00t Rapid All-in-One | `unverified` | Not proven | Not proven | Pending metadata verification | Must lock exact version, files, workflow, CLIP, VAE, and license. |
| `rtx5090/video` | Kijai FP8 scaled | `unverified` | Not proven | Not proven | Pending metadata verification | Optional only; not a forced dependency for native workflows. |
| `rtx5090/video` | Wan2.2 TI2V-5B speed baseline | `eligible_for_benchmark` | `Wan-AI/Wan2.2-TI2V-5B` / `921dbaf3f1674a56f47e83fb80a34bac8a8f203e` | Same as `rtx4090/video` | Apache-2.0, public | None before a smoke benchmark. |

## License And Use Notes

| Candidate family | Personal testing | Commercial model use | Commercial output use | Separate commercial license likely required | Login or terms required |
| --- | --- | --- | --- | --- | --- |
| FLUX.2 Klein 4B Distilled FP8 | Allowed by current public Apache-2.0 metadata | Allowed by current public Apache-2.0 metadata | Not separately restricted in the recorded public metadata | No separate license recorded | No |
| FLUX.2 Klein 9B FP8 | Blocked until terms accepted | Non-commercial license recorded; commercial use is blocked for this product unless licensing changes | Treat as blocked for product use until license review | Yes, if commercial use is needed | Yes |
| Wan2.2 TI2V-5B | Allowed by current public Apache-2.0 metadata | Allowed by current public Apache-2.0 metadata | Not separately restricted in the recorded public metadata | No separate license recorded | No |
| Wan2.2 I2V-A14B | Allowed by current public Apache-2.0 metadata | Allowed by current public Apache-2.0 metadata | Not separately restricted in the recorded public metadata | No separate license recorded | No |
| Phr00t / GGUF / Kijai community candidates | Unknown | Unknown | Unknown | Unknown | Unknown until exact repository and files are locked |

## Hardware Risk Notes

- RTX 4090 defaults to FP8 or GGUF/offload candidates because NVFP4 is a Blackwell-oriented quantization path and must not be treated as a safe 4090 default.
- FLUX.2 Klein 9B reports about 29 GB class VRAM needs in public metadata. It must be tested with offload before any stability claim.
- FLUX.2 Klein 4B Distilled FP8 auxiliary files are locked from the actual public repository URL `Comfy-Org/vae-text-encorder-for-flux-klein-4b`; the repository name uses `encorder`.
- Wan2.2 A14B official reference hardware is larger than a single RTX 5090. Any RTX 5090 result is a benchmark experiment with offload, not an official support guarantee.

## Sources Checked

- Hugging Face public model APIs for `black-forest-labs/FLUX.2-klein-4b-fp8`, `Comfy-Org/vae-text-encorder-for-flux-klein-4b`, `black-forest-labs/FLUX.2-klein-9b-fp8`, `Wan-AI/Wan2.2-TI2V-5B`, and `Wan-AI/Wan2.2-I2V-A14B`.
- GitHub commit API for `comfyanonymous/ComfyUI` commit `da2608926eaf68fd532bba4e1ace3402c5d21399`.
- GitHub tree/blob APIs for `Comfy-Org/workflow_templates` commit `192a158125390ce3caf4c64d38d406eaab85cd68` and `comfyanonymous/ComfyUI_examples` commit `3eb0ae663ac044729494be42cb0f17a8c4151ec5`.
