import { getCloreDeploymentHold } from "./clore/deployment-hold";
import { getRunPodDeploymentHold } from "./runpod-deployment-hold";
import {
  armSpecificGenerationBatch,
  createGenerationTask,
  generationPoolSummary,
  readGenerationPool,
  upsertGenerationTasks,
  type GenerationTask,
} from "../src/lib/generation/task-pool";
import type { ModelAvailabilityRegistry } from "../src/lib/generation/model-availability";

export const STAGE4A_BATCH_ID = "stage4a-final-production";
export const STAGE4A_IMAGE_TASK_ID = "stage4a-final-image-ultrareal-20260717";
export const STAGE4A_VIDEO_TASK_ID = "stage4a-final-video-wan-remix-20260717";
export const STAGE4A_TASK_IDS = [STAGE4A_IMAGE_TASK_ID, STAGE4A_VIDEO_TASK_ID] as const;

const IMAGE_PROMPT = "A cinematic realistic view of a futuristic white research station beside a clear blue ocean at sunset, warm natural light, detailed clouds, clean architecture";
const VIDEO_PROMPT = "The generated research station remains consistent while gentle ocean waves move and clouds drift slowly, subtle cinematic camera movement, realistic lighting";

function finalTasks(existing: GenerationTask[]) {
  const byId = new Map(existing.map((task) => [task.id, task]));
  const createdAt = new Date().toISOString();
  return [
    byId.get(STAGE4A_IMAGE_TASK_ID) ?? createGenerationTask({
      id: STAGE4A_IMAGE_TASK_ID,
      generationType: "image",
      prompt: IMAGE_PROMPT,
      modelProfile: "ultrareal-flux1-dev-fp8",
      gpuPreference: ["rtx4090", "rtx5090"],
      priority: "immediate",
      status: "armed",
      createdAt,
      confirmedAt: createdAt,
      batchId: STAGE4A_BATCH_ID,
      estimatedVram: 23,
      outputMetadata: { width: 1024, height: 1024, steps: 50, seed: 20260715, batch: 1, fixture: STAGE4A_BATCH_ID },
    }),
    byId.get(STAGE4A_VIDEO_TASK_ID) ?? createGenerationTask({
      id: STAGE4A_VIDEO_TASK_ID,
      generationType: "video",
      prompt: VIDEO_PROMPT,
      modelProfile: "wan22-remix-14b-i2v-fp8",
      gpuPreference: ["rtx4090", "rtx5090"],
      priority: "immediate",
      status: "armed",
      createdAt,
      confirmedAt: createdAt,
      batchId: STAGE4A_BATCH_ID,
      estimatedVram: 23,
      outputMetadata: {
        width: 832,
        height: 480,
        frames: 33,
        fps: 16,
        durationSeconds: 2.0625,
        steps: 20,
        seed: 20260715,
        batch: 1,
        inputImageTaskId: STAGE4A_IMAGE_TASK_ID,
        unloadImageModelsBeforeLoad: true,
        fixture: STAGE4A_BATCH_ID,
      },
    }),
  ];
}

export function prepareStage4AFinalBatch(filePath?: string, availabilityRegistry?: ModelAvailabilityRegistry) {
  if (!getCloreDeploymentHold().enabled || !getRunPodDeploymentHold().enabled) throw new Error("provider_holds_must_remain_enabled");
  const current = readGenerationPool(filePath);
  const existing = STAGE4A_TASK_IDS.map((id) => current.tasks.find((task) => task.id === id)).filter(Boolean) as GenerationTask[];
  if (existing.some((task) => ["failed", "cancelled"].includes(task.status))) throw new Error("stage4a_final_batch_has_terminal_failure");
  if (existing.length === STAGE4A_TASK_IDS.length && existing.every((task) => task.status === "completed")) {
    return { prepared: true, reused: true, completed: true, paidExecutionAuthorized: false, state: current };
  }
  const tasks = finalTasks(current.tasks);
  upsertGenerationTasks(tasks, filePath);
  const state = armSpecificGenerationBatch([...STAGE4A_TASK_IDS], STAGE4A_BATCH_ID, filePath, availabilityRegistry);
  return { prepared: true, reused: existing.length > 0, completed: false, paidExecutionAuthorized: false, state };
}

function main() {
  const result = prepareStage4AFinalBatch();
  console.log(JSON.stringify({
    prepared: result.prepared,
    reused: result.reused,
    completed: result.completed,
    paidExecutionAuthorized: result.paidExecutionAuthorized,
    batchId: STAGE4A_BATCH_ID,
    taskIds: [...STAGE4A_TASK_IDS],
    pool: generationPoolSummary(result.state),
  }, null, 2));
}

if (process.argv[1]?.endsWith("stage4a-final-batch.ts")) main();
