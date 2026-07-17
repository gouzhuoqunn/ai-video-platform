import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareStage4AFinalBatch, STAGE4A_BATCH_ID, STAGE4A_IMAGE_TASK_ID, STAGE4A_TASK_IDS, STAGE4A_VIDEO_TASK_ID } from "./stage4a-final-batch";
import { generationPoolSummary } from "../src/lib/generation/task-pool";

const file = path.join(mkdtempSync(path.join(os.tmpdir(), "stage4a-final-batch-")), "pool.json");
const first = prepareStage4AFinalBatch(file);
const second = prepareStage4AFinalBatch(file);
assert.equal(first.prepared, true);
assert.equal(first.paidExecutionAuthorized, false);
assert.equal(second.reused, true);
assert.equal(second.state.tasks.length, 2);
assert.equal(second.state.scheduler.selectedBatchId, STAGE4A_BATCH_ID);
assert.deepEqual(second.state.scheduler.selectedTaskIds, [...STAGE4A_TASK_IDS]);
const image = second.state.tasks.find((task) => task.id === STAGE4A_IMAGE_TASK_ID)!;
const video = second.state.tasks.find((task) => task.id === STAGE4A_VIDEO_TASK_ID)!;
assert.equal(image.modelProfile, "ultrareal-flux1-dev-fp8");
assert.equal(video.modelProfile, "wan22-remix-14b-i2v-fp8");
assert.deepEqual(image.gpuPreference, ["rtx4090", "rtx5090"]);
assert.deepEqual(video.gpuPreference, ["rtx4090", "rtx5090"]);
assert.deepEqual(
  { width: video.outputMetadata.width, height: video.outputMetadata.height, frames: video.outputMetadata.frames, fps: video.outputMetadata.fps },
  { width: 832, height: 480, frames: 33, fps: 16 },
);
assert.equal(video.outputMetadata.inputImageTaskId, STAGE4A_IMAGE_TASK_ID);
assert.equal(video.outputMetadata.unloadImageModelsBeforeLoad, true);
assert.equal(generationPoolSummary(second.state).orderWouldBeCreated, false);
console.log("Stage 4A final production batch is idempotent, unpaid, hold-safe, and image-to-video ordered.");
