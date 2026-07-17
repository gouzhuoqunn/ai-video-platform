import { loadSchedulerPolicy } from "@/lib/generation/scheduler-policy";

export type StudioMode = "image" | "video";

export const STUDIO_MODE_STORAGE_KEY = "ai-video-platform:studio-mode";
export const AUTOMATIC_GPU_PROVIDER = "clore" as const;

export function normalizeStudioMode(value: unknown): StudioMode {
  return value === "image" ? "image" : "video";
}

export function batchThreshold(value = process.env.CLORE_AUTORENT_BATCH_THRESHOLD) {
  if (value === undefined) return loadSchedulerPolicy().videoI2vBatchThreshold;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 50 ? parsed : loadSchedulerPolicy().videoI2vBatchThreshold;
}

export function shouldArmCloreScheduler(input: { immediate: boolean; queuedCount: number; threshold: number; compliantHostExists?: boolean }) {
  const tasksReady = input.immediate || input.queuedCount >= input.threshold;
  return {
    provider: AUTOMATIC_GPU_PROVIDER,
    tasksReady,
    schedulerArmed: tasksReady,
    createOrderAllowed: tasksReady && input.compliantHostExists === true,
  };
}
