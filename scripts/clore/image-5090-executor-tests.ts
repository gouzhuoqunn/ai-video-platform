import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { classifyImageGpu } from "../../src/lib/image-generation/flux-stack";
import type { LocalImageTask } from "../../src/lib/image-generation/local-image-task-store";
import { planImageSession } from "./image-session";
import { assertStageGpuMatches } from "./image-session-live";
import { chooseCheapestImageCandidate } from "../image-4090-runner";
import { buildHttpRuntimeCreateOrderBody } from "./order-execution";

const task = (id: string, width: number, height: number, gpuClass: "rtx4090" | "rtx5090", patch: Record<string, unknown> = {}): LocalImageTask => ({
  id,
  status: "waiting_for_gpu",
  mode: "text_generation",
  referenceImage: null,
  prompt: `fixture-${id}`,
  width,
  height,
  gpuClass,
  steps: 30,
  cfg: 4,
  loraStrength: .8,
  seed: 1,
  sampler: "FlowMatch",
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
  ...patch,
});

assert.equal(classifyImageGpu(1280, 1280), "rtx4090");
assert.equal(classifyImageGpu(1536, 1536), "rtx5090");
assert.equal(classifyImageGpu(1536, 1024), "rtx5090");
assert.equal(classifyImageGpu(1024, 1536), "rtx5090");
assert.equal(classifyImageGpu(1280, 1536), "rtx5090");
assert.equal(classifyImageGpu(1536, 1280), "rtx5090");
assert.equal(classifyImageGpu(1792, 1024), null);
assert.equal(classifyImageGpu(1537, 1024), null);

const low = task("4090", 1280, 1280, "rtx4090");
const high = task("5090", 1536, 1536, "rtx5090");
const highWide = task("5090-wide", 1536, 1024, "rtx5090");
const defaultPlan = planImageSession([low, high], { activeOrderCount: 0 });
assert.deepEqual(defaultPlan.selectedTaskIds, ["4090"]);
assert.equal(defaultPlan.selectedGpuClass, "RTX 4090");
const highPlan = planImageSession([low, high, highWide], { gpuClass: "rtx5090", activeOrderCount: 0, selectedHourlyUsd: .3 });
assert.deepEqual(highPlan.selectedTaskIds, ["5090", "5090-wide"]);
assert.equal(highPlan.selectedGpuClass, "RTX 5090");
assert.deepEqual(highPlan.selectedDimensions, [{ taskId: "5090", width: 1536, height: 1536 }, { taskId: "5090-wide", width: 1536, height: 1024 }]);
assert.equal(highPlan.executionEligible, true);
assert.equal(planImageSession([task("reference", 1536, 1536, "rtx5090", { referenceImage: "data:image/png;base64,AA==" })], { gpuClass: "rtx5090" }).count, 0);

const selectedCandidate = chooseCheapestImageCandidate([
  { gpuNormalizedName: "NVIDIA GeForce RTX 4090", orderType: "on-demand", hostOnline: true, priceUsdPerHour: .1, id: "wrong-gpu" },
  { gpuNormalizedName: "NVIDIA GeForce RTX 5090", orderType: "spot", hostOnline: true, priceUsdPerHour: .05, id: "spot" },
  { gpuNormalizedName: "NVIDIA GeForce RTX 5090", orderType: "on-demand", hostOnline: true, priceUsdPerHour: .28, id: "higher" },
  { gpuNormalizedName: "NVIDIA GeForce RTX 5090", orderType: "on-demand", hostOnline: true, priceUsdPerHour: .21, id: "cheapest" },
], "rtx5090", .30);
assert.equal(selectedCandidate?.id, "cheapest");

assert.equal(buildHttpRuntimeCreateOrderBody({ serverId: "5090", currency: "USD-Blockchain", requiredPrice: 7.2, gpuProfile: "rtx5090" }).env?.COMFY_GPU_PROFILE, "rtx5090");
assert.equal(buildHttpRuntimeCreateOrderBody({ serverId: "4090", currency: "USD-Blockchain", requiredPrice: 7.2 }).env?.COMFY_GPU_PROFILE, "rtx4090");

assert.doesNotThrow(() => assertStageGpuMatches("RTX 5090", { nvidia_smi: { stdout: "NVIDIA GeForce RTX 5090" } }));
assert.doesNotThrow(() => assertStageGpuMatches("RTX 5090", { nvidia_smi: { first_output_lines: ["NVIDIA GeForce RTX 5090"], final_output_lines: ["NVIDIA GeForce RTX 5090"] } }));
assert.doesNotThrow(() => assertStageGpuMatches("RTX 4090", { nvidia_smi: { final_output_lines: ["| 0  NVIDIA GeForce RTX 4090  On |"] } }));
assert.doesNotThrow(() => assertStageGpuMatches("RTX 4090", { nvidia_smi: { output: "| 0  NVIDIA GeForce RTX 4090  On |" } }), "the pinned Agent exec_fixed contract uses output");
assert.throws(() => assertStageGpuMatches("RTX 5090", { nvidia_smi: { stdout: "NVIDIA GeForce RTX 4090" } }), /gpu_hardware_mismatch/);
assert.throws(() => assertStageGpuMatches("RTX 4090", { nvidia_smi: { final_output_lines: [] } }), /gpu_hardware_mismatch/);
assert.throws(() => assertStageGpuMatches("RTX 4090", { nvidia_smi: { final_output_lines: ["x".repeat(501)] } }), /gpu_stage_output_contract_invalid/);
assert.throws(() => assertStageGpuMatches("RTX 4090", { nvidia_smi: { first_output_lines: "NVIDIA GeForce RTX 4090" } }), /gpu_stage_output_contract_invalid/);

const workflow = path.join(process.cwd(), "comfy-runtime", "image_workflow.py").replace(/\\/g, "/");
const output = execFileSync("python", ["-c", `import importlib.util,json; s=importlib.util.spec_from_file_location('workflow','${workflow}'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); o=m.validate_request({'mode':'text_generation','prompt':'fixture','width':1536,'height':1536,'steps':30,'cfg':4,'lora_strength':.8,'seed':9,'sampler':'FlowMatch'}); w=m.build_text_workflow('fixture',o); print(json.dumps({'width':w['6']['inputs']['width'],'height':w['6']['inputs']['height']}))`], { encoding: "utf8" });
assert.deepEqual(JSON.parse(output), { width: 1536, height: 1536 });

console.log("image-5090-executor-tests: ok", JSON.stringify({ providerMutationCount: 0 }));
