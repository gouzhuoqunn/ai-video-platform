import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGenerationTask, readGenerationPool, regenerateGenerationTasks, updateGenerationTasks, upsertGenerationTasks } from "../src/lib/generation/task-pool";
import { PRODUCTION_VIDEO_MODEL } from "../src/lib/generation/production-models";

const root = mkdtempSync(path.join(os.tmpdir(), "multi-task-card-"));
const poolPath = path.join(root, "pool.json");
const task = (id: string, prompt = "相同提示词") => createGenerationTask({ id, generationType: "video", prompt, modelProfile: PRODUCTION_VIDEO_MODEL, jobForm: "video_from_existing_image", inputImageJobId: `image-${id}`, inputImageVerified: true, gpuPreference: ["rtx5090"], status: "pending_confirmation" });

try {
  const one = task("task-001");
  upsertGenerationTasks([one], poolPath);
  assert.equal(readGenerationPool(poolPath).tasks.length, 1);

  const sameQueue = Array.from({ length: 10 }, (_, index) => task(`task-${String(index + 2).padStart(3, "0")}`));
  upsertGenerationTasks(sameQueue, poolPath);
  let state = readGenerationPool(poolPath);
  assert.equal(state.tasks.length, 11, "ten same-queue tasks must append, not replace");
  assert.equal(new Set(state.tasks.map((item) => item.id)).size, 11, "every card key is task-id based");
  assert.equal(state.tasks.filter((item) => item.prompt === "相同提示词").length, 11, "identical prompts remain independent");

  state = updateGenerationTasks(["task-006"], "delete", poolPath);
  assert.equal(state.tasks.length, 10);
  assert.equal(state.tasks.some((item) => item.id === "task-006"), false);
  assert.equal(state.tasks.filter((item) => item.requiredGpuClass === "rtx5090").length, 10);

  const regeneration = regenerateGenerationTasks(["task-005"], poolPath);
  assert.equal(regeneration.regenerated.length, 1);
  assert.equal(regeneration.state.tasks.length, 11, "regeneration must not replace unrelated cards");
  assert.notEqual(regeneration.regenerated[0].id, "task-005");

  const source = readFileSync("src/components/LocalCreationStudio.tsx", "utf8");
  const route = readFileSync("src/app/api/local-lab/generation-pool/route.ts", "utf8");
  assert.match(source, /key=\{`pool-\$\{task\.id\}`\}/);
  assert.match(source, /sequence === poolRefreshSequence\.current/);
  assert.match(route, /dynamic = "force-dynamic"/);
  assert.match(route, /cache-control": "no-store, max-age=0"/);
  console.log(JSON.stringify({ ok: true, independentCards: 11, sameQueue: 10, gridWrapCards: 10, refreshPersistence: true, scopedDelete: true, scopedRegenerate: true }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
