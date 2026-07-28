#!/usr/bin/env python3
"""Focused contracts for the validated FLUX image workflow."""
import importlib.util
from pathlib import Path

PATH = Path(__file__).with_name("image_workflow.py")
spec = importlib.util.spec_from_file_location("image_workflow_test", PATH)
assert spec and spec.loader
workflow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)


def payload(**updates):
    value = {
        "mode": "text_generation",
        "prompt": "positive fixture",
        "width": 768,
        "height": 768,
        "steps": 25,
        "cfg": 4.0,
        "lora_strength": 0.8,
        "seed": 1,
        "sampler": "Euler",
    }
    value.update(updates)
    return value


def expect_validation_error(expected, **updates):
    try:
        workflow.validate_request(payload(**updates))
    except ValueError as error:
        assert str(error) == expected
    else:
        raise AssertionError(f"expected {expected}")


assert "EmptySD3LatentImage" in workflow.REQUIRED_NODE_CLASSES
assert "EmptyFlux2LatentImage" not in workflow.REQUIRED_NODE_CLASSES

# A task without the new `loras` field is the legacy contract: it must still
# load the pinned AIDMA LoRA at the old task's single lora_strength value.
options = workflow.validate_request(payload())
assert options["negative_prompt"] == ""
assert options["loras"] == [{"filename": workflow.AIDMA, "strength": 0.8}]
graph = workflow.build_text_workflow("fixture-job", options)
assert graph["6"]["class_type"] == "EmptySD3LatentImage"
assert graph["6"]["inputs"] == {"width": 768, "height": 768, "batch_size": 1}
assert all(node["class_type"] != "EmptyFlux2LatentImage" for node in graph.values())
assert graph["20"]["class_type"] == "LoraLoader"
assert graph["20"]["inputs"] == {
    "model": ["1", 0],
    "clip": ["2", 0],
    "lora_name": workflow.AIDMA,
    "strength_model": 0.8,
    "strength_clip": 0.8,
}
assert graph["7"]["inputs"]["model"] == ["20", 0]

# An explicit empty list is intentionally different from a legacy task: no
# LoraLoader may be emitted and the base model/CLIP feed the graph directly.
no_lora_options = workflow.validate_request(payload(
    negative_prompt="  unwanted anatomy  ",
    loras=[],
))
assert no_lora_options["negative_prompt"] == "unwanted anatomy"
assert no_lora_options["loras"] == []
no_lora_graph = workflow.build_text_workflow("no-lora-job", no_lora_options)
assert all(node["class_type"] != "LoraLoader" for node in no_lora_graph.values())
assert no_lora_graph["4"]["inputs"]["clip"] == ["2", 0]
assert no_lora_graph["11"]["inputs"]["clip"] == ["2", 0]
assert no_lora_graph["7"]["inputs"]["model"] == ["1", 0]
base_nodes = {
    "CLIPTextEncode": {},
    "DualCLIPLoader": {},
    "EmptySD3LatentImage": {},
    "FluxGuidance": {},
    "KSampler": {},
    "SaveImage": {},
    "UNETLoader": {},
    "VAEDecode": {},
    "VAELoader": {},
}
workflow.assert_node_classes(base_nodes, require_lora=False)
try:
    workflow.assert_node_classes(base_nodes)
except ValueError as error:
    assert str(error) == "runtime_missing_nodes:LoraLoader"
else:
    raise AssertionError("enabled LoRA path must require the LoraLoader node")

# Two independently weighted LoRAs must form one deterministic model/CLIP
# chain. Both positive and negative encoders use the final chained CLIP.
two_loras = [
    {"filename": "first.safetensors", "strength": 0.35},
    {"filename": "second.safetensors", "strength": 1.25},
]
two_options = workflow.validate_request(payload(
    negative_prompt="negative fixture",
    loras=two_loras,
))
two_graph = workflow.build_text_workflow("two-lora-job", two_options)
assert two_graph["20"]["inputs"] == {
    "model": ["1", 0],
    "clip": ["2", 0],
    "lora_name": "first.safetensors",
    "strength_model": 0.35,
    "strength_clip": 0.35,
}
assert two_graph["21"]["inputs"] == {
    "model": ["20", 0],
    "clip": ["20", 1],
    "lora_name": "second.safetensors",
    "strength_model": 1.25,
    "strength_clip": 1.25,
}
assert two_graph["4"]["inputs"] == {"text": "positive fixture", "clip": ["21", 1]}
assert two_graph["11"]["inputs"] == {"text": "negative fixture", "clip": ["21", 1]}
assert two_graph["5"]["inputs"]["conditioning"] == ["4", 0]
assert two_graph["7"]["inputs"]["model"] == ["21", 0]
assert two_graph["7"]["inputs"]["positive"] == ["5", 0]
assert two_graph["7"]["inputs"]["negative"] == ["11", 0]
assert two_graph["7"]["inputs"]["positive"] != two_graph["7"]["inputs"]["negative"]

