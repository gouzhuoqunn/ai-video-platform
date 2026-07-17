import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { GpuCandidate } from "./gpu-providers/types";
import { buildRemoteRestoreLaunchCommand, buildRemoteRestorePollCommand, RESTORE_CONTROLLER_POLICY } from "./clore/production-r2-restore";
import { rankStage4CCandidates } from "./stage4c-production-session";

function candidate(input: Partial<GpuCandidate> & Pick<GpuCandidate, "id">): GpuCandidate {
  return {
    id: input.id,
    gpuType: input.gpuType ?? "RTX 4090",
    priority: 0,
    vramGb: input.vramGb ?? 23,
    gpuCount: 1,
    minimumRamGb: input.minimumRamGb ?? 64,
    containerDiskGb: input.containerDiskGb ?? 3000,
    volumeGb: 0,
    hourlyUsd: input.hourlyUsd ?? 0.24,
    reliability: input.reliability ?? 1,
    downloadMbps: input.downloadMbps ?? 100,
    uploadMbps: input.uploadMbps ?? 100,
    interruptible: false,
  };
}

const ranked = rankStage4CCandidates([
  candidate({ id: "other", hourlyUsd: 0.1 }),
  candidate({ id: "105178", minimumRamGb: 48 }),
  candidate({ id: "29167", reliability: 0.99 }),
  candidate({ id: "bad-disk", containerDiskGb: 199 }),
  candidate({ id: "bad-budget", hourlyUsd: 0.7 }),
  candidate({ id: "bad-gpu", gpuType: "RTX 3090" }),
]);
assert.deepEqual(ranked.map((item) => item.id), ["29167", "105178", "other"]);

const launch = buildRemoteRestoreLaunchCommand("ultrareal-flux1-dev-fp8");
assert.match(launch, /nohup setsid -f/);
assert.match(launch, /<\/dev\/null/);
assert.match(launch, /restore-ultrareal-flux1-dev-fp8\.pid/);
assert.doesNotMatch(launch, /R2_|AWS_|credential/i);
assert.match(buildRemoteRestorePollCommand("wan22-remix-14b-i2v-fp8"), /cat \/workspace\/logs\/restore-/);
assert.equal(RESTORE_CONTROLLER_POLICY.forbidden.includes("single blocking synchronous SSH window"), true);

const bundleSource = readFileSync(path.join(process.cwd(), "scripts", "model-cache", "production-restore-bundle.ts"), "utf8");
assert.match(bundleSource, /destinationRoot: "\/workspace\/models"/);
const restoreSource = readFileSync(path.join(process.cwd(), "scripts", "clore", "restore-production-r2.py"), "utf8");
for (const field of ["reusedBytes", "transferredBytes", "durationSeconds", "averageBytesPerSecond", "retries"]) assert.ok(restoreSource.includes(field));
assert.match(restoreSource, /os\.replace\(part, target\)/);
assert.match(restoreSource, /headers\["Range"\]/);

console.log("Stage 4C candidate policy, async direct-R2 restore, workspace model path, resume, and evidence tests passed.");
