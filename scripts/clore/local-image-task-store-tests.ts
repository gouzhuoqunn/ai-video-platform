import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { localArtifactFile, publishLocalImageArtifact } from "../../src/lib/image-generation/local-image-artifacts";
import { claimImageTask, failImageTask, finalizeImageTask, listImageTasks, mutateImageTasks, readImageTask, releaseOrRecoverExpiredClaim, renewImageTaskLease } from "../../src/lib/image-generation/local-image-task-store";
import { persistAndFinalizeExactLocalTask, resolveExactEligibleImageTask } from "./run-image-e2e";

const id = "123e4567-e89b-42d3-a456-426614174000";
const failedId = "223e4567-e89b-42d3-a456-426614174000";
const completionId = "323e4567-e89b-42d3-a456-426614174000";
function task(taskId: string) { return { id: taskId, status: "waiting_for_gpu", mode: "text_generation", referenceImage: null, prompt: "fixture", width: 768, height: 768, steps: 25, cfg: 4, loraStrength: .8, seed: 1, sampler: "Euler", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 0 }; }
function child(file: string, worker: string) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const childProcess = spawn(process.execPath, [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), path.join(process.cwd(), "scripts", "clore", "local-image-task-claim-child.ts"), file, id, worker], { windowsHide: true });
    let output = ""; childProcess.stdout.on("data", (chunk) => { output += String(chunk); }); childProcess.on("close", (code) => resolve({ code, output }));
  });
}

async function main() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "local-image-store-"));
  const taskPath = path.join(dir, "tasks.json"); const artifactRoot = path.join(dir, "library"); const options = { taskPath, artifactRoot };
  try {
    writeFileSync(taskPath, `${JSON.stringify([task(id), task(failedId), task(completionId)], null, 2)}\n`, "utf8");
    // A stale interrupted temporary write can never replace the valid primary JSON.
    writeFileSync(`${taskPath}.interrupted.tmp`, "{broken", "utf8");
    assert.equal(listImageTasks(options).length, 3);
    assert.equal(JSON.parse(readFileSync(taskPath, "utf8")).length, 3);

    const [one, two] = await Promise.all([child(taskPath, "worker-a"), child(taskPath, "worker-b")]);
    assert.equal([one, two].filter((result) => result.code === 0).length, 1, "exactly one process claims a task");
    const active = readImageTask(id, options)!;
    assert.equal(active.status, "generating");
    assert.throws(() => renewImageTaskLease(id, "wrong", 60_000, options), /not_owned/);
    assert.throws(() => failImageTask(id, "wrong", "fixture", options), /not_owned/);
    assert.throws(() => claimImageTask(id, "worker-c", 60_000, options), /not_claimable/);
    mutateImageTasks((tasks) => { const current = tasks.find((entry) => entry.id === id)!; current.localClaim!.leaseExpiresAt = new Date(Date.now() - 1).toISOString(); return { tasks, value: null }; }, options);
    assert.equal(releaseOrRecoverExpiredClaim(id, options).status, "waiting_for_gpu");

    // Model/runtime preflight failure occurs before claim and leaves the task untouched.
    assert.equal(resolveExactEligibleImageTask(id, options).status, "waiting_for_gpu");
    const failedClaim = claimImageTask(failedId, "worker-failed", 60_000, options);
    assert.equal(failImageTask(failedId, failedClaim.claimToken, "controller_fixture_failure", options).status, "failed");

    const png = await sharp({ create: { width: 768, height: 768, channels: 3, background: "#2e6" } }).png().toBuffer();
    const completing = resolveExactEligibleImageTask(completionId, options);
    const claim = claimImageTask(completionId, "worker-complete", 60_000, options);
    const artifact = await publishLocalImageArtifact({ task: completing as never, png, remote: { generationDurationSeconds: 1.2, orderId: "fixture-order", gpuModel: "RTX 4090", controllerPromptId: "prompt-1" }, root: artifactRoot });
    await assert.rejects(() => finalizeImageTask(completionId, "wrong", artifact, options), /not_owned/);
    const completed = await finalizeImageTask(completionId, claim.claimToken, artifact, options);
    assert.equal(completed.status, "completed");
    assert.equal((await finalizeImageTask(completionId, claim.claimToken, artifact, options)).status, "completed", "identical finalization is idempotent");
    await assert.rejects(() => finalizeImageTask(completionId, claim.claimToken, { ...artifact, pngSha256: "0".repeat(64) }, options), /verification_failed|conflict/);
    assert.throws(() => claimImageTask(completionId, "worker-second", 60_000, options), /not_claimable/);
    assert.throws(() => localArtifactFile({ taskId: completionId, artifact: { ...artifact, relativeDir: `../../${completionId}` }, kind: "output", root: artifactRoot }), /invalid_local_artifact_reference/);

    const retryId = "523e4567-e89b-42d3-a456-426614174000";
    mutateImageTasks((tasks) => ({ tasks: [...tasks, task(retryId) as never], value: null }), options);
    const retryTask = resolveExactEligibleImageTask(retryId, options); const retryClaim = claimImageTask(retryId, "worker-retry", 60_000, options);
    const persisted = await persistAndFinalizeExactLocalTask({ task: retryTask, claimToken: retryClaim.claimToken, png, remote: { generationDurationSeconds: 1, orderId: "fixture", gpuModel: "RTX 4090", controllerPromptId: null }, options });
    assert.equal(persisted.completed.status, "completed");
    assert.equal(readImageTask(retryId, options)?.result?.pngSha256, persisted.artifact.pngSha256);
    console.log(JSON.stringify({ ok: true, atomic_single_claim: true, token_checks: true, expired_claim_recovery: true, atomic_json: true, artifact_finalization: true, no_second_order_for_completed_task: true }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

void main();
