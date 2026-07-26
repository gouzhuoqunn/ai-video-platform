import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/local-lab/image-tasks/route";
import { groupImageTasks } from "../src/lib/image-generation/image-task-groups";
import { listImageTasks, mutateImageTasks } from "../src/lib/image-generation/local-image-task-store";

const root = mkdtempSync(path.join(os.tmpdir(), "image-result-groups-"));
process.env.AI_IMAGE_TASK_STORE_PATH = path.join(root, "tasks.json");
process.env.LOCAL_LAB_ENABLED = "true";
process.env.NEXT_PUBLIC_APP_MODE = "local_lab";

function request(body: Record<string, unknown>) {
  return POST(new NextRequest("http://127.0.0.1/api/local-lab/image-tasks", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1", origin: "http://127.0.0.1" }, body: JSON.stringify(body) }));
}

async function main() {
  const source = { action: "create_group", prompt: "夏雨后的中式庭院，水面倒影", referenceImage: null, width: 768, height: 768, steps: 30, cfg: 4, loraStrength: 0.8, sampler: "FlowMatch", requestedCount: 5 };
  const created = await request(source); assert.equal(created.status, 200); const createData = await created.json() as { groupId: string; createdTaskIds: string[] };
  assert.equal(createData.createdTaskIds.length, 5); const initial = listImageTasks(); assert.equal(initial.length, 5); assert.equal(new Set(initial.map((task) => task.groupId)).size, 1); assert.deepEqual(initial.map((task) => task.groupIndex).sort(), [1, 2, 3, 4, 5]); assert.equal(new Set(initial.map((task) => task.seed)).size, 5);
  const invalid = await request({ ...source, requestedCount: 1.5 }); assert.equal(invalid.status, 400); assert.equal(listImageTasks().length, 5);
  mutateImageTasks((tasks) => ({ tasks: tasks.map((task, index) => index < 2 ? { ...task, status: "completed", result: { relativeDir: "fixture", pngSha256: "a".repeat(64), pngBytes: 1, width: 768, height: 768, completedAt: new Date().toISOString() } } : task), value: null }));
  let groups = groupImageTasks(listImageTasks()); assert.equal(groups.length, 1); assert.equal(groups[0].completedCount, 2); assert.equal(groups[0].requestedCount, 5); assert.equal(groups[0].isActive, true);
  const regenerated = await request({ action: "regenerate_group", groupId: createData.groupId, requestedCount: 3 }); assert.equal(regenerated.status, 200); const all = listImageTasks(); assert.equal(all.length, 8); assert.equal(new Set(all.map((task) => task.groupId)).size, 1); assert.deepEqual(all.map((task) => task.groupIndex).sort((a, b) => Number(a) - Number(b)), [1, 2, 3, 4, 5, 6, 7, 8]); assert.ok(all.every((task) => task.groupRequestedCount === 8));
  groups = groupImageTasks(all); assert.equal(groups.length, 1); assert.equal(groups[0].requestedCount, 8); assert.equal(groups[0].isActive, true);
  mutateImageTasks((tasks) => ({ tasks: tasks.map((task) => ({ ...task, status: "completed" })), value: null })); assert.equal(groupImageTasks(listImageTasks())[0].isActive, false);
  const legacy = { ...all[0], id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", groupId: undefined, groupIndex: undefined, groupRequestedCount: undefined, status: "completed" as const };
  assert.equal(groupImageTasks([legacy]).length, 1);
  console.log("image-result-groups-tests: ok");
}

main().finally(() => rmSync(root, { recursive: true, force: true }));
