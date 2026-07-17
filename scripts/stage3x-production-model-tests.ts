import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { buildCurrentPointer, buildProductionManifest, loadProductionFamilies, productionPublishPlan } from "./model-cache/production-model-cache";
import { buildRemoteRestoreLaunchCommand, buildRemoteRestorePollCommand, RESTORE_CONTROLLER_POLICY } from "./clore/production-r2-restore";
import { acceptableGpuClasses, validateProductionCandidate } from "../src/lib/generation/task-pool";
import { modelAvailabilityGate } from "../src/lib/generation/model-availability";
import { validateProductionPrompt } from "../src/lib/generation/production-prompt-safety";

const root = process.cwd();
const json = <T>(relative: string) => JSON.parse(readFileSync(path.join(root, relative), "utf8")) as T;
const text = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const audit = json<any>("benchmark/stage3x/civitai-model-audit.json");
assert.equal(audit.models.length, 2);
assert.equal(audit.models[0].versions.length, 4);
assert.equal(audit.models[1].versions.length, 14);
const ultraSelected = audit.models[0].versions.find((version: any) => version.id === 1413133).files.find((file: any) => file.id === 1320644);
assert.deepEqual([ultraSelected.format, ultraSelected.fp, ultraSelected.sha256], ["SafeTensor", "fp8", "4E675980EA771AE64B566FA5A81CD8FBECDE1A1A7CE8B6F0207E836B6F28C18E"]);
const wanV3 = audit.models[1].versions.filter((version: any) => [2770795, 2771407].includes(version.id));
assert.equal(wanV3.length, 2);
assert.ok(wanV3.every((version: any) => version.baseModel === "Wan Video 2.2 I2V-A14B" && version.files.every((file: any) => file.format === "SafeTensor" && file.fp === "fp8")));
assert.ok(audit.models[1].versions.some((version: any) => version.name.startsWith("T2V")));

const registry = json<any>("comfy-runtime/production-model-registry.json");
assert.deepEqual(registry.hardwarePolicy.gpuClasses, ["rtx4090", "rtx5090"]);
assert.equal(registry.hardwarePolicy.minimumRamGb, 32);
assert.equal(registry.hardwarePolicy.preferredRamGb, 64);
assert.equal(registry.hardwarePolicy.minimumDiskGb, 200);
assert.equal(registry.credentialGate.downloadOrDispatchAllowed, true);
assert.equal(registry.credentialGate.hfTokenPresent, true);
assert.equal(registry.families[1].adultModel, true);
assert.equal(registry.profiles.length, 4);
assert.equal(new Set(registry.profiles.map((profile: any) => profile.familyId)).size, 2);
assert.deepEqual(registry.legacy.map((entry: any) => entry.status), ["legacy_verified", "legacy_cached"]);

for (const family of loadProductionFamilies()) {
  const manifest = buildProductionManifest(family, "2026-07-17T00:00:00.000Z");
  assert.equal(manifest.totalSizeBytes, family.restoreBytes);
  assert.ok(manifest.files.every((file) => file.objectKey.endsWith(file.sha256)));
  const current = buildCurrentPointer(family, manifest);
  assert.equal(current.manifestKey, `${family.r2Prefix}/manifests/${family.revision}.json`);
  const plan = productionPublishPlan(family);
  assert.equal(plan.currentPublishedLast, true);
  assert.equal(plan.uploadOrder.at(-1)?.key, family.currentKey);
  assert.ok(plan.uploadOrder.filter((entry) => entry.kind === "object").every((entry) => entry.verify.includes("HEAD:size") && entry.verify.includes("Range:bytes=0-0")));
}

for (const gpu of ["rtx4090", "rtx5090"]) {
  const workflow = json<any>(`comfy-runtime/workflows/production/ultrareal-flux1-dev-fp8-${gpu}-api.json`);
  assert.equal(workflow["1"].inputs.unet_name, "ultrarealFineTune_v4_fp8.safetensors");
  assert.equal(workflow["2"].class_type, "DualCLIPLoader");
  assert.equal(workflow["2"].inputs.type, "flux");
  assert.equal(workflow["5"].inputs.guidance, 3);
  assert.deepEqual([workflow["7"].inputs.steps, workflow["7"].inputs.sampler_name, workflow["7"].inputs.scheduler], [50, "dpmpp_2m", "beta"]);
  assert.deepEqual([workflow["6"].inputs.width, workflow["6"].inputs.height, workflow["7"].inputs.seed], [1024, 1024, 20260715]);
  assert.ok(!text(`comfy-runtime/workflows/production/ultrareal-flux1-dev-fp8-${gpu}-api.json`).match(/lora|upscale/i));
}

