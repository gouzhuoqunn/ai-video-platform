import assert from "node:assert/strict";
import { classifyImageGpu, createFluxExecutionConfig, FLUX_IMAGE_STACK } from "../src/lib/image-generation/flux-stack";

assert.equal(classifyImageGpu(1280, 1280), "rtx4090");
assert.equal(classifyImageGpu(1280, 1536), "rtx5090");
assert.equal(classifyImageGpu(1536, 768), "rtx5090");

const config = createFluxExecutionConfig({
  prompt: "reference-aware portrait edit",
  referenceImage: "data:image/png;base64,AA==",
  steps: 30,
  loraStrength: 0.8,
  cfg: 4,
  sampler: "FlowMatch",
  width: 768,
  height: 1280,
  gpuClass: "rtx4090",
});

assert.deepEqual(config.stack, FLUX_IMAGE_STACK);
assert.equal(config.mode, "kontext_edit");
assert.equal(config.referenceMode, "flux_kontext_reference_aware");
assert.deepEqual(config.resolution, { width: 768, height: 1280 });
assert.equal(config.gpuClass, "rtx4090");
console.log("image pivot contract: ok");
