"""Validated ComfyUI API graphs for FLUX and SDXL checkpoint text paths."""
from __future__ import annotations

import json
import re
from typing import Any

FLUX_REQUIRED_NODE_CLASSES = {
    "CLIPTextEncode", "DualCLIPLoader", "EmptySD3LatentImage", "FluxGuidance",
    "KSampler", "LoraLoader", "SaveImage", "UNETLoader", "VAEDecode", "VAELoader",
}
SDXL_REQUIRED_NODE_CLASSES = {
    "CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "KSampler",
    "LoraLoader", "SaveImage", "VAEDecode",
}
# Backward-compatible public name used by the existing FLUX contract tests.
REQUIRED_NODE_CLASSES = FLUX_REQUIRED_NODE_CLASSES

FLUXED_UP = "fluxedUpFluxNSFW_102BF16.safetensors"
AIDMA = "aidmaNSFWunlock-FLUX-V0.2.safetensors"
VAE = "ae.safetensors"
CLIP_L = "clip_l.safetensors"
T5 = "t5xxl_fp8_e4m3fn_scaled.safetensors"
SAFE_LORA_FILENAME = re.compile(r"^[^/\\\x00-\x1f]{1,180}\.safetensors$", re.I)
MAX_LORAS = 8
# ComfyUI deliberately skips the unconditional/negative branch when the
# sampler CFG is exactly 1.0. Keep the proven FLUX cfg=1 path for an empty
# negative prompt, but use one conservative classifier-free scale when the
# user explicitly supplies negative conditioning.
NEGATIVE_PROMPT_CFG = 1.5


