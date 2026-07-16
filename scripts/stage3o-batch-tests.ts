import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareStage3OBatch, STAGE3O_BATCH_ID, STAGE3O_TASK_IDS } from "./stage3o-batch";
import { generationPoolSummary } from "../src/lib/generation/task-pool";

const file = path.join(mkdtempSync(path.join(os.tmpdir(), "stage3o-batch-")), "pool.json");
const first = prepareStage3OBatch(file); const second = prepareStage3OBatch(file);
assert.equal(first.state.tasks.length, 2); assert.equal(second.state.tasks.length, 2); assert.equal(second.reused, true); assert.equal(second.chargedOrDebited, false);
assert.equal(second.state.scheduler.selectedBatchId, STAGE3O_BATCH_ID); assert.deepEqual(second.state.scheduler.selectedTaskIds, [...STAGE3O_TASK_IDS]);
const image = second.state.tasks.find((task) => task.generationType === "image")!; const video = second.state.tasks.find((task) => task.generationType === "video")!;
assert.deepEqual({ width: image.outputMetadata.width, height: image.outputMetadata.height, steps: image.outputMetadata.steps, seed: image.outputMetadata.seed }, { width: 1024, height: 1024, steps: 4, seed: 20260715 });
assert.deepEqual({ width: video.outputMetadata.width, height: video.outputMetadata.height, frames: video.outputMetadata.frames, fps: video.outputMetadata.fps, seed: video.outputMetadata.seed }, { width: 1280, height: 704, frames: 41, fps: 16, seed: 20260715 });
assert.deepEqual(generationPoolSummary(second.state).acceptableGpuClasses, ["rtx4090", "rtx5090", "a40", "a6000", "rtx3090", "rtx3090ti"]);
console.log("Stage 3O real task-pool fixture is fixed, armed, and idempotent.");
