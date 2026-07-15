#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from huggingface_hub import hf_hub_download

REPOSITORY = "Comfy-Org/Wan_2.2_ComfyUI_Repackaged"
REVISION = "fb1388adc906ab39ffc26ee40e96b22886b56bc4"
FILES = {
    "unet": ("split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors", 9_999_658_848),
    "text": ("split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", 6_735_906_897),
    "vae": ("split_files/vae/wan2.2_vae.safetensors", 1_409_400_960),
}

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=sorted(FILES), required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--github-output", default="")
    args = parser.parse_args()
    filename, expected_size = FILES[args.model]
    os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
    os.environ["HF_XET_CHUNK_CACHE_SIZE_BYTES"] = "0"
    os.environ.pop("HF_HUB_DISABLE_XET", None)
    result = Path(hf_hub_download(repo_id=REPOSITORY, revision=REVISION, filename=filename, cache_dir=args.cache_dir)).resolve()
    if not result.is_file() or result.stat().st_size != expected_size:
        raise RuntimeError("wan_stage3m_download_size_mismatch")
    if args.github_output:
        with Path(args.github_output).open("a", encoding="utf-8") as handle:
            handle.write(f"model_path={result}\n")
    print(json.dumps({"model": args.model, "size_bytes": expected_size, "hf_xet": True, "download_complete": True}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
