import {
  readGenerationPool,
  setGenerationTaskStatus,
  updateManualGpuBatch,
  type GenerationTask,
} from "./task-pool";

/**
 * The production transport supplies this narrow interface after the provider
 * order and worker readiness checks have succeeded. Keeping it injected makes
 * the persisted batch logic testable without contacting a GPU provider.
 */
export type ManualSilent4090Runtime = {
  loadWan22(): Promise<void>;
  runSilentShortVideo(task: GenerationTask): Promise<{ outputMetadata: GenerationTask["outputMetadata"] }>;
  unloadWan22(): Promise<void>;
};

export type ManualBatchRunResult = {
  batchId: string;
  completedTaskIds: string[];
  failedTaskIds: string[];
};

function assertRunnableBatch(filePath?: string) {
  const state = readGenerationPool(filePath);
  const batch = state.scheduler.manualBatch;
  if (!batch || batch.queueKey !== "silent_rtx4090" || batch.gpuClass !== "rtx4090" || batch.modelKey !== "video_wan_silent") {
    throw new Error("manual_silent_4090_batch_not_found");
  }
  if (!batch.providerOrderId) throw new Error("manual_silent_4090_order_not_ready");
  if (!["provisioning", "running", "paused"].includes(batch.status)) throw new Error("manual_silent_4090_batch_not_runnable");
  const tasks = batch.taskIds.map((id) => state.tasks.find((task) => task.id === id));
  if (tasks.some((task) => !task)) throw new Error("manual_silent_4090_batch_membership_changed");
  return { batch, tasks: tasks as GenerationTask[] };
}

/** Runs exactly the frozen IDs with a single Wan load. Per-task failures are recorded and do not stop later IDs. */
export async function runManualSilent4090Batch(runtime: ManualSilent4090Runtime, filePath?: string): Promise<ManualBatchRunResult> {
  const { batch, tasks } = assertRunnableBatch(filePath);
  const completedTaskIds: string[] = [];
  const failedTaskIds: string[] = [];
  let loaded = false;
  updateManualGpuBatch({ status: "running", currentTaskId: null, recoveryState: "clean" }, filePath);

  try {
    await runtime.loadWan22();
    loaded = true;
    for (const task of tasks) {
      updateManualGpuBatch({ status: "running", currentTaskId: task.id }, filePath);
      setGenerationTaskStatus([task.id], "generating_video", {}, filePath);
      try {
        const result = await runtime.runSilentShortVideo(task);
        setGenerationTaskStatus([task.id], "completed", result.outputMetadata, filePath);
        completedTaskIds.push(task.id);
        updateManualGpuBatch({ completedCount: completedTaskIds.length, currentTaskId: null }, filePath);
      } catch (error) {
        const errorClass = error instanceof Error ? error.message : "manual_gpu_task_failed";
        setGenerationTaskStatus([task.id], "failed", { errorClass }, filePath);
        failedTaskIds.push(task.id);
        updateManualGpuBatch({ failedCount: failedTaskIds.length, currentTaskId: null, recoveryState: "reconcile_required" }, filePath);
      }
    }
  } finally {
    if (loaded) await runtime.unloadWan22();
  }

  updateManualGpuBatch({
    status: "completed",
    currentTaskId: null,
    completedCount: completedTaskIds.length,
    failedCount: failedTaskIds.length,
    recoveryState: failedTaskIds.length ? "reconcile_required" : "clean",
  }, filePath);
  return { batchId: batch.id, completedTaskIds, failedTaskIds };
}
