import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGenerationTask, createNormalJobSet, readGenerationPool, regenerateGenerationTasks, updateGenerationTasks, upsertGenerationTasks } from "../src/lib/generation/task-pool";
import { PRODUCTION_IMAGE_MODEL, PRODUCTION_VIDEO_MODEL } from "../src/lib/generation/production-models";
import { mergeTasksByUpdatedAt, selectGalleryTasks } from "../src/lib/generation/gallery-routing";

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

  assert.equal(selectGalleryTasks(state.tasks, "video").length, 11, "eleven videos occupy eleven independent video cards");
  assert.equal(selectGalleryTasks(state.tasks, "image").length, 0, "no video task enters the image selector");
  const newer: typeof one = { ...one, updatedAt: "2026-07-21T01:00:00.000Z", status: "waiting_for_gpu" };
  const stale: typeof one = { ...one, updatedAt: "2026-07-21T00:00:00.000Z", status: "pending_confirmation" };
  const reconciled = mergeTasksByUpdatedAt([newer], [stale]);
  assert.equal(reconciled[0].status, "waiting_for_gpu", "a stale poll cannot downgrade newer lifecycle state");
  assert.equal(mergeTasksByUpdatedAt([newer], []).length, 1, "a missing stale poll record cannot drop a newer returned task");

  const generatedVideoSets = Array.from({ length: 11 }, (_, index) => createNormalJobSet({ jobForm: "video_from_generated_image", prompt: `rapid enter ${index + 1}`, sizePreset: "low_video_4090" }));
  upsertGenerationTasks(generatedVideoSets.flat(), poolPath);
  state = readGenerationPool(poolPath);
  const generatedVideoCards = selectGalleryTasks(state.tasks, "video").filter((item) => item.prompt.startsWith("rapid enter"));
  const generatedImageCards = selectGalleryTasks(state.tasks, "image").filter((item) => item.prompt.startsWith("rapid enter"));
  assert.equal(generatedVideoCards.length, 11, "rapid generated video submissions must keep all eleven parent cards");
  assert.equal(generatedImageCards.length, 0, "generated first-frame dependencies are not image gallery cards");
  assert.equal(new Set(generatedVideoCards.map((item) => item.id)).size, 11);
  assert.ok(state.tasks.filter((item) => item.galleryParentId).every((item) => item.mediaType === "image"), "only image-model dependencies are hidden beneath their video parent");

  const image = createGenerationTask({ id: "separate-image", generationType: "image", prompt: "independent image", modelProfile: PRODUCTION_IMAGE_MODEL });
  const longSegment = createGenerationTask({ id: "long-segment", generationType: "video", prompt: "long segment", modelProfile: PRODUCTION_VIDEO_MODEL, jobForm: "long_video_segment", longVideoProjectId: "long-parent", longVideoSegmentIndex: 0 });
  upsertGenerationTasks([image, longSegment], poolPath);
  state = readGenerationPool(poolPath);
  assert.equal(selectGalleryTasks(state.tasks, "image").filter((item) => item.id === image.id).length, 1);
  assert.equal(selectGalleryTasks(state.tasks, "video").some((item) => item.id === longSegment.id), false, "expanded long-video segments stay below their parent");
  assert.throws(() => upsertGenerationTasks([createGenerationTask({ id: "task-001", generationType: "image", prompt: "wrong replacement", modelProfile: PRODUCTION_IMAGE_MODEL })], poolPath), /task_media_type_is_immutable/);

  state = updateGenerationTasks(["task-006"], "delete", poolPath);
  assert.equal(state.tasks.length, 34);
  assert.equal(state.tasks.some((item) => item.id === "task-006"), false);
  assert.equal(state.tasks.filter((item) => item.requiredGpuClass === "rtx5090").length, 10);

  const regeneration = regenerateGenerationTasks(["task-005"], poolPath);
  assert.equal(regeneration.regenerated.length, 1);
  assert.equal(regeneration.state.tasks.length, 35, "regeneration must not replace unrelated cards");
  assert.notEqual(regeneration.regenerated[0].id, "task-005");

  const source = readFileSync("src/components/LocalCreationStudio.tsx", "utf8");
  const route = readFileSync("src/app/api/local-lab/generation-pool/route.ts", "utf8");
  assert.match(source, /key=\{`pool-\$\{task\.id\}`\}/);
  assert.match(source, /sequence === poolRefreshSequence\.current/);
  assert.match(source, /selectGalleryTasks\(pool\.tasks, ordinaryMode\)/);
  assert.match(source, /generationType: ordinaryMode/);
  assert.match(source, /onKeyDown=\{\(event\)/);
  assert.match(route, /dynamic = "force-dynamic"/);
  assert.match(route, /cache-control": "no-store, max-age=0"/);
  console.log(JSON.stringify({ ok: true, independentCards: 11, rapidEnterVideoParents: 11, sameQueue: 10, gridWrapCards: 11, hiddenVideoDependencies: 11, refreshPersistence: true, scopedDelete: true, scopedRegenerate: true }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
