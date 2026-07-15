import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type Plan = {
  cacheRunTriggered: boolean;
  officialModel: { repository: string; revision: string; registryStatus: string };
  comfyCacheSource: { repository: string; revision: string; totalSizeBytes: number; r2AdditionalCapacityBytes: number; files: Array<{ sourcePath: string; targetPath: string; sizeBytes: number; sha256: string }> };
  githubActionsCachePlan: { trigger: string; parallelJobs: string[]; publishAfterAllShaVerified: boolean; runNow: boolean };
  workflow: { asset: string; executionStatus: string; requiredNodeClasses: string[] };
  inferencePlans: Array<{ gpu: string; runtimeCompatible: boolean; blocker?: string }>;
};

const plan = JSON.parse(readFileSync("benchmark/wan-first-video/stage3m-plan.json", "utf8")) as Plan;
const workflow = JSON.parse(readFileSync(plan.workflow.asset, "utf8")) as Record<string, { class_type?: string }>;
assert.equal(plan.officialModel.repository, "Wan-AI/Wan2.2-TI2V-5B");
assert.match(plan.officialModel.revision, /^[a-f0-9]{40}$/);
assert.equal(plan.officialModel.registryStatus, "eligible_for_benchmark");
assert.equal(plan.comfyCacheSource.repository, "Comfy-Org/Wan_2.2_ComfyUI_Repackaged");
assert.match(plan.comfyCacheSource.revision, /^[a-f0-9]{40}$/);
assert.equal(plan.comfyCacheSource.files.length, 3);
assert.equal(plan.comfyCacheSource.files.reduce((sum, file) => sum + file.sizeBytes, 0), plan.comfyCacheSource.totalSizeBytes);
assert.equal(plan.comfyCacheSource.r2AdditionalCapacityBytes, plan.comfyCacheSource.totalSizeBytes);
for (const file of plan.comfyCacheSource.files) {
  assert.ok(file.sourcePath.startsWith("split_files/"));
  assert.ok(!file.targetPath.includes(".."));
  assert.ok(file.sizeBytes > 0);
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
}
const workflowNodes = new Set(Object.values(workflow).map((node) => node.class_type));
for (const node of plan.workflow.requiredNodeClasses) assert.ok(workflowNodes.has(node), `missing workflow node ${node}`);
assert.equal(plan.workflow.executionStatus, "api_executable_when_models_present");
assert.equal(plan.githubActionsCachePlan.trigger, "workflow_dispatch_only");
assert.equal(plan.githubActionsCachePlan.parallelJobs.length, 3);
assert.equal(plan.githubActionsCachePlan.publishAfterAllShaVerified, true);
assert.equal(plan.githubActionsCachePlan.runNow, false);
assert.equal(plan.cacheRunTriggered, false);
assert.ok(plan.inferencePlans.some((item) => item.gpu.includes("4090") && item.runtimeCompatible));
for (const item of plan.inferencePlans.filter((entry) => !entry.runtimeCompatible)) assert.ok(item.blocker);
console.log("wan_cache_plan_valid=true");
console.log("wan_workflow_plan_valid=true");
