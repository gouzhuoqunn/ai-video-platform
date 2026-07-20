# GPT-SoVITS local CPU model audit

The selected correctness baseline is the official `RVC-Boss/GPT-SoVITS` signed release `20250606v2pro`, commit `d7c2210da8c013e81a94bfc7b811a477c99fd506`. It was selected over V2Pro, V4, and any CPU-optimized fork because the official release includes the V2Pro/V2ProPlus series, an official narrow `api_v2.py` inference path, Chinese support, a documented speed parameter, and a CPU installation route.

`V2ProPlus` is only the planned first model selection. The official source documents the required V2Pro files `v2Pro/s2Dv2ProPlus.pth`, `v2Pro/s2Gv2ProPlus.pth`, `sv/pretrained_eres2netv2w24s4ep4.ckpt`, and Chinese G2PW support. The upstream repository does not publish a usable SHA-256 list in the audited materials, so no hash is invented in the immutable manifest.

The isolated local environment is Python 3.10.11 with `torch 2.6.0+cpu` and `torchaudio 2.6.0+cpu`; CUDA is unavailable by design. The official `pyopenjtalk==0.4.1` dependency requires a Windows C/C++ build toolchain on this laptop, which is not installed. The Runtime and model package therefore remain `blocked`: no pretrained model files were downloaded and no GPT-SoVITS synthesis was claimed.
