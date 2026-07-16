import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createGenerationTask, readGenerationPool, writeGenerationPool, type GenerationPoolState, type GenerationTaskStatus } from "../src/lib/generation/task-pool";
import { STAGE3O_IMAGE_TASK_ID, STAGE3O_VIDEO_TASK_ID } from "./stage3o-batch";

export const STAGE3W_BATCH_ID = "stage3w-wan-retry";
export const STAGE3W_RETRY_TASK_ID = "stage3o-video-wan-20260715-retry-1";
export const STAGE3W_IMAGE_PATH = "D:\\AI-Creative-Library\\2026-07-16\\stage3o-image-flux-20260715\\output.png";
export const STAGE3W_IMAGE_SHA256 = "989b436c8c0166793d12b58c7f0e6f70c81dbdc1b7cd847b12aa475ed010de81";

function now() { return new Date().toISOString(); }

export function verifyStage3WImagePreserved(imagePath = STAGE3W_IMAGE_PATH) {
  if (!existsSync(imagePath)) throw new Error("stage3w_completed_image_missing");
  const bytes = readFileSync(imagePath); const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== STAGE3W_IMAGE_SHA256 || bytes.length !== 1_664_899) throw new Error("stage3w_completed_image_changed");
  return { image_preserved: true, path: imagePath, size_bytes: bytes.length, sha256, mtime_ms: statSync(imagePath).mtimeMs };
}

export function prepareStage3WWanRetry(filePath?: string) {
  const state = readGenerationPool(filePath);
  const image = state.tasks.find((task) => task.id === STAGE3O_IMAGE_TASK_ID);
  const original = state.tasks.find((task) => task.id === STAGE3O_VIDEO_TASK_ID);
  if (image?.status !== "completed") throw new Error("stage3w_image_task_must_remain_completed");
  if (original?.status !== "failed") throw new Error("stage3w_original_video_failure_history_missing");
  const existingRetry = state.tasks.find((task) => task.id === STAGE3W_RETRY_TASK_ID);
  let retry = existingRetry;
  if (!retry) {
    const createdAt = now();
    retry = createGenerationTask({ ...original, id: STAGE3W_RETRY_TASK_ID, status: "armed", priority: "immediate", batchId: STAGE3W_BATCH_ID, createdAt, confirmedAt: createdAt, outputMetadata: { ...original.outputMetadata, retryOf: STAGE3O_VIDEO_TASK_ID, retryAttempt: 1, stage: "3W", imagePreserved: true } });
    state.tasks.push(retry);
  }
  if (retry.status !== "completed") {
    retry = { ...retry, status: "armed", priority: "immediate", batchId: STAGE3W_BATCH_ID, confirmedAt: retry.confirmedAt ?? now(), outputMetadata: { ...retry.outputMetadata, retryOf: STAGE3O_VIDEO_TASK_ID, retryAttempt: 1, stage: "3W", imagePreserved: true } };
    state.tasks = state.tasks.map((task) => task.id === STAGE3W_RETRY_TASK_ID ? retry! : task);
    state.scheduler = { ...state.scheduler, state: "batch_ready", selectedBatchId: STAGE3W_BATCH_ID, selectedTaskIds: [STAGE3W_RETRY_TASK_ID], selectedServerId: null, orderCreationAttempted: false, drainingRequested: false, watchStartedAt: state.scheduler.watchStartedAt ?? now() };
  }
  const saved = writeGenerationPool(state, filePath);
  return { state: saved, retryTask: saved.tasks.find((task) => task.id === STAGE3W_RETRY_TASK_ID)!, reused: Boolean(existingRetry), completed: retry.status === "completed", sessionPlan: ["Wan restore", "Wan inference", "persistent WebM sync", "MP4 and thumbnail", "cleanup"], imagePreserved: true };
}

export function setStage3WRetryStatus(status: GenerationTaskStatus, outputMetadata: Record<string, string | number | boolean | null> = {}, filePath?: string) {
  const state = readGenerationPool(filePath);
  const retry = state.tasks.find((task) => task.id === STAGE3W_RETRY_TASK_ID);
  if (!retry) throw new Error("stage3w_retry_task_missing");
  const image = state.tasks.find((task) => task.id === STAGE3O_IMAGE_TASK_ID); const original = state.tasks.find((task) => task.id === STAGE3O_VIDEO_TASK_ID);
  if (image?.status !== "completed" || original?.status !== "failed") throw new Error("stage3w_history_mutated");
  state.tasks = state.tasks.map((task) => task.id === STAGE3W_RETRY_TASK_ID ? { ...task, status, outputMetadata: { ...task.outputMetadata, ...outputMetadata, retryOf: STAGE3O_VIDEO_TASK_ID, imagePreserved: true } } : task);
  if (status === "completed") state.scheduler = { ...state.scheduler, state: "completed" };
  return writeGenerationPool(state, filePath);
}

export function stage3WVideoJobDir(libraryDir = "D:\\AI-Video-Library", date = new Date().toISOString().slice(0, 10)) {
  return path.join(libraryDir, date, STAGE3O_VIDEO_TASK_ID);
}

export function stage3WVerificationState(input: { wanRemote: boolean; wanLocal: boolean }) {
  return { flux_inference_verified: true, image_loop_complete: true, wan_remote_inference_verified: input.wanRemote, wan_local_media_verified: input.wanLocal, video_loop_complete: input.wanRemote && input.wanLocal, gpu_inference_verified: input.wanRemote, production_ready: false, image_preserved: true };
}

export function stage3WTaskSummary(state: GenerationPoolState) {
  return [STAGE3O_IMAGE_TASK_ID, STAGE3O_VIDEO_TASK_ID, STAGE3W_RETRY_TASK_ID].map((id) => { const task = state.tasks.find((value) => value.id === id); return { id, status: task?.status ?? "missing", outputMetadata: task?.outputMetadata ?? {} }; });
}