for (const [gpu, expected] of [["rtx4090", [832, 480, 33]], ["rtx5090", [1280, 704, 41]]] as const) {
  const workflow = json<any>(`comfy-runtime/workflows/production/wan22-remix-14b-i2v-fp8-${gpu}-api.json`);
  assert.equal(workflow["1"].inputs.unet_name, "wan22RemixT2VI2V_i2vHighV30.safetensors");
  assert.equal(workflow["2"].inputs.unet_name, "wan22RemixT2VI2V_i2vLowV30.safetensors");
  assert.deepEqual([workflow["8"].inputs.width, workflow["8"].inputs.height, workflow["8"].inputs.length], expected);
  assert.deepEqual([workflow["11"].inputs.end_at_step, workflow["12"].inputs.start_at_step], [10, 10]);
  assert.equal(workflow["5"].class_type, "LoadImage");
  assert.equal(workflow["14"].class_type, "SaveWEBM");
  assert.ok(!text(`comfy-runtime/workflows/production/wan22-remix-14b-i2v-fp8-${gpu}-api.json`).match(/audio|upscale|first.*last|last.*first/i));
}

assert.deepEqual(acceptableGpuClasses("image", "ultrareal-flux1-dev-fp8"), ["rtx4090", "rtx5090"]);
assert.deepEqual(acceptableGpuClasses("video", "wan22-remix-14b-i2v-fp8"), ["rtx4090", "rtx5090"]);
assert.equal(validateProductionCandidate({ serverId: "ok", gpu: "RTX 4090", vramGb: 24, ramGb: 64, diskGb: 200, onDemand: true, reliability: 0.99, rating: 5, projectedCostUsd: 2.5, hourlyUsd: 0.7 }).length, 0);
assert.ok(validateProductionCandidate({ serverId: "bad", gpu: "A40", vramGb: 48, ramGb: 128, diskGb: 1000, onDemand: true, reliability: 1, rating: 5, projectedCostUsd: 1, hourlyUsd: 0.4 }).length > 0);
assert.equal(modelAvailabilityGate("ultrareal-flux1-dev-fp8").allowed, true);
assert.equal(modelAvailabilityGate("wan22-remix-14b-i2v-fp8").allowed, true);

assert.equal(validateProductionPrompt("a cinematic portrait").allowed, true);
assert.equal(validateProductionPrompt("explicit nude child").code, "minor_sexual_content");
assert.equal(validateProductionPrompt("forced sex scene").code, "non_consensual_sexual_content");

const restore = text("scripts/clore/restore-production-r2.py");
assert.match(restore, /\.part/);
assert.match(restore, /Range/);
assert.match(restore, /ThreadPoolExecutor/);
assert.match(restore, /sha256/);
assert.match(restore, /os\.replace/);
assert.ok(!text("scripts/clore/production-r2-restore.ts").includes("spawnSync"));
assert.match(buildRemoteRestoreLaunchCommand("ultrareal-flux1-dev-fp8"), /nohup/);
assert.match(buildRemoteRestorePollCommand("wan22-remix-14b-i2v-fp8"), /restore-wan22-remix-14b-i2v-fp8\.json/);
assert.ok(RESTORE_CONTROLLER_POLICY.forbidden.includes("R2 admin credentials on GPU"));

const workflowYaml = text(".github/workflows/production-model-cache.yml");
const parsedWorkflow = YAML.parse(workflowYaml);
assert.deepEqual(Object.keys(parsedWorkflow.jobs), ["source-probes", "inventory", "image-object", "video-object", "publish-image", "publish-video", "final-readonly-verification"]);
assert.equal(parsedWorkflow.jobs["image-object"].needs, "source-probes");
assert.equal(parsedWorkflow.jobs["video-object"].needs, "source-probes");
assert.deepEqual(parsedWorkflow.jobs["publish-image"].needs, ["inventory", "image-object"]);
assert.deepEqual(parsedWorkflow.jobs["publish-video"].needs, ["inventory", "video-object"]);
assert.match(workflowYaml, /timeout-minutes: 75/);
assert.match(workflowYaml, /CIVITAI_API_TOKEN/);
assert.match(workflowYaml, /production-object-stream\.ts stream/);
assert.ok(!workflowYaml.includes("upload-artifact"));
const studio = text("src/components/LocalCreationStudio.tsx");
for (const label of ["Image UltraReal Flux FP8", "Video Wan 2.2 Remix 14B FP8", "自动选择", "RTX 4090", "RTX 5090"]) assert.ok(studio.includes(label));
assert.ok(!studio.toLowerCase().includes("nsfw"));

const stage3w = text("scripts/stage3w-wan-retry-session.ts");
for (const guarantee of ["ffmpeg", "ffprobe", "stage3w-browser.mp4.part", "thumbnail"]) assert.ok(stage3w.includes(guarantee));

console.log(JSON.stringify({ ok: true, auditModels: 2, auditedVersions: 18, productionFamilies: 2, gpuProfiles: 4, credentialGate: "requires_civitai_and_hf" }));
