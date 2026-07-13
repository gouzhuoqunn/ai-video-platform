import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MockComfyRuntimeClient, COMFYUI_BIND_HOST, COMFYUI_COMMIT } from "../src/lib/generation/comfy-runtime";
import { classifyBenchmarkError, runMockBenchmark } from "../src/lib/generation/benchmark-runner";
import { evaluateCandidateForProfile, GPU_PROFILES } from "../src/lib/generation/gpu-profiles";
import { MODEL_CANDIDATES, MODEL_SLOTS, validateModelCandidate } from "../src/lib/generation/model-registry";
import { PRODUCTION_PROFILE_PATHS, validateProductionManifest, type R2ProductionManifest } from "../src/lib/generation/r2-cache-plan";
import { injectWorkflowParameters, validateWorkflowTemplate, WORKFLOW_TEMPLATES } from "../src/lib/generation/workflow-registry";

async function main() {
  assert.equal(COMFYUI_COMMIT.length, 40, "ComfyUI commit must be pinned");
  assert.equal(COMFYUI_BIND_HOST, "127.0.0.1", "ComfyUI must bind locally");

  const accepted4090 = evaluateCandidateForProfile("rtx4090", {
    gpuNormalizedName: "NVIDIA GeForce RTX 4090",
    gpuCount: 1,
    gpuMemoryGb: 24,
    gpuMemoryRawUnit: "GB",
    ramGb: 64,
    diskGb: 200,
    orderType: "on-demand",
  });
  assert.equal(accepted4090.accepted, true, "4090 hard minimum candidate should pass");

  const accepted5090 = evaluateCandidateForProfile("rtx5090", {
    gpuNormalizedName: "NVIDIA GeForce RTX 5090",
    gpuCount: 1,
    gpuMemoryGb: 31,
    gpuMemoryRawUnit: "display_gb",
    ramGb: 80,
    diskGb: 250,
    orderType: "on-demand",
  });
  assert.equal(accepted5090.accepted, true, "5090 display VRAM tolerance should pass");

  const rejected4090 = evaluateCandidateForProfile("rtx4090", {
    gpuNormalizedName: "NVIDIA GeForce RTX 5090",
    gpuCount: 1,
    gpuMemoryGb: 31,
    gpuMemoryRawUnit: "GB",
    ramGb: 128,
    diskGb: 300,
    orderType: "on-demand",
  });
  assert.equal(rejected4090.accepted, false, "4090 profile must require exact 4090 model");

  for (const profile of Object.values(GPU_PROFILES)) {
    assert.ok(["aggressive", "balanced"].includes(profile.offloadPolicy));
  }

  for (const slot of MODEL_SLOTS) {
    assert.ok(MODEL_CANDIDATES.some((candidate) => candidate.slot === slot), `${slot} must have at least one candidate`);
  }
  for (const candidate of MODEL_CANDIDATES) {
    assert.deepEqual(validateModelCandidate(candidate), [], `${candidate.key} must satisfy the model schema`);
    assert.ok(candidate.sha256 === "" || /^[a-f0-9]{64}$/.test(candidate.sha256), "unknown sha256 must stay empty");
    assert.notEqual(candidate.status, "production", "benchmark registry must not auto-promote production");
  }

  for (const workflow of Object.values(WORKFLOW_TEMPLATES)) {
    assert.deepEqual(validateWorkflowTemplate(workflow), [], `${workflow.key} workflow schema must be valid`);
  }
  const injected = injectWorkflowParameters(WORKFLOW_TEMPLATES.video_ti2v, {
    prompt: "hello",
    seed: 42,
    width: 1280,
    height: 704,
    frames: 121,
  }) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(injected.positive_prompt.inputs.text, "hello");
  assert.equal(injected.sampler.inputs.seed, 42);
  assert.equal(injected.latent.inputs.frames, 121);

  assert.equal(classifyBenchmarkError(new Error("CUDA out of memory")), "oom");
  assert.equal(classifyBenchmarkError(new Error("missing node KSampler")), "missing_node");
  assert.equal(classifyBenchmarkError(new Error("missing output video")), "missing_output");
  assert.equal(classifyBenchmarkError(new Error("timed out")), "timeout");

  const runtime = new MockComfyRuntimeClient();
  const { promptId } = await runtime.submitWorkflow(WORKFLOW_TEMPLATES.image_t2i, { prompt: "mock", seed: 7 });
  assert.equal((await runtime.getPromptStatus(promptId)).status, "running");
  assert.equal((await runtime.getPromptStatus(promptId)).status, "completed");
  assert.equal((await runtime.getOutputs(promptId)).length, 1);
  const interrupt = await runtime.submitWorkflow(WORKFLOW_TEMPLATES.image_t2i, { prompt: "stop", seed: 8 });
  assert.equal((await runtime.interrupt(interrupt.promptId)).status, "interrupted");

  const benchmark = await runMockBenchmark(
    {
      candidate: MODEL_CANDIDATES.find((candidate) => candidate.key === "wan22-ti2v-5b-official")!,
      gpuProfile: "rtx4090",
      workflow: WORKFLOW_TEMPLATES.video_ti2v,
      sampleCount: 2,
      timeoutSeconds: 60,
      continueAfterFailure: false,
    },
    new MockComfyRuntimeClient(),
  );
  assert.equal(benchmark.success, true);
  assert.equal(benchmark.errorClass, "none");
  assert.ok(benchmark.metrics.outputPath?.endsWith("output.mock"));

  const productionManifest: R2ProductionManifest = {
    schemaVersion: 1,
    shared: {
      vae: { key: "shared/vae/model.safetensors", sha256: "" },
      clip: { key: "shared/clip/model.safetensors", sha256: "" },
    },
    production: {
      "rtx4090/image": { candidateKey: "flux2-klein-4b-official", manifestKey: "manifests/4090-image.json", workflowKey: "image_t2i" },
      "rtx4090/video": { candidateKey: "wan22-ti2v-5b-official", manifestKey: "manifests/4090-video.json", workflowKey: "video_ti2v" },
      "rtx5090/image": { candidateKey: "flux2-klein-9b-official", manifestKey: "manifests/5090-image.json", workflowKey: "image_t2i" },
      "rtx5090/video": { candidateKey: "wan22-a14b-i2v-fp8-official", manifestKey: "manifests/5090-video.json", workflowKey: "video_i2v" },
    },
    publishOrder: ["benchmark-staging", "shared", "workflows", "manifests", "current.json"],
  };
  assert.deepEqual(Object.keys(productionManifest.production).sort(), [...PRODUCTION_PROFILE_PATHS].sort());
  assert.deepEqual(validateProductionManifest(productionManifest), []);

  const dedupeFailure: R2ProductionManifest = {
    ...productionManifest,
    shared: {
      vae: { key: "shared/common/model.safetensors", sha256: "" },
      clip: { key: "shared/common/model.safetensors", sha256: "" },
    },
  };
  assert.ok(validateProductionManifest(dedupeFailure).includes("shared components must be deduplicated by key"));

  const studio = readFileSync("src/components/StudioExperience.tsx", "utf8");
  const localStudio = readFileSync("src/components/LocalCreationStudio.tsx", "utf8");
  const profilePage = readFileSync("src/app/generate/[profile]/page.tsx", "utf8");
  const profileComponent = readFileSync("src/components/GenerationProfilePage.tsx", "utf8");
  for (const mode of ["", "local_lab", "commercial"]) {
    process.env.NEXT_PUBLIC_APP_MODE = mode;
    assert.ok(!studio.includes("CommercialStudioExperience"), "APP_MODE must not route to the old commercial shell");
  }
  assert.ok(profilePage.includes("4090") && profilePage.includes("5090"), "profile route must support both 4090 and 5090");
  assert.ok(localStudio.includes("/generate/4090") && localStudio.includes("/generate/5090"), "home must expose minimal profile links");
  assert.ok(!/neon|glow|from-purple|to-blue|backdrop-blur-xl/i.test(profileComponent), "profile page must not reintroduce neon styling");

  console.log("generation architecture tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
