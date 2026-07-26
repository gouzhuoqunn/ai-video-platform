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
  mutateImageTasks((tasks) => ({ tasks: tasks.map((task) => task.groupId === retryable.groupId ? { ...task, status: "failed", attempts: 2, error: { message: "fixture" } } : task), value: null }));
  assert.equal((await request({ action: "retry_failed_group", groupId: retryable.groupId })).status, 200);
  assert.ok(listImageTasks().filter((task) => task.groupId === retryable.groupId).every((task) => task.status === "pending_confirmation" && Number(task.attempts) === 3));

  let sourceMemberIndex = 0;
  mutateImageTasks((tasks) => ({ tasks: tasks.map((task) => {
    if (task.groupId !== created.groupId) return task;
    const index = sourceMemberIndex++;
    return index === 0 ? { ...task, status: "completed", result: { relativeDir: "fixture", pngSha256: "a".repeat(64), pngBytes: 1, width: 768, height: 768, completedAt: new Date().toISOString() } } : index === 1 ? { ...task, status: "generating", localClaim: { workerId: "fixture" } } : { ...task, status: "failed" };
  }), value: null }));
  const cancellation = await request({ action: "cancel_group", groupId: created.groupId });
  assert.equal(cancellation.status, 200);
  const cancellationPayload = await cancellation.json() as { groupAction?: { blocker?: string } };
  assert.match(cancellationPayload.groupAction?.blocker ?? "", /正在生成/);
  const protectedTasks = listImageTasks().filter((task) => task.groupId === created.groupId);
  assert.deepEqual(protectedTasks.map((task) => task.status).sort(), ["completed", "generating"]);
  assert.equal((await request({ action: "cancel_group", groupId: created.groupId })).status, 400);

  const regenerated = await request({ action: "regenerate_group", groupId: created.groupId, requestedCount: 3 });
  assert.equal(regenerated.status, 200);
  const regeneratedTasks = listImageTasks().filter((task) => task.groupId === created.groupId);
  assert.equal(regeneratedTasks.filter((task) => task.status === "pending_confirmation").length, 3);
  assert.equal(regeneratedTasks.filter((task) => task.status === "completed").length, 1);
  groups = groupImageTasks(regeneratedTasks);
  assert.equal(groups[0].requestedCount, 8);
  assert.equal(groups[0].isActive, true);

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