def validate_request(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("invalid_image_generation_request")
    if payload.get("mode") != "text_generation":
        raise ValueError("unsupported_image_mode")
    prompt = str(payload.get("prompt", "")).strip()
    if not prompt or len(prompt) > 4000:
        raise ValueError("invalid_prompt")
    negative_prompt = payload.get("negative_prompt", "")
    if not isinstance(negative_prompt, str) or len(negative_prompt) > 4000:
        raise ValueError("invalid_negative_prompt")
    family = str(payload.get("family", "flux1"))
    if family not in {"flux1", "sdxl"}:
        raise ValueError("unsupported_model_family")
    checkpoint = payload.get("checkpoint")
    checkpoint_filename = None
    if family == "sdxl":
        if (
            not isinstance(checkpoint, dict)
            or set(checkpoint) != {"id", "filename"}
            or not isinstance(checkpoint.get("id"), str)
            or not isinstance(checkpoint.get("filename"), str)
            or not SAFE_LORA_FILENAME.fullmatch(checkpoint["filename"])
        ):
            raise ValueError("invalid_checkpoint")
        checkpoint_filename = checkpoint["filename"]
    elif checkpoint is not None:
        raise ValueError("checkpoint_not_allowed_for_flux")
    width, height = int(payload.get("width", 0)), int(payload.get("height", 0))
    steps, cfg, strength = int(payload.get("steps", 0)), float(payload.get("cfg", 0)), float(payload.get("lora_strength", 0))
    seed = int(payload.get("seed", -1)); sampler = str(payload.get("sampler", ""))
    grid = 64 if family == "sdxl" else 256
    minimum = 512 if family == "sdxl" else 768
    if width < minimum or height < minimum or width > 1536 or height > 1536 or width % grid or height % grid:
        raise ValueError("unsupported_text_generation_resolution")
    cfg_min, cfg_max = (1.0, 12.0) if family == "sdxl" else (3.5, 5.0)
    if steps < 25 or steps > 40 or cfg < cfg_min or cfg > cfg_max or strength < 0.0 or strength > 1.5:
        raise ValueError("invalid_text_generation_settings")
    allowed_samplers = {"Euler", "FlowMatch"} if family == "flux1" else {
        "Euler a", "DPM++ 2M", "DPM++ 2M SDE", "DPM++ SDE", "DPM++ 3M SDE",
    }
    if seed < 0 or seed > 9_007_199_254_740_991 or sampler not in allowed_samplers:
        raise ValueError("invalid_sampler_or_seed")
    raw_loras = payload.get("loras")
    if raw_loras is None:
        # Backward compatibility: old tasks had only the fixed AIDMA strength.
        loras = [{"filename": AIDMA, "strength": strength}]
    else:
        if not isinstance(raw_loras, list) or len(raw_loras) > MAX_LORAS:
            raise ValueError("invalid_loras")
        loras = []
        seen: set[str] = set()
        for item in raw_loras:
            if not isinstance(item, dict) or set(item) != {"filename", "strength"}:
                raise ValueError("invalid_lora_fields")
            filename = item.get("filename")
            item_strength = item.get("strength")
            if (
                not isinstance(filename, str)
                or not SAFE_LORA_FILENAME.fullmatch(filename)
                or filename.lower() in seen
                or isinstance(item_strength, bool)
                or not isinstance(item_strength, (int, float))
                or not 0.0 <= float(item_strength) <= 1.5
            ):
                raise ValueError("invalid_lora")
            seen.add(filename.lower())
            loras.append({"filename": filename, "strength": float(item_strength)})
    return {
        "family": family,
        "checkpoint_filename": checkpoint_filename,
        "prompt": prompt,
        "negative_prompt": negative_prompt.strip(),
        "loras": loras,
        "width": width,
        "height": height,
        "steps": steps,
        "cfg": cfg,
        "lora_strength": strength,
        "seed": seed,
        "sampler": sampler,
    }


def assert_node_classes(object_info: object, require_lora: bool = True, family: str = "flux1") -> None:
    available = set(object_info) if isinstance(object_info, dict) else set()
    base = SDXL_REQUIRED_NODE_CLASSES if family == "sdxl" else FLUX_REQUIRED_NODE_CLASSES
    required = base if require_lora else base.difference({"LoraLoader"})
    missing = sorted(required.difference(available))
    if missing:
        raise ValueError("runtime_missing_nodes:" + ",".join(missing))


def build_text_workflow(job_id: str, options: dict[str, Any]) -> dict[str, Any]:
    if options["family"] == "sdxl":
        return build_sdxl_workflow(job_id, options)
    # FlowMatch is represented explicitly in metadata and uses the FLUX Euler/simple sampler pair.
    sampler_name = "euler" if options["sampler"] in {"Euler", "FlowMatch"} else "euler"
    graph: dict[str, Any] = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": FLUXED_UP, "weight_dtype": "default"}},
        "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": CLIP_L, "clip_name2": T5, "type": "flux"}},
        "6": {"class_type": "EmptySD3LatentImage", "inputs": {"width": options["width"], "height": options["height"], "batch_size": 1}},
        "8": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["8", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {"filename_prefix": f"image-{job_id}", "images": ["9", 0]}},
    }
    model_input: list[Any] = ["1", 0]
    clip_input: list[Any] = ["2", 0]
    for index, lora in enumerate(options["loras"]):
        node_id = str(20 + index)
        graph[node_id] = {
            "class_type": "LoraLoader",
            "inputs": {
                "model": model_input,
                "clip": clip_input,
                "lora_name": lora["filename"],
                "strength_model": lora["strength"],
                "strength_clip": lora["strength"],
            },
        }
        model_input = [node_id, 0]
        clip_input = [node_id, 1]
    graph["4"] = {"class_type": "CLIPTextEncode", "inputs": {"text": options["prompt"], "clip": clip_input}}
    graph["5"] = {"class_type": "FluxGuidance", "inputs": {"conditioning": ["4", 0], "guidance": options["cfg"]}}
    graph["11"] = {"class_type": "CLIPTextEncode", "inputs": {"text": options["negative_prompt"], "clip": clip_input}}
    negative_input: list[Any] = ["11", 0]
    sampler_cfg = 1.0
    if options["negative_prompt"]:
        # FluxGuidance controls the distilled FLUX guidance input. KSampler
        # CFG independently controls whether ComfyUI evaluates and combines
        # the positive and negative conditioning branches.
        graph["12"] = {
            "class_type": "FluxGuidance",
            "inputs": {"conditioning": negative_input, "guidance": options["cfg"]},
        }
        negative_input = ["12", 0]
        sampler_cfg = NEGATIVE_PROMPT_CFG
    graph["7"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": model_input,
            "seed": options["seed"],
            "steps": options["steps"],
            "cfg": sampler_cfg,
            "sampler_name": sampler_name,
            "scheduler": "simple",
            "positive": ["5", 0],
            "negative": negative_input,
            "latent_image": ["6", 0],
            "denoise": 1.0,
        },
    }
    return graph


