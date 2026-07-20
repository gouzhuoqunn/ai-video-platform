# LTX-2.3 and Sulphur Candidate Audit

Audit date: 2026-07-20. This is metadata-only; no weights, signed URLs, or runtime assets were downloaded.

## Recommended first Runtime candidate

`Lightricks/LTX-2.3-fp8` at revision `1d756cd` is the recommended evidence-backed baseline, using `ltx-2.3-22b-distilled-fp8.safetensors` when its exact artifact digest is captured by the Runtime preparation command. The official card describes LTX-2.3 as a joint synchronized audio-video model and lists both full-development and eight-step distilled FP8 checkpoints. The Runtime stage must still pin a full immutable revision and artifact identifier before download.

## Candidate records

| Candidate | Revision evidence | File / size | Type | Audio-video evidence | Runtime status |
| --- | --- | --- | --- | --- | --- |
| `Lightricks/LTX-2.3-fp8` | `1d756cd` visible on the official file tree; full 40-character commit still required before download | `ltx-2.3-22b-dev-fp8.safetensors`, 29.1 GB; Xet-backed | full FP8 checkpoint | Official model card states synchronized audio-video and supports text/image audio-video modalities | Metadata usable; Runtime pin still required |
| `Lightricks/LTX-2.3-fp8` | same repository | `ltx-2.3-22b-distilled-fp8.safetensors`; expected FP8 distilled checkpoint | alternative distilled checkpoint | Official model card documents eight-step/CFG 1 distilled inference | Preferred after exact file listing and digest are captured |
| `SulphurAI/Sulphur-2-base` | observed file commit `608bf89`; repository head observed `875e886` | `sulphur_dev_fp8mixed.safetensors`, 29.2 GB; Xet-backed | purported full FP8 checkpoint | Current public page contains inconsistent generic text/image and LLM instructions, not a complete LTX native-audio workflow | Blocked: do not load or select for Runtime |
| `SulphurAI/Sulphur-2-base` | repository lists `distill_loras/` | available distill LoRA and workflow assets, exact compatible pair not locked | alternative LoRA/auxiliary | No complete compatible audio-video instructions established | Blocked; never load full checkpoint and distill LoRA together |
| `Civitai/Sulphur-2-distilled-fp8` | canonical immutable artifact evidence unavailable in this audit | `sulphur_distil_fp8mixed.safetensors` claimed by task brief | distilled checkpoint | No maintainer workflow, license, digest, or dependency closure proven | Blocked |

The official LTX license is `ltx-2-community-license-agreement`; private-use compatibility still needs explicit operator review. The current LTX FP8 page specifies Diffusers with `diffusers`, `transformers`, and `accelerate`, but an executable audio-video workflow, supporting VAE/text/audio files, expected total size, and SHA-256/Xet identifier must be captured by Runtime preparation. LTX supports T2V and image-conditioned workflows according to its official modality tags and model card; no first-frame runtime has been verified here.

The neutral application key is `ltx23_sulphur_native_audio_fp8`. It does not assert Sulphur is canonical, licensed, cached, loadable, or validated. `video_ltx_native_audio` remains Runtime-blocked until a future metadata-only audit produces exact artifact identifiers, license evidence, compatible workflow, supporting-file list, and dependency versions.

Sources: [official LTX model card](https://huggingface.co/Lightricks/LTX-2.3-fp8), [official LTX FP8 file](https://huggingface.co/Lightricks/LTX-2.3-fp8/blob/main/ltx-2.3-22b-dev-fp8.safetensors), [observed Sulphur file](https://huggingface.co/SulphurAI/Sulphur-2-base/blob/main/sulphur_dev_fp8mixed.safetensors), [observed Sulphur tree](https://huggingface.co/SulphurAI/Sulphur-2-base/tree/main).
