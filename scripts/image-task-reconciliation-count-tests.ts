import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { selectStudioExecutableBatch } from "../src/lib/image-generation/image-task-groups";
import { publishLocalImageArtifact } from "../src/lib/image-generation/local-image-artifacts";
import { mutateImageTasks, readImageTask, recoverCompletedImageTaskFromVerifiedArtifact, type LocalImageTask } from "../src/lib/image-generation/local-image-task-store";
import { planExecutableImageBatch } from "./clore/image-session";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const task = (value: number, patch: Partial<LocalImageTask> = {}): LocalImageTask => ({ id: id(value), status: "waiting_for_gpu", mode: "text_generation", referenceImage: null, prompt: `fixture-${value}`, width: 768, height: 768, steps: 30, cfg: 4, loraStrength: .8, seed: value, sampler: "Euler", gpuClass: "rtx4090", createdAt: `2026-07-26T00:0${value}:00.000Z`, updatedAt: "2026-07-26T00:00:00.000Z", attempts: 2, ...patch });

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "image-task-reconcile-"));
  try {
    const taskPath = path.join(root, "tasks.json"); const artifactRoot = path.join(root, "artifacts");
    const png = await sharp({ create: { width: 768, height: 768, channels: 3, background: "#335577" } }).png().toBuffer();
    const artifact = await publishLocalImageArtifact({ task: task(1), png, remote: { generationDurationSeconds: 1, orderId: "sanitized", gpuModel: "RTX 4090", controllerPromptId: null }, root: artifactRoot });
    const original = task(1, { result: artifact, finalizedClaimTokenHash: "f".repeat(64), localClaim: { workerId: "stale", claimedAt: "2026-07-26T00:00:00.000Z", leaseExpiresAt: "2026-07-26T00:01:00.000Z", claimTokenHash: "a".repeat(64) }, error: { message: "stale" } });
    mutateImageTasks(() => ({ tasks: [original], value: null }), { taskPath, artifactRoot });
    const restored = await recoverCompletedImageTaskFromVerifiedArtifact(original.id, { taskPath, artifactRoot });
    assert.equal(restored.status, "completed"); assert.deepEqual(restored.result, artifact); assert.equal(restored.attempts, original.attempts); assert.equal(restored.updatedAt, original.updatedAt); assert.equal(restored.localClaim, undefined); assert.equal(restored.error, undefined);

    const invalid = task(2, { result: { ...artifact, relativeDir: `2026-07-26/${id(2)}` }, finalizedClaimTokenHash: "e".repeat(64) });
    mutateImageTasks(() => ({ tasks: [restored, invalid], value: null }), { taskPath, artifactRoot });
    await assert.rejects(() => recoverCompletedImageTaskFromVerifiedArtifact(invalid.id, { taskPath, artifactRoot }), /local_artifact_incomplete|verification/);
    assert.equal(readImageTask(invalid.id, { taskPath })?.status, "waiting_for_gpu");

    const executable = [task(6), task(5), task(4), task(3), restored];
    const batch = planExecutableImageBatch(executable, "rtx4090");
    assert.equal(batch.executableCount, 4); assert.deepEqual(batch.plannedTaskIds, [id(3), id(4), id(5), id(6)]); assert.equal(batch.excludedInconsistentTaskIds.length, 0);

    const oldWaiting = Array.from({ length: 10 }, (_, index) => task(index + 10, {
      groupId: `old-group-${index}`,
      createdAt: `2026-07-25T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const selectedGroupId = "new-selected-group";
    const selectedWaiting = Array.from({ length: 5 }, (_, index) => task(index + 30, {
      groupId: selectedGroupId,
      groupIndex: index + 1,
      groupRequestedCount: 5,
      createdAt: "2026-07-29T00:00:00.000Z",
    }));
    const fullQueue = [...selectedWaiting, ...oldWaiting];
    const globalBatch = planExecutableImageBatch(fullQueue, "rtx4090");
    assert.equal(globalBatch.plannedTaskIds.some((taskId) => selectedWaiting.some((item) => item.id === taskId)), false, "the historical global planner demonstrates the old-queue conflict");
    const explicitBatch = selectStudioExecutableBatch(fullQueue, new Set([selectedGroupId]), "rtx4090", globalBatch);
    assert.deepEqual(explicitBatch.plannedTaskIds, selectedWaiting.map((item) => item.id), "the explicitly selected new group must replace the old global queue");
    assert.equal(explicitBatch.executableCount, 5);
    assert.deepEqual(selectStudioExecutableBatch(fullQueue, new Set(), "rtx4090", globalBatch), globalBatch, "only an empty selection may use the global fallback");
    const selectedPending = selectedWaiting.map((item) => ({ ...item, status: "pending_confirmation" as const }));
    assert.deepEqual(
      selectStudioExecutableBatch([...selectedPending, ...oldWaiting], new Set([selectedGroupId]), "rtx4090", globalBatch).plannedTaskIds,
      [],
      "an explicit pending selection must disable paid start instead of falling through to old tasks",
    );
    assert.deepEqual(
      selectStudioExecutableBatch(fullQueue, new Set(["stale-cancelled-group"]), "rtx4090", globalBatch).plannedTaskIds,
      [],
      "a stale nonempty selection must remain fail-closed",
    );
    assert.deepEqual(
      selectStudioExecutableBatch(fullQueue, new Set([selectedGroupId]), "rtx4090", {
        ...globalBatch,
        excludedInconsistentTaskIds: [selectedWaiting[0].id],
      }).plannedTaskIds,
      selectedWaiting.slice(1).map((item) => item.id),
      "the selected batch must retain the server-projected inconsistency exclusions",
    );

    const route = readFileSync("src/app/api/local-lab/image-tasks/route.ts", "utf8"); const studio = readFileSync("src/components/ImageCreationStudio.tsx", "utf8");
    assert.match(route, /executableBatches:/); assert.match(route, /planExecutableImageBatch\(tasks, "rtx4090"\)/); assert.match(studio, /effectiveBatches\[gpu\]\.plannedTaskIds/); assert.match(studio, /batches\.rtx4090\.executableCount/);
    console.log(JSON.stringify({ ok: true, verifiedWaitingResultRestored: true, artifactAndHistoryPreserved: true, invalidArtifactRemainsExcluded: true, selectedConfirmedGroupPrecedesOldWaiting: true, explicitSelectionNeverFallsBack: true, rtx4090ExecutableCount: batch.executableCount, providerMutationCount: 0 }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

void main();
