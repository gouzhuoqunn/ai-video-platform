import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { claimImageTask, readImageTask } from "../../src/lib/image-generation/local-image-task-store";
import { persistAndFinalizeExactLocalTask, resolveExactEligibleImageTask, startImageTaskLeaseHeartbeat } from "./run-image-e2e";

const taskId = "723e4567-e89b-42d3-a456-426614174000";
async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "image-e2e-"));
  try {
    const taskPath = path.join(root, "tasks.json"); const options = { taskPath, artifactRoot: path.join(root, "library") };
    const task = { id: taskId, status: "waiting_for_gpu", mode: "text_generation", referenceImage: null, prompt: "fixture", width: 768, height: 768, steps: 25, cfg: 4, loraStrength: .8, seed: 1, sampler: "Euler", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 0 };
    writeFileSync(taskPath, JSON.stringify([task]), "utf8");
    // Runtime/model preflight reads eligibility without claiming it.
    const eligible = resolveExactEligibleImageTask(taskId, options);
    assert.equal(eligible.status, "waiting_for_gpu");
    assert.equal(readImageTask(taskId, options)?.status, "waiting_for_gpu");
    const claim = claimImageTask(taskId, "coordinator-fixture", 60_000, options);
    const heartbeat = startImageTaskLeaseHeartbeat({ taskId, claimToken: claim.claimToken, leaseMs: 60_000, options });
    const png = await sharp({ create: { width: 768, height: 768, channels: 3, background: "#2e6" } }).png().toBuffer();
    const result = await persistAndFinalizeExactLocalTask({ task: eligible, claimToken: claim.claimToken, png, remote: { generationDurationSeconds: 1, orderId: "fixture", gpuModel: "RTX 4090", controllerPromptId: null }, options });
    heartbeat.assertHealthy(); heartbeat.stop();
    assert.equal(result.completed.status, "completed");
    assert.equal(readImageTask(taskId, options)?.result?.pngSha256, result.artifact.pngSha256);
    console.log(JSON.stringify({ ok: true, preflight_does_not_claim: true, local_lease_heartbeat: true, persistence_and_exact_finalization: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
void main();
