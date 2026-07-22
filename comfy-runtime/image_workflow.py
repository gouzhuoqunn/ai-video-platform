"""Validated ComfyUI API graph for the single supported FLUX text path."""
from __future__ import annotations

import json
from typing import Any

REQUIRED_NODE_CLASSES = {
    "CLIPTextEncode", "DualCLIPLoader", "EmptyFlux2LatentImage", "FluxGuidance",
    "KSampler", "LoraLoader", "SaveImage", "UNETLoader", "VAEDecode", "VAELoader",
}

FLUXED_UP = "fluxedUpFluxNSFW_102BF16.safetensors"
AIDMA = "aidmaNSFWunlock-FLUX-V0.2.safetensors"
VAE = "ae.safetensors"
CLIP_L = "clip_l.safetensors"
T5 = "t5xxl_fp8_e4m3fn_scaled.safetensors"


def validate_request(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("invalid_image_generation_request")
    if payload.get("mode") != "text_generation":
        raise ValueError("unsupported_image_mode")
    prompt = str(payload.get("prompt", "")).strip()
    if not prompt or len(prompt) > 4000:
        raise ValueError("invalid_prompt")
    width, height = int(payload.get("width", 0)), int(payload.get("height", 0))
    steps, cfg, strength = int(payload.get("steps", 0)), float(payload.get("cfg", 0)), float(payload.get("lora_strength", 0))
    seed = int(payload.get("seed", -1)); sampler = str(payload.get("sampler", ""))
    if width < 768 or height < 768 or width > 1280 or height > 1280 or width % 256 or height % 256:
        raise ValueError("rtx4090_resolution_required")
    if steps < 25 or steps > 40 or cfg < 3.5 or cfg > 5.0 or strength < 0.6 or strength > 1.1:
        raise ValueError("invalid_text_generation_settings")
    if seed < 0 or seed > 2_147_483_647 or sampler not in {"Euler", "FlowMatch"}:
        raise ValueError("invalid_sampler_or_seed")
    return {"prompt": prompt, "width": width, "height": height, "steps": steps, "cfg": cfg, "lora_strength": strength, "seed": seed, "sampler": sampler}


def assert_node_classes(object_info: object) -> None:
    available = set(object_info) if isinstance(object_info, dict) else set()
    missing = sorted(REQUIRED_NODE_CLASSES.difference(available))
    if missing:
        raise ValueError("runtime_missing_nodes:" + ",".join(missing))


def build_text_workflow(job_id: str, options: dict[str, Any]) -> dict[str, Any]:
    # FlowMatch is represented explicitly in metadata and uses the FLUX Euler/simple sampler pair.
    sampler_name = "euler" if options["sampler"] in {"Euler", "FlowMatch"} else "euler"
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": FLUXED_UP, "weight_dtype": "default"}},
        "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": CLIP_L, "clip_name2": T5, "type": "flux"}},
        "3": {"class_type": "LoraLoader", "inputs": {"model": ["1", 0], "clip": ["2", 0], "lora_name": AIDMA, "strength_model": options["lora_strength"], "strength_clip": options["lora_strength"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": options["prompt"], "clip": ["3", 1]}},
        "5": {"class_type": "FluxGuidance", "inputs": {"conditioning": ["4", 0], "guidance": options["cfg"]}},
        "6": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": options["width"], "height": options["height"], "batch_size": 1}},
        "7": {"class_type": "KSampler", "inputs": {"model": ["3", 0], "seed": options["seed"], "steps": options["steps"], "cfg": 1.0, "sampler_name": sampler_name, "scheduler": "simple", "positive": ["5", 0], "negative": ["5", 0], "latent_image": ["6", 0], "denoise": 1.0}},
        "8": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["8", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {"filename_prefix": f"image-{job_id}", "images": ["9", 0]}},
    }


def workflow_metadata(options: dict[str, Any]) -> dict[str, Any]:
    return {"mode": "text_generation", "transformer": FLUXED_UP, "lora": AIDMA, "vae": VAE, "clip_l": CLIP_L, "t5": T5, "sampling_mode": "flow_match_euler" if options["sampler"] == "FlowMatch" else "euler", "seed": options["seed"], "width": options["width"], "height": options["height"]}