def build_sdxl_workflow(job_id: str, options: dict[str, Any]) -> dict[str, Any]:
    sampler_map = {
        "Euler a": "euler_ancestral",
        "DPM++ 2M": "dpmpp_2m",
        "DPM++ 2M SDE": "dpmpp_2m_sde",
        "DPM++ SDE": "dpmpp_sde",
        "DPM++ 3M SDE": "dpmpp_3m_sde",
    }
    graph: dict[str, Any] = {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": options["checkpoint_filename"]},
        },
        "4": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": options["width"], "height": options["height"], "batch_size": 1},
        },
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["1", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": f"image-{job_id}", "images": ["8", 0]}},
    }
    model_input: list[Any] = ["1", 0]
    clip_input: list[Any] = ["1", 1]
    for index, lora in enumerate(options["loras"]):
        node_id = str(20 + index)
        graph[node_id] = {
            "class_type": "LoraLoader",
            "inputs": {
                "model": model_input,
                "clip": clip_input,
                "lora_name": lora["filename"],
                "strength_model": lora["strength"],
                "strength_clip": lora["strength"],
            },
        }
        model_input = [node_id, 0]
        clip_input = [node_id, 1]
    graph["2"] = {"class_type": "CLIPTextEncode", "inputs": {"text": options["prompt"], "clip": clip_input}}
    graph["3"] = {"class_type": "CLIPTextEncode", "inputs": {"text": options["negative_prompt"], "clip": clip_input}}
    graph["7"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": model_input,
            "seed": options["seed"],
            "steps": options["steps"],
            "cfg": options["cfg"],
            "sampler_name": sampler_map[options["sampler"]],
            "scheduler": "exponential",
            "positive": ["2", 0],
            "negative": ["3", 0],
            "latent_image": ["4", 0],
            "denoise": 1.0,
        },
    }
    return graph


def workflow_metadata(options: dict[str, Any]) -> dict[str, Any]:
    if options["family"] == "sdxl":
        return {
            "mode": "text_generation",
            "family": "sdxl",
            "checkpoint": options["checkpoint_filename"],
            "loras": [{"filename": item["filename"], "strength": item["strength"]} for item in options["loras"]],
            "negative_prompt_present": bool(options["negative_prompt"]),
            "sampling_mode": options["sampler"],
            "scheduler": "exponential",
            "seed": options["seed"],
            "width": options["width"],
            "height": options["height"],
        }
    return {
        "mode": "text_generation",
        "transformer": FLUXED_UP,
        "loras": [{"filename": item["filename"], "strength": item["strength"]} for item in options["loras"]],
        "negative_prompt_present": bool(options["negative_prompt"]),
        "negative_prompt_cfg": NEGATIVE_PROMPT_CFG if options["negative_prompt"] else 1.0,
        "vae": VAE,
        "clip_l": CLIP_L,
        "t5": T5,
        "sampling_mode": "flow_match_euler" if options["sampler"] == "FlowMatch" else "euler",
        "seed": options["seed"],
        "width": options["width"],
        "height": options["height"],
    }