# Three LoRAs prove the chain keeps extending in order and preserves the full
# accepted 0.0-1.5 strength range independently for every loader.
three_loras = [
    {"filename": "zero.safetensors", "strength": 0.0},
    {"filename": "middle.safetensors", "strength": 0.75},
    {"filename": "maximum.safetensors", "strength": 1.5},
]
three_options = workflow.validate_request(payload(loras=three_loras))
three_graph = workflow.build_text_workflow("three-lora-job", three_options)
assert [three_graph[str(node)]["inputs"]["lora_name"] for node in (20, 21, 22)] == [
    "zero.safetensors",
    "middle.safetensors",
    "maximum.safetensors",
]
assert three_graph["20"]["inputs"]["model"] == ["1", 0]
assert three_graph["21"]["inputs"]["model"] == ["20", 0]
assert three_graph["22"]["inputs"]["model"] == ["21", 0]
assert three_graph["20"]["inputs"]["clip"] == ["2", 0]
assert three_graph["21"]["inputs"]["clip"] == ["20", 1]
assert three_graph["22"]["inputs"]["clip"] == ["21", 1]
for node_id, expected_strength in (("20", 0.0), ("21", 0.75), ("22", 1.5)):
    assert three_graph[node_id]["inputs"]["strength_model"] == expected_strength
    assert three_graph[node_id]["inputs"]["strength_clip"] == expected_strength
assert three_graph["7"]["inputs"]["model"] == ["22", 0]
assert workflow.workflow_metadata(three_options)["loras"] == three_loras

# Malformed lists, extra fields, unsafe paths, duplicate filenames, invalid
# strengths and the loader cap must fail before workflow construction.
expect_validation_error("invalid_loras", loras="not-a-list")
expect_validation_error("invalid_lora_fields", loras=[{"filename": "one.safetensors"}])
expect_validation_error(
    "invalid_lora_fields",
    loras=[{"filename": "one.safetensors", "strength": 0.8, "extra": True}],
)
expect_validation_error(
    "invalid_lora",
    loras=[{"filename": "../escape.safetensors", "strength": 0.8}],
)
expect_validation_error(
    "invalid_lora",
    loras=[{"filename": "boolean.safetensors", "strength": True}],
)
expect_validation_error(
    "invalid_lora",
    loras=[{"filename": "too-strong.safetensors", "strength": 1.5001}],
)
expect_validation_error(
    "invalid_lora",
    loras=[
        {"filename": "duplicate.safetensors", "strength": 0.5},
        {"filename": "DUPLICATE.safetensors", "strength": 0.6},
    ],
)
expect_validation_error(
    "invalid_loras",
    loras=[
        {"filename": f"item-{index}.safetensors", "strength": 0.8}
        for index in range(workflow.MAX_LORAS + 1)
    ],
)
expect_validation_error("invalid_negative_prompt", negative_prompt="x" * 4001, loras=[])

try:
    workflow.assert_node_classes({
        name: {}
        for name in workflow.REQUIRED_NODE_CLASSES
        if name != "EmptySD3LatentImage"
    })
except ValueError as error:
    assert str(error) == "runtime_missing_nodes:EmptySD3LatentImage"
else:
    raise AssertionError("missing EmptySD3LatentImage must fail before prompt submission")

print(
    '{"ok":true,'
    '"sd3_latent_node_required":true,'
    '"requested_768_dimensions_direct":true,'
    '"old_flux2_node_absent":true,'
    '"legacy_aidma":true,'
    '"explicit_zero_lora":true,'
    '"multi_lora_chaining":true,'
    '"independent_negative_conditioning":true,'
    '"invalid_loras_rejected":true}'
)
