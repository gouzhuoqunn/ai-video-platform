#!/usr/bin/env python3
"""Focused FLUX image workflow latent-size regression test."""
import importlib.util
from pathlib import Path

PATH = Path(__file__).with_name("image_workflow.py")
spec = importlib.util.spec_from_file_location("image_workflow_test", PATH)
assert spec and spec.loader
workflow = importlib.util.module_from_spec(spec); spec.loader.exec_module(workflow)

assert "EmptySD3LatentImage" in workflow.REQUIRED_NODE_CLASSES
assert "EmptyFlux2LatentImage" not in workflow.REQUIRED_NODE_CLASSES
options = {"prompt": "fixture", "width": 768, "height": 768, "steps": 25, "cfg": 4.0, "lora_strength": 0.8, "seed": 1, "sampler": "Euler"}
graph = workflow.build_text_workflow("fixture-job", options)
assert graph["6"]["class_type"] == "EmptySD3LatentImage"
assert graph["6"]["inputs"] == {"width": 768, "height": 768, "batch_size": 1}
assert all(node["class_type"] != "EmptyFlux2LatentImage" for node in graph.values())
try: workflow.assert_node_classes({name: {} for name in workflow.REQUIRED_NODE_CLASSES if name != "EmptySD3LatentImage"})
except ValueError as error: assert str(error) == "runtime_missing_nodes:EmptySD3LatentImage"
else: raise AssertionError("missing EmptySD3LatentImage must fail before prompt submission")
print('{"ok":true,"sd3_latent_node_required":true,"requested_768_dimensions_direct":true,"old_flux2_node_absent":true}')
