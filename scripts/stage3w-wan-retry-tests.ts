import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGenerationTask, readGenerationPool, writeGenerationPool } from "../src/lib/generation/task-pool";
import { STAGE3O_IMAGE_TASK_ID, STAGE3O_VIDEO_TASK_ID } from "./stage3o-batch";
import { prepareStage3WWanRetry, setStage3WRetryStatus, STAGE3W_BATCH_ID, STAGE3W_RETRY_TASK_ID, stage3WTaskSummary, stage3WVerificationState } from "./stage3w-wan-retry";

const dir = mkdtempSync(path.join(os.tmpdir(), "stage3w-retry-")); const file = path.join(dir, "pool.json");
try {
  const createdAt = new Date().toISOString(); const state = readGenerationPool(file);
  state.tasks = [
    createGenerationTask({ id: STAGE3O_IMAGE_TASK_ID, generationType: "image", prompt: "image", modelProfile: "flux2-klein-4b", status: "completed", createdAt, confirmedAt: createdAt, batchId: "stage3o" }),
    createGenerationTask({ id: STAGE3O_VIDEO_TASK_ID, generationType: "video", prompt: "video", modelProfile: "wan22-ti2v-5b", status: "failed", createdAt, confirmedAt: createdAt, batchId: "stage3o", outputMetadata: { errorClass: "historical_failure" } }),
  ]; writeGenerationPool(state, file);
  const first = prepareStage3WWanRetry(file); assert.equal(first.retryTask.status, "armed"); assert.equal(first.retryTask.batchId, STAGE3W_BATCH_ID); assert.deepEqual(first.state.scheduler.selectedTaskIds, [STAGE3W_RETRY_TASK_ID]);
  const second = prepareStage3WWanRetry(file); assert.equal(second.state.tasks.filter((task) => task.id === STAGE3W_RETRY_TASK_ID).length, 1);
  setStage3WRetryStatus("generating", {}, file); setStage3WRetryStatus("failed", { errorClass: "retryable" }, file);
  const rearmed = prepareStage3WWanRetry(file); assert.equal(rearmed.retryTask.status, "armed");
  setStage3WRetryStatus("completed", { outputPath: "output.mp4" }, file);
  const final = readGenerationPool(file); const summary = stage3WTaskSummary(final);
  assert.deepEqual(summary.map((task) => task.status), ["completed", "failed", "completed"]); assert.equal(summary[1].outputMetadata.errorClass, "historical_failure");
  assert.deepEqual(stage3WVerificationState({ wanRemote: true, wanLocal: true }), { flux_inference_verified: true, image_loop_complete: true, wan_remote_inference_verified: true, wan_local_media_verified: true, video_loop_complete: true, gpu_inference_verified: true, production_ready: false, image_preserved: true });
  console.log(JSON.stringify({ stage3w_retry_idempotent: true, original_failure_preserved: true, image_status_preserved: true, session_plan_wan_only: true }, null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
