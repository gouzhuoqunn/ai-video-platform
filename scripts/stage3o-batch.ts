import { armSpecificGenerationBatch, createGenerationTask, generationPoolSummary, readGenerationPool, upsertGenerationTasks, type GenerationTask } from "../src/lib/generation/task-pool";
import { assertNoSecretOutput } from "./clore/client";

export const STAGE3O_BATCH_ID = "stage3o";
export const STAGE3O_IMAGE_TASK_ID = "stage3o-image-flux-20260715";
export const STAGE3O_VIDEO_TASK_ID = "stage3o-video-wan-20260715";
export const STAGE3O_TASK_IDS = [STAGE3O_IMAGE_TASK_ID, STAGE3O_VIDEO_TASK_ID] as const;

const IMAGE_PROMPT = "A cinematic wide shot of a futuristic white research station beside a clear blue ocean at sunset, realistic architecture, warm sunlight, detailed clouds, clean composition, high detail";
const VIDEO_PROMPT = "A futuristic white research station beside a blue ocean at sunset, gentle waves moving, clouds drifting slowly, cinematic camera, realistic lighting";

function fixtureTasks(existing: GenerationTask[]) {
  const byId = new Map(existing.map((task) => [task.id, task]));
  const createdAt = new Date().toISOString();
  return [
    byId.get(STAGE3O_IMAGE_TASK_ID) ?? createGenerationTask({ id: STAGE3O_IMAGE_TASK_ID, generationType: "image", prompt: IMAGE_PROMPT, modelProfile: "flux2-klein-4b", priority: "immediate", status: "armed", createdAt, confirmedAt: createdAt, batchId: STAGE3O_BATCH_ID, estimatedVram: 20, outputMetadata: { width: 1024, height: 1024, steps: 4, seed: 20260715, batch: 1, fixture: STAGE3O_BATCH_ID } }),
    byId.get(STAGE3O_VIDEO_TASK_ID) ?? createGenerationTask({ id: STAGE3O_VIDEO_TASK_ID, generationType: "video", prompt: VIDEO_PROMPT, modelProfile: "wan22-ti2v-5b", gpuPreference: ["rtx4090", "rtx5090", "a40", "a6000", "rtx3090", "rtx3090ti"], priority: "immediate", status: "armed", createdAt, confirmedAt: createdAt, batchId: STAGE3O_BATCH_ID, estimatedVram: 24, outputMetadata: { width: 1280, height: 704, frames: 41, fps: 16, durationSeconds: 2.5625, steps: 30, seed: 20260715, batch: 1, audio: false, upscale: false, postProcessing: false, fixture: STAGE3O_BATCH_ID } }),
  ];
}

export function prepareStage3OBatch(filePath?: string) {
  const current = readGenerationPool(filePath);
  const existingFixture = STAGE3O_TASK_IDS.map((id) => current.tasks.find((task) => task.id === id)).filter(Boolean) as GenerationTask[];
  if (existingFixture.length === STAGE3O_TASK_IDS.length && existingFixture.every((task) => task.status === "completed")) {
    return { prepared: true, reused: true, completed: true, chargedOrDebited: false, state: current };
  }
  const tasks = fixtureTasks(current.tasks);
  const state = upsertGenerationTasks(tasks, filePath);
  const terminal = tasks.find((task) => ["failed", "cancelled"].includes(task.status));
  if (terminal) throw new Error(`Stage 3O fixture task ${terminal.id} is terminal; inspect it before creating a new real session.`);
  const armed = armSpecificGenerationBatch([...STAGE3O_TASK_IDS], STAGE3O_BATCH_ID, filePath);
  return { prepared: true, reused: existingFixture.length > 0, completed: false, chargedOrDebited: false, state: armed };
}

function main() {
  const result = prepareStage3OBatch();
  const output = { prepared: result.prepared, reused: result.reused, completed: result.completed, chargedOrDebited: result.chargedOrDebited, batchId: STAGE3O_BATCH_ID, taskIds: [...STAGE3O_TASK_IDS], pool: generationPoolSummary(result.state) };
  const text = JSON.stringify(output, null, 2);
  assertNoSecretOutput(text);
  console.log(text);
}

if (process.argv[1]?.endsWith("stage3o-batch.ts")) main();
