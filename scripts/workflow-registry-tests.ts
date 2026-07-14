import assert from "node:assert/strict";
import { injectWorkflowParameters, validateWorkflowTemplate, WORKFLOW_TEMPLATES } from "../src/lib/generation/workflow-registry";

function main() {
  assert.deepEqual(Object.keys(WORKFLOW_TEMPLATES).sort(), ["image_t2i", "video_flf2v", "video_i2v", "video_ti2v"]);

  for (const workflow of Object.values(WORKFLOW_TEMPLATES)) {
    assert.deepEqual(validateWorkflowTemplate(workflow), [], `${workflow.key} must validate`);
    assert.equal(workflow.api_format, "comfy_api_json");
    if (workflow.key === "video_flf2v") {
      assert.equal(workflow.origin, "community");
      assert.ok(workflow.required_custom_nodes.length > 0);
    } else {
      assert.equal(workflow.origin, "official");
    }
  }

  assert.notEqual(WORKFLOW_TEMPLATES.video_i2v.template.latent, WORKFLOW_TEMPLATES.video_flf2v.template.latent);
  const injected = injectWorkflowParameters(WORKFLOW_TEMPLATES.video_i2v, {
    prompt: "safe fixture",
    negative_prompt: "watermark",
    seed: 123,
    width: 854,
    height: 480,
    frames: 49,
  }) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(injected.positive_prompt.inputs.text, "safe fixture");
  assert.equal(injected.negative_prompt.inputs.text, "watermark");
  assert.equal(injected.sampler.inputs.seed, 123);
  assert.equal(injected.latent.inputs.width, 854);
  assert.equal(injected.latent.inputs.frames, 49);

  console.log("workflow registry tests passed");
}

main();
