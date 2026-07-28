import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/local-lab/image-tasks/route";
import { groupImageTasks } from "../src/lib/image-generation/image-task-groups";
import { listImageTasks, mutateImageTasks } from "../src/lib/image-generation/local-image-task-store";

const root = mkdtempSync(path.join(os.tmpdir(), "image-result-groups-"));
process.env.AI_IMAGE_TASK_STORE_PATH = path.join(root, "tasks.json");
process.env.AI_IMAGE_LIBRARY_ROOT = path.join(root, "images");
process.env.LOCAL_LAB_ENABLED = "true";
process.env.NEXT_PUBLIC_APP_MODE = "local_lab";

function request(body: Record<string, unknown>) {
  return POST(new NextRequest("http://127.0.0.1/api/local-lab/image-tasks", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1", origin: "http://127.0.0.1" }, body: JSON.stringify(body) }));
}

const source = { action: "create_group", prompt: "夏雨后的中式庭院，水面倒影", referenceImage: null, width: 768, height: 768, steps: 30, cfg: 4, loraStrength: 0.8, sampler: "FlowMatch", requestedCount: 5 };

async function createGroup(requestedCount = 3) {
  const response = await request({ ...source, requestedCount });
  assert.equal(response.status, 200);
  return await response.json() as { groupId: string; createdTaskIds: string[] };
}

async function main() {
  const created = await createGroup(5);
  assert.equal(created.createdTaskIds.length, 5);
  let groups = groupImageTasks(listImageTasks());
  assert.equal(groups[0].pendingConfirmationCount, 5);
  assert.equal(groups[0].waitingForGpuCount, 0);
  assert.equal(groups[0].status, "pending_confirmation");

  const confirmed = await request({ action: "confirm_group", groupId: created.groupId });
  assert.equal(confirmed.status, 200);
  assert.equal(listImageTasks().filter((task) => task.groupId === created.groupId && task.status === "waiting_for_gpu").length, 5);

  const cancelable = await createGroup(2);
  assert.equal((await request({ action: "cancel_group", groupId: cancelable.groupId })).status, 200);
  assert.equal(listImageTasks().filter((task) => task.groupId === cancelable.groupId).length, 0);

  const retryable = await createGroup(2);
  const retrySessionId = "123e4567-e89b-42d3-a456-426614174000";
  const retryStageRunId = "223e4567-e89b-42d3-a456-426614174000";
  const retryMembers = listImageTasks().filter((task) => task.groupId === retryable.groupId);
  const blockedRetryId = retryMembers[0].id;
  mutateImageTasks((tasks) => ({ tasks: tasks.map((task) => {
    if (task.groupId !== retryable.groupId) return task;
    if (task.id !== blockedRetryId) return { ...task, status: "failed", attempts: 2, error: { message: "fixture", retryable: true } };
    return {
      ...task,
      status: "failed",
      attempts: 2,
      error: { message: "accepted ambiguity", retryable: false },
      inferenceRetryBlock: {
        schemaVersion: 1,
        reason: "inference_submission_may_have_been_accepted",
        sessionId: retrySessionId,
        stageRunId: retryStageRunId,
        inferenceState: "accepted",
        recordedAt: "2026-07-28T10:00:00.000Z",
      },
    };
  }), value: null }));
  const blockedRetryBefore = structuredClone(listImageTasks().find((task) => task.id === blockedRetryId));
  assert.equal((await request({ action: "retry_failed_group", groupId: retryable.groupId })).status, 200);
  const retryAfter = listImageTasks().filter((task) => task.groupId === retryable.groupId);
  assert.deepEqual(retryAfter.find((task) => task.id === blockedRetryId), blockedRetryBefore);
  assert.ok(retryAfter.filter((task) => task.id !== blockedRetryId).every((task) => task.status === "pending_confirmation" && Number(task.attempts) === 3));
  const allBlockedRetry = await createGroup(1);
  mutateImageTasks((tasks) => ({ tasks: tasks.map((task) => task.groupId === allBlockedRetry.groupId ? {
    ...task,
    status: "failed",
    error: { message: "accepted ambiguity", retryable: false },
    inferenceRetryBlock: {
      schemaVersion: 1,
      reason: "inference_submission_may_have_been_accepted",
      sessionId: retrySessionId,
      stageRunId: retryStageRunId,
      inferenceState: "accepted",
      recordedAt: "2026-07-28T10:00:00.000Z",
    },
  } : task), value: null }));
  const allBlockedBefore = structuredClone(listImageTasks().find((task) => task.groupId === allBlockedRetry.groupId));
  const allBlockedResponse = await request({ action: "retry_failed_group", groupId: allBlockedRetry.groupId });
  assert.equal(allBlockedResponse.status, 400);
  assert.match(String((await allBlockedResponse.json() as { error?: unknown }).error), /禁止自动重试/);
  assert.deepEqual(listImageTasks().find((task) => task.groupId === allBlockedRetry.groupId), allBlockedBefore);

  const unrelatedSingleAction = await createGroup(1);
  const unrelatedSingleTaskId = unrelatedSingleAction.createdTaskIds[0];
  const guardedTaskBeforeUnrelatedAction = structuredClone(listImageTasks().find((task) => task.id === blockedRetryId));
  assert.equal((await request({ action: "confirm", id: unrelatedSingleTaskId })).status, 200);
  assert.equal(listImageTasks().find((task) => task.id === unrelatedSingleTaskId)?.status, "waiting_for_gpu");
  assert.deepEqual(
    listImageTasks().find((task) => task.id === blockedRetryId),
    guardedTaskBeforeUnrelatedAction,
    "an unrelated legacy action cannot erase a concurrently persisted inference tombstone",
  );
  assert.equal((await request({ action: "delete", id: blockedRetryId })).status, 400);
  assert.deepEqual(listImageTasks().find((task) => task.id === blockedRetryId), guardedTaskBeforeUnrelatedAction);

  let sourceMemberIndex = 0;
  mutateImageTasks((tasks) => ({ tasks: tasks.map((task) => {
    if (task.groupId !== created.groupId) return task;
    const index = sourceMemberIndex++;
    return index === 0 ? { ...task, status: "completed", result: { relativeDir: "fixture", pngSha256: "a".repeat(64), pngBytes: 1, width: 768, height: 768, completedAt: new Date().toISOString() } } : index === 1 ? { ...task, status: "generating", localClaim: { workerId: "fixture" } } : { ...task, status: "pending_confirmation" };
  }), value: null }));
  const cancellation = await request({ action: "cancel_group", groupId: created.groupId });
  assert.equal(cancellation.status, 200);
  await cancellation.json();
  const protectedTasks = listImageTasks().filter((task) => task.groupId === created.groupId);
  assert.deepEqual(protectedTasks.map((task) => task.status).sort(), ["completed", "generating"]);
  assert.equal((await request({ action: "cancel_group", groupId: created.groupId })).status, 400);

  const completedBeforeRegeneration = structuredClone(protectedTasks.find((task) => task.status === "completed"));
  assert.ok(completedBeforeRegeneration);
  for (const action of ["confirm", "retry", "delete"] as const) {
    assert.equal((await request({ action, id: completedBeforeRegeneration.id })).status, 400);
    assert.deepEqual(
      listImageTasks().find((task) => task.id === completedBeforeRegeneration.id),
      completedBeforeRegeneration,
      `legacy ${action} cannot downgrade or delete a completed artifact`,
    );
  }
  const editedPrompt = "  雨后庭院增加一盏暖色纸灯笼  ";
  const regenerated = await request({ action: "regenerate_group", groupId: created.groupId, requestedCount: 3, prompt: editedPrompt });
  assert.equal(regenerated.status, 200);
  const regeneratedPayload = await regenerated.json() as { createdTaskIds: string[] };
  const regeneratedTasks = listImageTasks().filter((task) => task.groupId === created.groupId);
  const regeneratedChildren = regeneratedTasks.filter((task) => regeneratedPayload.createdTaskIds.includes(task.id));
  assert.equal(regeneratedChildren.length, 3);
  assert.ok(regeneratedChildren.every((task) =>
    task.status === "pending_confirmation"
    && task.prompt === editedPrompt.trim()
    && task.width === completedBeforeRegeneration.width
    && task.height === completedBeforeRegeneration.height
    && task.steps === completedBeforeRegeneration.steps
    && task.cfg === completedBeforeRegeneration.cfg
    && task.loraStrength === completedBeforeRegeneration.loraStrength
    && task.sampler === completedBeforeRegeneration.sampler
  ));
  assert.equal(regeneratedTasks.filter((task) => task.status === "completed").length, 1);
  assert.deepEqual(regeneratedTasks.find((task) => task.id === completedBeforeRegeneration.id), completedBeforeRegeneration);
  groups = groupImageTasks(regeneratedTasks);
  assert.equal(groups[0].requestedCount, 8);
  assert.equal(groups[0].isActive, true);
  const storeBeforeInvalidRegeneration = structuredClone(listImageTasks());
  assert.equal((await request({ action: "regenerate_group", groupId: created.groupId, requestedCount: 1, prompt: "   " })).status, 400);
  assert.deepEqual(listImageTasks(), storeBeforeInvalidRegeneration);
  assert.equal((await request({ action: "regenerate_group", groupId: created.groupId, requestedCount: 1, prompt: "x".repeat(4_001) })).status, 400);
  assert.deepEqual(listImageTasks(), storeBeforeInvalidRegeneration);
  assert.equal((await request({ action: "regenerate_group", groupId: created.groupId, requestedCount: 1 })).status, 400);
  assert.deepEqual(listImageTasks(), storeBeforeInvalidRegeneration);

  const legacy = (await createGroup(1)).createdTaskIds[0];
  mutateImageTasks((tasks) => ({ tasks: tasks.map((task) => task.id === legacy ? { ...task, groupId: undefined, groupIndex: undefined, groupRequestedCount: undefined, groupTitle: undefined } : task), value: null }));
  assert.equal((await request({ action: "confirm_group", groupId: legacy })).status, 200);
  assert.equal(listImageTasks().find((task) => task.id === legacy)?.status, "waiting_for_gpu");

  const rtx5090 = await request({ ...source, width: 1536, height: 1536, requestedCount: 1 });
  assert.equal(rtx5090.status, 200);
  const rtx5090Payload = await rtx5090.json() as { createdTaskIds: string[] };
  assert.equal(rtx5090Payload.createdTaskIds.length, 1);
  const rtx5090Task = listImageTasks().find((task) => task.id === rtx5090Payload.createdTaskIds[0]);
  assert.equal(rtx5090Task?.gpuClass, "rtx5090");
  assert.equal(rtx5090Task?.status, "pending_confirmation");
  const tooLarge = await request({ ...source, width: 1792, height: 1024, requestedCount: 1 });
  assert.equal(tooLarge.status, 400);
  assert.match(String((await tooLarge.json() as { error?: unknown }).error), /1536/);
  const nonGrid = await request({ ...source, width: 1537, height: 1024, requestedCount: 1 });
  assert.equal(nonGrid.status, 400);
  assert.match(String((await nonGrid.json() as { error?: unknown }).error), /256/);
  const status = await GET(new NextRequest("http://127.0.0.1/api/local-lab/image-tasks", { headers: { host: "127.0.0.1" } }));
  assert.equal(status.status, 200);
  const statusPayload = await status.json() as { localProgram?: { cpuLogicalCores?: number; totalRamBytes?: number; availableRamBytes?: number; processMemoryBytes?: number; taskStoreAvailable?: boolean } };
  assert.ok((statusPayload.localProgram?.cpuLogicalCores ?? 0) > 0);
  assert.ok((statusPayload.localProgram?.totalRamBytes ?? 0) > 0);
  assert.ok((statusPayload.localProgram?.availableRamBytes ?? 0) > 0);
  assert.ok((statusPayload.localProgram?.processMemoryBytes ?? 0) > 0);
  assert.equal(statusPayload.localProgram?.taskStoreAvailable, true);
  console.log("image-result-groups-tests: ok");
}

main().finally(() => rmSync(root, { recursive: true, force: true }));
