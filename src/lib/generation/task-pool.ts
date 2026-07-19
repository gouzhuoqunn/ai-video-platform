import { randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getCloreDeploymentHold } from "../../../scripts/clore/deployment-hold";
import { modelAvailabilityGate, type ModelAvailabilityRegistry } from "./model-availability";
import {
  estimateProductionSession,
  loadProductionReadiness,
  loadProductionVerification,
  planSequentialProductionSession,
  productionReadinessGate,
  type GroupableProductionTask,
} from "./production-pipeline";
import { PRODUCTION_GPU_CLASSES, PRODUCTION_IMAGE_MODEL, PRODUCTION_VIDEO_MODEL, productionModelSummary } from "./production-models";
import { loadSchedulerPolicy, rankTasksForLoadedSession } from "./scheduler-policy";
import {
  assertSingleFamilyExecution,
  abortRentalSearch,
  beginExistingGpuExecution,
  beginRentalSearch,
  completeGenerationStop,
  completeGpuCancellation,
  confirmedQueueCounts,
  confirmedQueueTasks,
  defaultGpuExecutionState,
  deployedFamilyFromModelKeys,
  normalizeGpuExecutionState,
  normalizeRequiredGpuClass,
  recordDeploymentFailure,
  recordDeploymentReady,
  recordPreviousFamilyUnloaded,
  recordRentalSuccess,
  requestGenerationStop,
  requestGpuCancellation,
  type GenerationFamily,
  type GpuExecutionState,
  type RequiredGpuClass,
} from "./gpu-execution-state";

export type GenerationType = GenerationFamily;
export type GenerationPriority = "normal" | "immediate";
export type GenerationJobForm = "image_only" | "video_from_generated_image" | "video_from_existing_image" | "long_video_segment";
export type GenerationContentMode = "production" | "legacy_debug";
export type GenerationTaskStatus =
  | "pending_confirmation"
  | "waiting_for_batch"
  | "armed"
  | "waiting_for_gpu"
  | "deploying"
  | "provisioning"
  | "restoring_models"
  | "restoring_image_model"
  | "generating_image"
  | "unloading_image_model"
  | "restoring_video_model"
  | "generating_video"
  | "downloading_transcoding"
  | "generating"
  | "syncing"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled";
export type SchedulerState = "idle" | "batch_ready" | "market_watching" | "candidate_found" | "order_pending" | "session_active" | "draining" | "cleanup_pending" | "completed" | "blocked_by_provider";

export type GenerationAttempt = {
  id: string;
  number: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  resumeBoundary: GenerationTaskStatus;
  createdAt: string;
  completedAt: string | null;
  errorClass: string | null;
};

export type GenerationTask = {
  id: string;
  generationType: GenerationType;
  prompt: string;
  modelProfile: string;
  gpuPreference: string[];
  requiredGpuClass: RequiredGpuClass;
  priority: GenerationPriority;
  status: GenerationTaskStatus;
  createdAt: string;
  confirmedAt: string | null;
  batchId: string | null;
  estimatedVram: number;
  jobForm: GenerationJobForm;
  negativePrompt: string;
  seed: number;
  width: number;
  height: number;
  frames: number | null;
  fps: number | null;
  contentMode: GenerationContentMode;
  modelRevision: string;
  inputImageJobId: string | null;
  inputImageVerified: boolean;
  originalJobId: string | null;
  generationNumber: number;
  currentAttemptId: string;
  attempts: GenerationAttempt[];
  outputMetadata: Record<string, string | number | boolean | null>;
  longVideoProjectId: string | null;
  longVideoSegmentIndex: number | null;
};

export type RejectedHost = { serverId: string; reasons: string[]; rejectedAt: string };
export type PersistedProductionSession = {
  sessionId: string;
  providerOrderId: string | null;
  phase: "no_provider_order" | "order_provisioning" | "ssh_ready" | "runtime_ready" | "restore_running" | "image_inference_running" | "image_completed" | "video_restore_running" | "video_inference_running" | "media_conversion_running" | "cleanup_pending";
  activeTaskIds: string[];
  loadedModels: string[];
  approximateSpendUsd: number;
  estimatedRemainingMinutes: number;
  shutdownMode: "immediate" | "after_current" | null;
  automaticShutdownAt: string | null;
  activeLongVideoProjectId?: string | null;
  consecutiveLongVideoSegments?: number;
  updatedAt: string;
};

export type GenerationPoolState = {
  schemaVersion: 3;
  tasks: GenerationTask[];
  execution: GpuExecutionState;
  scheduler: {
    state: SchedulerState;
    selectedBatchId: string | null;
    selectedTaskIds: string[];
    watchStartedAt: string | null;
    lastMarketplaceRequestAt: string | null;
    nextMarketplaceRequestAt: string | null;
    selectedServerId: string | null;
    rejectedHosts: RejectedHost[];
    orderCreationAttempted: boolean;
    drainingRequested: boolean;
    session: PersistedProductionSession | null;
    updatedAt: string;
  };
};

export type PoolCandidate = {
  serverId: string;
  gpu: string;
  vramGb: number;
  ramGb?: number;
  diskGb?: number;
  onDemand?: boolean;
  downloadMbps?: number | null;
  reliability: number | null;
  rating: number | null;
  projectedCostUsd: number;
  hourlyUsd: number;
};

export const GENERATION_POOL_PATH = process.env.GENERATION_POOL_STATE_PATH?.trim() || path.join(process.cwd(), ".secrets", "generation-pool-state.json");
export const MAX_ACCEPTABLE_HOURLY_USD = 0.7;

const PRODUCTION_MODELS = new Set([PRODUCTION_IMAGE_MODEL, PRODUCTION_VIDEO_MODEL]);
const ACTIVE_TASK_STATUSES = new Set<GenerationTaskStatus>([
  "deploying", "provisioning", "restoring_models", "restoring_image_model", "generating_image", "unloading_image_model",
  "restoring_video_model", "generating_video", "downloading_transcoding", "generating", "syncing",
]);

function now() { return new Date().toISOString(); }

export function generationThreshold(type: GenerationType, value?: string) {
  if (value !== undefined) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 50) return parsed;
  }
  const policy = loadSchedulerPolicy();
  return type === "image" ? policy.imageOnlyBatchThreshold : policy.videoI2vBatchThreshold;
}

export function acceptableGpuClasses(type: GenerationType, modelProfile: string) {
  if (type === "image" && modelProfile === PRODUCTION_IMAGE_MODEL) return [...PRODUCTION_GPU_CLASSES];
  if (type === "video" && modelProfile === PRODUCTION_VIDEO_MODEL) return [...PRODUCTION_GPU_CLASSES];
  if (process.env.GENERATION_LEGACY_DEBUG === "true" && type === "image" && modelProfile === "flux2-klein-4b") return [...PRODUCTION_GPU_CLASSES];
  if (process.env.GENERATION_LEGACY_DEBUG === "true" && type === "video" && modelProfile === "wan22-ti2v-5b") return [...PRODUCTION_GPU_CLASSES];
  return [];
}

export function classifyGpu(value: string) {
  const gpu = value.toLowerCase().replace(/nvidia|geforce|quadro|\s|_|-/g, "");
  if (gpu.includes("5090")) return "rtx5090";
  if (gpu.includes("4090")) return "rtx4090";
  if (gpu.includes("a6000")) return "a6000";
  if (gpu.includes("a40")) return "a40";
  if (gpu.includes("3090ti")) return "rtx3090ti";
  if (gpu.includes("3090")) return "rtx3090";
  return "unknown";
}

export function validateProductionCandidate(candidate: PoolCandidate) {
  const reasons: string[] = [];
  if (!PRODUCTION_GPU_CLASSES.includes(classifyGpu(candidate.gpu) as (typeof PRODUCTION_GPU_CLASSES)[number])) reasons.push("只允许 RTX4090 或 RTX5090");
  if (candidate.vramGb < 23) reasons.push("生产模型至少需要 23GB 显存");
  if ((candidate.ramGb ?? 0) < 32) reasons.push("生产模型至少需要 32GB RAM");
  if ((candidate.diskGb ?? 0) < 200) reasons.push("生产模型至少需要 200GB 磁盘");
  if (candidate.onDemand !== true) reasons.push("生产模型只允许 On-Demand");
  if (candidate.hourlyUsd > MAX_ACCEPTABLE_HOURLY_USD) reasons.push("小时价格超过上限");
  if (candidate.projectedCostUsd > 2.5) reasons.push("预计会话费用超过上限");
  return reasons;
}

export function defaultGenerationPoolState(): GenerationPoolState {
  return {
    schemaVersion: 3,
    tasks: [],
    execution: defaultGpuExecutionState(),
    scheduler: { state: "idle", selectedBatchId: null, selectedTaskIds: [], watchStartedAt: null, lastMarketplaceRequestAt: null, nextMarketplaceRequestAt: null, selectedServerId: null, rejectedHosts: [], orderCreationAttempted: false, drainingRequested: false, session: null, updatedAt: now() },
  };
}

function normalizeTask(task: Partial<GenerationTask> & Pick<GenerationTask, "id" | "generationType" | "prompt" | "modelProfile">): GenerationTask {
  const createdAt = task.createdAt ?? now();
  const attemptId = task.currentAttemptId ?? task.attempts?.at(-1)?.id ?? randomUUID();
  const verified = task.modelProfile === PRODUCTION_IMAGE_MODEL ? loadProductionVerification().imageModel : task.modelProfile === PRODUCTION_VIDEO_MODEL ? loadProductionVerification().videoModel : null;
  return {
    id: task.id,
    generationType: task.generationType,
    prompt: task.prompt,
    modelProfile: task.modelProfile,
    gpuPreference: task.gpuPreference ?? acceptableGpuClasses(task.generationType, task.modelProfile),
    requiredGpuClass: normalizeRequiredGpuClass(task),
    priority: task.priority ?? "normal",
    status: task.status ?? "pending_confirmation",
    createdAt,
    confirmedAt: task.confirmedAt ?? null,
    batchId: task.batchId ?? null,
    estimatedVram: task.estimatedVram ?? (task.generationType === "image" ? 23 : 24),
    jobForm: task.jobForm ?? (task.generationType === "image" ? "image_only" : "video_from_existing_image"),
    negativePrompt: task.negativePrompt ?? "",
    seed: Number.isSafeInteger(task.seed) ? Number(task.seed) : randomInt(1, 2_147_483_647),
    width: task.width ?? (task.generationType === "image" ? 1024 : 832),
    height: task.height ?? (task.generationType === "image" ? 1024 : 480),
    frames: task.generationType === "video" ? task.frames ?? 33 : null,
    fps: task.generationType === "video" ? task.fps ?? 16 : null,
    contentMode: task.contentMode ?? (PRODUCTION_MODELS.has(task.modelProfile) ? "production" : "legacy_debug"),
    modelRevision: task.modelRevision ?? verified?.revision ?? "legacy",
    inputImageJobId: task.inputImageJobId ?? null,
    inputImageVerified: task.inputImageVerified ?? false,
    originalJobId: task.originalJobId ?? null,
    generationNumber: task.generationNumber ?? 1,
    currentAttemptId: attemptId,
    attempts: task.attempts?.length ? task.attempts : [{ id: attemptId, number: 1, status: "pending", resumeBoundary: "pending_confirmation", createdAt, completedAt: null, errorClass: null }],
    outputMetadata: task.outputMetadata ?? {},
    longVideoProjectId: task.longVideoProjectId ?? null,
    longVideoSegmentIndex: Number.isInteger(task.longVideoSegmentIndex) ? Number(task.longVideoSegmentIndex) : null,
  };
}

export function readGenerationPool(filePath = GENERATION_POOL_PATH): GenerationPoolState {
  if (!existsSync(filePath)) return defaultGenerationPoolState();
  try {
    const state = JSON.parse(readFileSync(filePath, "utf8")) as GenerationPoolState & { schemaVersion: 1 | 2 | 3 };
    if (![1, 2, 3].includes(state.schemaVersion) || !Array.isArray(state.tasks) || !state.scheduler) throw new Error("invalid");
    const scheduler = { ...defaultGenerationPoolState().scheduler, ...state.scheduler, session: state.scheduler.session ?? null };
    const tasks = state.tasks.map((task) => normalizeTask(task));
    const execution = normalizeGpuExecutionState(state.execution, scheduler.session);
    if (execution.providerOrderId && !execution.rentedGpuClass) {
      const activeIds = new Set([...(scheduler.session?.activeTaskIds ?? []), ...scheduler.selectedTaskIds]);
      const activeTasks = tasks.filter((task) => activeIds.has(task.id));
      const gpuClasses = [...new Set(activeTasks.map((task) => task.requiredGpuClass))];
      const families = [...new Set(activeTasks.map((task) => task.generationType))];
      if (gpuClasses.length === 1) execution.rentedGpuClass = gpuClasses[0];
      if (!execution.activeExecution && gpuClasses.length === 1 && families.length === 1) {
        execution.activeExecution = {
          generationFamily: families[0],
          gpuClass: gpuClasses[0],
          confirmedTaskIds: activeTasks.map((task) => task.id),
          runtimeSessionId: scheduler.session?.sessionId ?? null,
        };
      }
    }
    return {
      schemaVersion: 3,
      tasks,
      execution,
      scheduler,
    };
  } catch {
    return { ...defaultGenerationPoolState(), scheduler: { ...defaultGenerationPoolState().scheduler, state: "blocked_by_provider" } };
  }
}

export function writeGenerationPool(state: GenerationPoolState, filePath = GENERATION_POOL_PATH) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = { ...state, scheduler: { ...state.scheduler, updatedAt: now() } };
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  renameSync(temporary, filePath);
  return normalized;
}

export function createGenerationTask(input: Partial<GenerationTask> & Pick<GenerationTask, "generationType" | "prompt" | "modelProfile">): GenerationTask {
  const explicitLegacy = input.contentMode === "legacy_debug" && ((input.generationType === "image" && input.modelProfile === "flux2-klein-4b") || (input.generationType === "video" && input.modelProfile === "wan22-ti2v-5b"));
  const allowed: string[] = explicitLegacy ? [...PRODUCTION_GPU_CLASSES] : acceptableGpuClasses(input.generationType, input.modelProfile);
  if (!allowed.length) throw new Error("普通新任务只能使用默认生产模型；旧模型需要显式 legacy/debug 开关。");
  const requested = input.gpuPreference?.filter((gpu) => allowed.includes(gpu)) ?? [];
  const gpuPreference = requested.length ? [...new Set(requested)] : allowed;
  const requiredGpuClass = normalizeRequiredGpuClass({ ...input, gpuPreference });
  return normalizeTask({
    ...input,
    id: input.id ?? randomUUID(), generationType: input.generationType, prompt: input.prompt.trim(), modelProfile: input.modelProfile,
    gpuPreference, requiredGpuClass, priority: input.priority ?? "normal", status: input.status ?? "pending_confirmation", createdAt: input.createdAt ?? now(), confirmedAt: input.confirmedAt ?? null,
    batchId: input.batchId ?? null, estimatedVram: input.estimatedVram ?? (input.generationType === "image" ? 23 : 24), outputMetadata: input.outputMetadata ?? {},
  });
}

export type NormalJobInput = {
  jobForm: Exclude<GenerationJobForm, "long_video_segment">;
  prompt: string;
  negativePrompt?: string;
  seed?: number | null;
  sizePreset?: "square_1024" | "landscape_1024" | "medium_image_4090" | "medium_image_5090" | "high_image_5090" | "wan_4090" | "wan_5090" | "low_video_4090" | "medium_video_4090" | "medium_video_5090" | "high_video_5090";
  gpuPreference?: string[];
  existingImageJobId?: string | null;
  existingImageVerified?: boolean;
  priority?: GenerationPriority;
  status?: GenerationTaskStatus;
};

function preset(value: NormalJobInput["sizePreset"], type: GenerationType) {
  if (type === "image") {
    if (value === "medium_image_4090" || value === "medium_image_5090") return { width: 1536, height: 1024, frames: null, fps: null };
    if (value === "high_image_5090") return { width: 2048, height: 2048, frames: null, fps: null };
    if (value === "landscape_1024") return { width: 1024, height: 768, frames: null, fps: null };
    return { width: 1024, height: 1024, frames: null, fps: null };
  }
  if (value === "low_video_4090") return { width: 832, height: 480, frames: 33, fps: 16 };
  if (value === "medium_video_4090" || value === "medium_video_5090" || value === "high_video_5090") return { width: 1280, height: 720, frames: 81, fps: 16 };
  if (value === "wan_5090") return { width: 1280, height: 704, frames: 41, fps: 16 };
  return { width: 832, height: 480, frames: 33, fps: 16 };
}

export function createNormalJobSet(input: NormalJobInput) {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 2000) throw new Error("任务提示词无效。");
  const priority = input.priority ?? "normal";
  const status = input.status ?? "pending_confirmation";
  const seed = Number.isSafeInteger(input.seed) && Number(input.seed) > 0 ? Number(input.seed) : randomInt(1, 2_147_483_647);
  const verification = loadProductionVerification();
  const common = { prompt, negativePrompt: input.negativePrompt?.trim() ?? "", seed, gpuPreference: input.gpuPreference, priority, status };
  if (input.jobForm === "image_only") {
    return [createGenerationTask({
      ...common, ...preset(input.sizePreset, "image"), generationType: "image", jobForm: "image_only",
      modelProfile: PRODUCTION_IMAGE_MODEL, modelRevision: verification.imageModel.revision,
    })];
  }
  if (input.jobForm === "video_from_existing_image") {
    const imageId = String(input.existingImageJobId ?? "");
    if (!/^[A-Za-z0-9_-]{6,120}$/.test(imageId) || input.existingImageVerified !== true) throw new Error("请选择已经保存并验证的本地图片。");
    return [createGenerationTask({
      ...common, ...preset(input.sizePreset, "video"), generationType: "video", jobForm: input.jobForm,
      modelProfile: PRODUCTION_VIDEO_MODEL, modelRevision: verification.videoModel.revision,
      inputImageJobId: imageId, inputImageVerified: true,
    })];
  }
  const image = createGenerationTask({
    ...common, ...preset("square_1024", "image"), generationType: "image", jobForm: input.jobForm,
    modelProfile: PRODUCTION_IMAGE_MODEL, modelRevision: verification.imageModel.revision,
  });
  const video = createGenerationTask({
    ...common, ...preset(input.sizePreset, "video"), generationType: "video", jobForm: input.jobForm,
    modelProfile: PRODUCTION_VIDEO_MODEL, modelRevision: verification.videoModel.revision,
    inputImageJobId: image.id, inputImageVerified: false,
  });
  return [image, video];
}

export function upsertGenerationTasks(tasks: GenerationTask[], filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  for (const task of tasks) byId.set(task.id, { ...byId.get(task.id), ...task });
  state.tasks = [...byId.values()];
  return writeGenerationPool(state, filePath);
}

export function updateGenerationTasks(taskIds: string[], action: "confirm" | "immediate" | "cancel" | "delete", filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  const selected = new Set(taskIds);
  if (action === "delete") state.tasks = state.tasks.filter((task) => !selected.has(task.id));
  else state.tasks = state.tasks.map((task) => {
    if (!selected.has(task.id)) return task;
    if (action === "cancel") return { ...task, status: ACTIVE_TASK_STATUSES.has(task.status) ? "cancel_requested" as const : "cancelled" as const };
    if (["completed", "failed", "cancelled"].includes(task.status)) return task;
    return { ...task, priority: action === "immediate" ? "immediate" as const : task.priority, status: "waiting_for_gpu" as const, confirmedAt: task.confirmedAt ?? now() };
  });
  return writeGenerationPool(state, filePath);
}

export function confirmGenerationTasks(taskIds: string[], family: GenerationType, filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  const uniqueIds = [...new Set(taskIds)];
  const selected = uniqueIds.map((id) => state.tasks.find((task) => task.id === id)).filter(Boolean) as GenerationTask[];
  if (!selected.length || selected.length !== uniqueIds.length) throw new Error("所选任务不存在或已经被删除。");
  if (selected.some((task) => task.generationType !== family)) throw new Error("一次确认不能混合图片和视频任务。");
  if (selected.some((task) => !["pending_confirmation", "waiting_for_gpu"].includes(task.status))) throw new Error("所选任务包含不可确认状态。");
  const pending = new Set(selected.filter((task) => task.status === "pending_confirmation").map((task) => task.id));
  state.tasks = state.tasks.map((task) => pending.has(task.id) ? {
    ...task,
    status: "waiting_for_gpu",
    confirmedAt: task.confirmedAt ?? now(),
  } : task);
  return {
    state: pending.size ? writeGenerationPool(state, filePath) : state,
    confirmed: pending.size,
    duplicateConfirmationBlocked: pending.size === 0,
  };
}

function lastVerifiedBoundary(task: GenerationTask): GenerationTaskStatus {
  if (task.generationType === "video" && task.inputImageJobId && (task.inputImageVerified || task.outputMetadata.imagePreserved === true)) return "restoring_video_model";
  if (task.outputMetadata.outputPath) return "completed";
  return task.confirmedAt ? "waiting_for_batch" : "pending_confirmation";
}

export function retryGenerationTasks(taskIds: string[], filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  const selected = new Set(taskIds);
  state.tasks = state.tasks.map((task) => {
    if (!selected.has(task.id)) return task;
    if (task.status !== "failed") throw new Error("只有失败任务可以重试；已完成输出不会自动重试。");
    const boundary = lastVerifiedBoundary(task);
    if (boundary === "completed") throw new Error("已完成输出不会自动重试。");
    const id = randomUUID();
    return {
      ...task,
      currentAttemptId: id,
      status: boundary === "pending_confirmation" ? boundary : "waiting_for_batch",
      attempts: [...task.attempts, { id, number: task.attempts.length + 1, status: "pending", resumeBoundary: boundary, createdAt: now(), completedAt: null, errorClass: null }],
      outputMetadata: { ...task.outputMetadata, errorClass: null },
    };
  });
  return writeGenerationPool(state, filePath);
}

export function regenerateGenerationTasks(taskIds: string[], filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  const originals = state.tasks.filter((task) => taskIds.includes(task.id));
  const idMap = new Map<string, string>(originals.map((task) => [task.id, randomUUID()]));
  const regenerated = originals.map((task) => createGenerationTask({
    ...task,
    id: idMap.get(task.id)!,
    inputImageJobId: task.inputImageJobId ? idMap.get(task.inputImageJobId) ?? task.inputImageJobId : null,
    inputImageVerified: task.inputImageJobId ? !idMap.has(task.inputImageJobId) : task.inputImageVerified,
    originalJobId: task.originalJobId ?? task.id,
    generationNumber: task.generationNumber + 1,
    status: "pending_confirmation",
    priority: "normal",
    confirmedAt: null,
    batchId: null,
    createdAt: now(),
    currentAttemptId: undefined,
    attempts: undefined,
    outputMetadata: {},
  }));
  return { regenerated, state: upsertGenerationTasks(regenerated, filePath) };
}

export function setGenerationTaskStatus(taskIds: string[], status: GenerationTaskStatus, outputMetadata: GenerationTask["outputMetadata"] = {}, filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  const selected = new Set(taskIds);
  state.tasks = state.tasks.map((task) => {
    if (!selected.has(task.id)) return task;
    const attemptStatus = status === "completed" ? "completed" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : ACTIVE_TASK_STATUSES.has(status) ? "running" : "pending";
    return {
      ...task,
      status,
      attempts: task.attempts.map((attempt) => attempt.id === task.currentAttemptId ? {
        ...attempt,
        status: attemptStatus,
        completedAt: ["completed", "failed", "cancelled"].includes(attemptStatus) ? now() : null,
        errorClass: status === "failed" ? String(outputMetadata.errorClass ?? "generation_failed") : null,
      } : attempt),
      outputMetadata: { ...task.outputMetadata, ...outputMetadata },
    };
  });
  return writeGenerationPool(state, filePath);
}

export function armSpecificGenerationBatch(taskIds: string[], batchId: string, filePath = GENERATION_POOL_PATH, availabilityRegistry?: ModelAvailabilityRegistry) {
  if (!/^[A-Za-z0-9_-]{3,120}$/.test(batchId)) throw new Error("固定批次编号格式无效。");
  const state = readGenerationPool(filePath);
  const uniqueIds = [...new Set(taskIds)];
  const tasks = uniqueIds.map((id) => state.tasks.find((task) => task.id === id)).filter(Boolean) as GenerationTask[];
  if (tasks.length !== uniqueIds.length || tasks.length === 0) throw new Error("固定批次任务不存在或为空。");
  for (const task of tasks) {
    const gate = PRODUCTION_MODELS.has(task.modelProfile) ? productionReadinessGate(task.modelProfile) : modelAvailabilityGate(task.modelProfile, availabilityRegistry);
    if (!gate.allowed || !gate.model?.restoreReady) throw new Error(gate.reason);
    if (["completed", "failed", "cancelled"].includes(task.status)) throw new Error(`任务 ${task.id} 已结束，不能重新武装。`);
  }
  const compatible = tasks.map((task) => new Set(task.gpuPreference.length ? task.gpuPreference : acceptableGpuClasses(task.generationType, task.modelProfile))).reduce((left, right) => new Set([...left].filter((gpu) => right.has(gpu))));
  if (compatible.size === 0) throw new Error("固定批次没有共同兼容的显卡类别。");
  const ids = new Set(uniqueIds);
  state.tasks = state.tasks.map((task) => ids.has(task.id) ? { ...task, priority: "immediate", status: "armed", confirmedAt: task.confirmedAt ?? now(), batchId } : task);
  state.scheduler = { ...state.scheduler, state: "batch_ready", selectedBatchId: batchId, selectedTaskIds: uniqueIds, watchStartedAt: state.scheduler.watchStartedAt ?? now(), selectedServerId: null, orderCreationAttempted: false, drainingRequested: false };
  return writeGenerationPool(state, filePath);
}

function eligibleGroups(state: GenerationPoolState, type: GenerationType) {
  const tasks = state.tasks.filter((task) => task.generationType === type && ["waiting_for_batch", "armed", "waiting_for_gpu"].includes(task.status) && task.contentMode === "production");
  const groups = new Map<string, GenerationTask[]>();
  for (const task of tasks) {
    const key = [task.modelProfile, task.modelRevision, [...task.gpuPreference].sort().join("+"), task.width, task.height, task.frames ?? 1, task.contentMode].join("|");
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return [...groups.values()].map((items) => rankTasksForLoadedSession(items, state.scheduler.session));
}

function waitedLongEnough(task: GenerationTask, at: number, maximumWaitMinutes: number) {
  const since = Date.parse(task.confirmedAt ?? task.createdAt);
  return Number.isFinite(since) && at - since >= maximumWaitMinutes * 60_000;
}

export function selectNextSession(state: GenerationPoolState, at = Date.now()) {
  const policy = loadSchedulerPolicy();
  const batches: Array<{ generationType: GenerationType; modelProfile: string; tasks: GenerationTask[]; acceptableGpuClasses: string[]; estimatedVram: number }> = [];
  for (const type of ["image", "video"] as const) {
    const ready = eligibleGroups(state, type).find((group) => {
      const immediate = group.some((task) => task.priority === "immediate");
      const maxWait = group.some((task) => waitedLongEnough(task, at, policy.maximumWaitMinutes));
      const chainCount = group.filter((task) => task.jobForm === "video_from_generated_image").length;
      const threshold = type === "image" ? policy.imageOnlyBatchThreshold : chainCount > 0 ? policy.combinedChainBatchThreshold : policy.videoI2vBatchThreshold;
      return immediate || maxWait || group.length >= threshold;
    });
    if (!ready) continue;
    const gate = productionReadinessGate(ready[0].modelProfile);
    if (!gate.allowed) return { ready: false, reason: gate.reason, batches: [], tasks: [] as GenerationTask[] };
    const compatibleGpuClasses = ready.map((task) => new Set(task.gpuPreference.length ? task.gpuPreference : acceptableGpuClasses(type, task.modelProfile))).reduce((left, right) => new Set([...left].filter((gpu) => right.has(gpu))));
    batches.push({ generationType: type, modelProfile: ready[0].modelProfile, tasks: ready, acceptableGpuClasses: [...compatibleGpuClasses], estimatedVram: Math.max(...ready.map((task) => task.estimatedVram)) });
  }
  if (batches.length === 0) return { ready: false, reason: `普通图片需满 ${policy.imageOnlyBatchThreshold} 个、I2V 需满 ${policy.videoI2vBatchThreshold} 个、组合链需满 ${policy.combinedChainBatchThreshold} 个；立即任务或等待满 ${policy.maximumWaitMinutes} 分钟可触发。`, batches, tasks: [] as GenerationTask[] };
  const selected = new Map(batches.flatMap((batch) => batch.tasks).map((task) => [task.id, task]));
  for (const task of [...selected.values()]) {
    if (task.generationType !== "video" || task.jobForm !== "video_from_generated_image" || !task.inputImageJobId) continue;
    const dependency = state.tasks.find((candidate) => candidate.id === task.inputImageJobId);
    if (dependency && !["completed", "failed", "cancelled"].includes(dependency.status)) selected.set(dependency.id, dependency);
  }
  const selectedTasks = [...selected.values()];
  for (const type of ["image", "video"] as const) {
    const missing = selectedTasks.filter((task) => task.generationType === type && !batches.some((batch) => batch.tasks.some((candidate) => candidate.id === task.id)));
    if (missing.length) {
      batches.push({ generationType: type, modelProfile: missing[0].modelProfile, tasks: missing, acceptableGpuClasses: missing[0].gpuPreference, estimatedVram: Math.max(...missing.map((task) => task.estimatedVram)) });
    }
  }
  batches.sort((left, right) => left.generationType === right.generationType ? 0 : left.generationType === "image" ? -1 : 1);
  const compatible = batches.map((batch) => new Set(batch.acceptableGpuClasses)).reduce((left, right) => new Set([...left].filter((value) => right.has(value))));
  if (compatible.size === 0) return { ready: false, reason: "图片与视频批次没有共同兼容的显卡类别。", batches: [], tasks: [] as GenerationTask[] };
  return { ready: true, reason: null, batches, tasks: selectedTasks, acceptableGpuClasses: [...compatible] };
}

export function armGenerationPool(filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  const existing = state.scheduler.selectedTaskIds.map((id) => state.tasks.find((task) => task.id === id)).filter(Boolean) as GenerationTask[];
  if (existing.length > 0 && !existing.every((task) => ["completed", "failed", "cancelled"].includes(task.status))) {
    return { state, armed: true, reusedPersistedBatch: true, reason: "已恢复上次选中的批次，未创建重复批次。" };
  }
  const selection = selectNextSession(state);
  if (!selection.ready) return { state, armed: false, reusedPersistedBatch: false, reason: selection.reason };
  const batchId = randomUUID();
  const ids = new Set(selection.tasks.map((task) => task.id));
  state.tasks = state.tasks.map((task) => ids.has(task.id) ? { ...task, status: "armed", batchId } : task);
  state.scheduler = { ...state.scheduler, state: "batch_ready", selectedBatchId: batchId, selectedTaskIds: [...ids], watchStartedAt: state.scheduler.watchStartedAt ?? now(), selectedServerId: null, orderCreationAttempted: false, drainingRequested: false };
  return { state: writeGenerationPool(state, filePath), armed: true, reusedPersistedBatch: false, reason: "批次已锁定并持久化。" };
}

export function marketplacePollDelayMs(watchStartedAt: string | null, at = Date.now()) {
  const elapsed = watchStartedAt ? Math.max(0, at - Date.parse(watchStartedAt)) : 0;
  if (elapsed < 30 * 60_000) return 60_000;
  const exponent = Math.min(4, 1 + Math.floor((elapsed - 30 * 60_000) / (30 * 60_000)));
  return 60_000 * 2 ** exponent;
}

export function selectCloreCandidate(candidates: PoolCandidate[], state: GenerationPoolState) {
  const selection = selectNextSession(state);
  if (!selection.ready) return { candidate: null, rejected: [] as RejectedHost[], reason: selection.reason };
  const rejectedIds = new Set(state.scheduler.rejectedHosts.map((entry) => entry.serverId));
  const rejected: RejectedHost[] = [];
  const productionSession = selection.batches.every((batch) => PRODUCTION_MODELS.has(batch.modelProfile));
  const accepted = candidates.filter((candidate) => {
    const reasons: string[] = [];
    if (productionSession) reasons.push(...validateProductionCandidate(candidate));
    const gpuClass = classifyGpu(candidate.gpu);
    if (!selection.acceptableGpuClasses?.includes(gpuClass)) reasons.push("显卡类别不兼容");
    if (candidate.vramGb < Math.max(...selection.batches.map((batch) => batch.estimatedVram))) reasons.push("显存不足");
    if (candidate.hourlyUsd > MAX_ACCEPTABLE_HOURLY_USD) reasons.push("小时价格超过上限");
    if (candidate.projectedCostUsd > 2.5) reasons.push("预计会话费用超过上限");
    if (rejectedIds.has(candidate.serverId)) reasons.push("此前已记录为不可用主机");
    if (reasons.length) rejected.push({ serverId: candidate.serverId, reasons, rejectedAt: now() });
    return reasons.length === 0;
  }).sort((left, right) => (right.reliability ?? 0) - (left.reliability ?? 0) || (right.downloadMbps ?? 0) - (left.downloadMbps ?? 0) || (right.rating ?? 0) - (left.rating ?? 0) || left.projectedCostUsd - right.projectedCostUsd || left.hourlyUsd - right.hourlyUsd);
  return { candidate: accepted[0] ?? null, rejected, reason: accepted.length ? null : "当前市场没有满足模型、显存、可靠性和预算条件的主机。" };
}

export function applyMarketObservation(candidates: PoolCandidate[], filePath = GENERATION_POOL_PATH, at = Date.now()) {
  const armed = armGenerationPool(filePath);
  const state = armed.state;
  if (!armed.armed) return { state, orderWouldBeCreated: false, reason: armed.reason, candidate: null };
  const nextAt = state.scheduler.nextMarketplaceRequestAt ? Date.parse(state.scheduler.nextMarketplaceRequestAt) : 0;
  if (nextAt > at) return { state, orderWouldBeCreated: false, reason: `市场轮询尚未到期，下次时间 ${state.scheduler.nextMarketplaceRequestAt}。`, candidate: null };
  const chosen = selectCloreCandidate(candidates, state);
  state.scheduler.lastMarketplaceRequestAt = new Date(at).toISOString();
  state.scheduler.nextMarketplaceRequestAt = new Date(at + marketplacePollDelayMs(state.scheduler.watchStartedAt, at)).toISOString();
  state.scheduler.rejectedHosts = [...state.scheduler.rejectedHosts, ...chosen.rejected].slice(-200);
  state.scheduler.selectedServerId = chosen.candidate?.serverId ?? null;
  state.scheduler.state = chosen.candidate ? "candidate_found" : "market_watching";
  state.tasks = state.tasks.map((task) => state.scheduler.selectedTaskIds.includes(task.id) ? { ...task, status: "waiting_for_gpu" } : task);
  const hold = getCloreDeploymentHold();
  const orderWouldBeCreated = Boolean(chosen.candidate) && !hold.enabled;
  const reason = hold.enabled ? "Clore 部署暂停已开启：只记录候选，不会创建订单。" : chosen.reason ?? "存在合规主机；真实创建仍需操作员恢复开关。";
  return { state: writeGenerationPool(state, filePath), orderWouldBeCreated, reason, candidate: chosen.candidate };
}

function groupable(task: GenerationTask): GroupableProductionTask {
  return {
    id: task.id,
    generationType: task.generationType,
    jobForm: task.jobForm,
    modelProfile: task.modelProfile,
    modelRevision: task.modelRevision,
    gpuPreference: task.gpuPreference,
    width: task.width,
    height: task.height,
    frames: task.frames ?? undefined,
    contentMode: task.contentMode,
    inputImageJobId: task.inputImageJobId,
    inputImageVerified: task.inputImageVerified || task.outputMetadata.imagePreserved === true,
  };
}

export function beginConfirmedQueueExecution(input: {
  generationFamily: GenerationType;
  gpuClass: RequiredGpuClass;
  operationId: string;
  manualRentalIntentVerified: boolean;
  taskIds?: string[];
}, filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  if (!state.execution.rentedGpuClass && !input.manualRentalIntentVerified) throw new Error("开始租用前必须绑定当前手动队列意图。");
  const queue = confirmedQueueTasks(state.tasks, input.generationFamily, input.gpuClass);
  const requestedIds = input.taskIds?.length ? new Set(input.taskIds) : null;
  const tasks = requestedIds ? queue.filter((task) => requestedIds.has(task.id)) : queue;
  if (requestedIds && tasks.length !== requestedIds.size) throw new Error("手动授权中的任务与当前确认队列不一致。");
  assertSingleFamilyExecution(tasks, input.generationFamily, input.gpuClass);
  if (state.execution.activeExecution && state.execution.activeExecution.generationFamily !== input.generationFamily) {
    throw new Error("同一张 GPU 不能并发执行图片和视频任务。");
  }
  const active = {
    generationFamily: input.generationFamily,
    gpuClass: input.gpuClass,
    confirmedTaskIds: tasks.map((task) => task.id),
    operationId: input.operationId,
  };
  state.execution = state.execution.rentedGpuClass
    ? beginExistingGpuExecution(state.execution, active)
    : beginRentalSearch(state.execution, active);
  const batchId = `manual-${input.generationFamily}-${input.gpuClass}-${input.operationId}`;
  state.scheduler = {
    ...state.scheduler,
    state: state.execution.activity === "searching" ? "market_watching" : "session_active",
    selectedBatchId: batchId,
    selectedTaskIds: tasks.map((task) => task.id),
    selectedServerId: null,
    orderCreationAttempted: false,
  };
  state.tasks = state.tasks.map((task) => tasks.some((selected) => selected.id === task.id) ? { ...task, batchId } : task);
  return writeGenerationPool(state, filePath);
}

export function abortConfirmedQueueRentalSearch(filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  state.execution = abortRentalSearch(state.execution);
  state.scheduler = {
    ...state.scheduler,
    state: "idle",
    selectedBatchId: null,
    selectedTaskIds: [],
    selectedServerId: null,
    orderCreationAttempted: false,
  };
  return writeGenerationPool(state, filePath);
}

export function recordConfirmedQueueRentalSuccess(input: {
  providerOrderId: string;
  runtimeSessionId: string;
  gpuClass: RequiredGpuClass;
}, filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  state.execution = recordRentalSuccess(state.execution, input);
  state.scheduler.state = "session_active";
  state.scheduler.orderCreationAttempted = true;
  return writeGenerationPool(state, filePath);
}

export function completeConfirmedQueueDeployment(filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  state.execution = recordDeploymentReady(state.execution);
  const activeIds = new Set(state.execution.activeExecution?.confirmedTaskIds ?? []);
  const runningStatus = state.execution.deployedFamily === "image" ? "generating_image" : "generating_video";
  state.tasks = state.tasks.map((task) => activeIds.has(task.id) ? { ...task, status: runningStatus } : task);
  return writeGenerationPool(state, filePath);
}

export function completePreviousFamilyUnload(filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  state.execution = recordPreviousFamilyUnloaded(state.execution);
  return writeGenerationPool(state, filePath);
}

export function failConfirmedQueueDeployment(reason: string, filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  const activeIds = new Set(state.execution.activeExecution?.confirmedTaskIds ?? []);
  state.execution = recordDeploymentFailure(state.execution, reason);
  state.tasks = state.tasks.map((task) => activeIds.has(task.id) && !["completed", "cancelled"].includes(task.status) ? { ...task, status: "waiting_for_gpu" } : task);
  return writeGenerationPool(state, filePath);
}

function markInterruptedTasksWaiting(state: GenerationPoolState, taskIds: string[]) {
  const selected = new Set(taskIds);
  state.tasks = state.tasks.map((task) => {
    if (!selected.has(task.id) || ["completed", "failed", "cancelled"].includes(task.status)) return task;
    return {
      ...task,
      status: "waiting_for_gpu",
      attempts: task.attempts.map((attempt) => attempt.id === task.currentAttemptId ? {
        ...attempt,
        status: "pending",
        completedAt: null,
        errorClass: "interrupted_by_user",
      } : attempt),
      outputMetadata: { ...task.outputMetadata, interrupted: true },
    };
  });
}

export function requestPoolGenerationStop(operationId: string, filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  const activeIds = new Set(state.execution.activeExecution?.confirmedTaskIds ?? []);
  state.execution = requestGenerationStop(state.execution, operationId);
  state.tasks = state.tasks.map((task) => activeIds.has(task.id) && ACTIVE_TASK_STATUSES.has(task.status) ? { ...task, status: "cancel_requested" } : task);
  return writeGenerationPool(state, filePath);
}

export function completePoolGenerationStop(filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  const activeIds = state.execution.activeExecution?.confirmedTaskIds ?? [];
  state.execution = completeGenerationStop(state.execution);
  markInterruptedTasksWaiting(state, activeIds);
  state.scheduler.state = "session_active";
  state.scheduler.selectedBatchId = null;
  state.scheduler.selectedTaskIds = [];
  return writeGenerationPool(state, filePath);
}

export function requestPoolGpuCancellation(operationId: string, filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  const activeIds = new Set(state.execution.activeExecution?.confirmedTaskIds ?? []);
  state.execution = requestGpuCancellation(state.execution, operationId);
  state.tasks = state.tasks.map((task) => activeIds.has(task.id) && ACTIVE_TASK_STATUSES.has(task.status) ? { ...task, status: "cancel_requested" } : task);
  return writeGenerationPool(state, filePath);
}

export function completePoolGpuCancellation(filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  const activeIds = state.execution.activeExecution?.confirmedTaskIds ?? [];
  state.execution = completeGpuCancellation(state.execution);
  markInterruptedTasksWaiting(state, activeIds);
  state.scheduler = {
    ...state.scheduler,
    state: "idle",
    selectedBatchId: null,
    selectedTaskIds: [],
    selectedServerId: null,
    orderCreationAttempted: false,
    drainingRequested: false,
    session: null,
  };
  return writeGenerationPool(state, filePath);
}

export function productionSessionPlan(state = readGenerationPool()) {
  const selected = state.scheduler.selectedTaskIds.map((id) => state.tasks.find((task) => task.id === id)).filter(Boolean) as GenerationTask[];
  if (selected.length) {
    const family = selected[0].generationType;
    const gpuClass = selected[0].requiredGpuClass;
    assertSingleFamilyExecution(selected, family, gpuClass);
  }
  return planSequentialProductionSession(selected.map(groupable));
}

export type RecoveryObservation = {
  providerOrderActive: boolean;
  providerOrderProvisioning?: boolean;
  sshReady?: boolean;
  runtimeReady?: boolean;
  remoteRestoreRunning?: boolean;
  remoteInferenceKind?: "image" | "video" | null;
  localImageCompleted?: boolean;
  localVideoSourceReady?: boolean;
  localMp4Ready?: boolean;
  cleanupRequired?: boolean;
};

export function classifyProductionSessionRecovery(observation: RecoveryObservation): PersistedProductionSession["phase"] {
  if (!observation.providerOrderActive) return observation.cleanupRequired ? "cleanup_pending" : "no_provider_order";
  if (observation.providerOrderProvisioning || !observation.sshReady) return "order_provisioning";
  if (!observation.runtimeReady) return "ssh_ready";
  if (observation.remoteRestoreRunning) return observation.localImageCompleted ? "video_restore_running" : "restore_running";
  if (observation.remoteInferenceKind === "image") return "image_inference_running";
  if (observation.localImageCompleted && observation.remoteInferenceKind === "video") return "video_inference_running";
  if (observation.localVideoSourceReady && !observation.localMp4Ready) return "media_conversion_running";
  if (observation.localImageCompleted) return "image_completed";
  return "runtime_ready";
}

export function persistRecoveredSession(input: {
  sessionId: string;
  providerOrderId: string | null;
  observation: RecoveryObservation;
  activeTaskIds: string[];
  loadedModels?: string[];
  approximateSpendUsd?: number;
  estimatedRemainingMinutes?: number;
}, filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  if (state.scheduler.session?.providerOrderId && input.providerOrderId && state.scheduler.session.providerOrderId !== input.providerOrderId) {
    throw new Error("当前持久化会话已经绑定另一张活动订单；不会重复创建订单。");
  }
  const phase = classifyProductionSessionRecovery(input.observation);
  state.scheduler.session = {
    sessionId: input.sessionId,
    providerOrderId: input.providerOrderId,
    phase,
    activeTaskIds: [...new Set(input.activeTaskIds)],
    loadedModels: [...new Set(input.loadedModels ?? [])],
    approximateSpendUsd: input.approximateSpendUsd ?? 0,
    estimatedRemainingMinutes: input.estimatedRemainingMinutes ?? 0,
    shutdownMode: state.scheduler.session?.shutdownMode ?? null,
    automaticShutdownAt: state.scheduler.session?.automaticShutdownAt ?? null,
    updatedAt: now(),
  };
  state.scheduler.state = phase === "cleanup_pending" ? "cleanup_pending" : input.providerOrderId ? "session_active" : state.scheduler.state;
  if (input.providerOrderId) {
    const activeTasks = input.activeTaskIds.map((id) => state.tasks.find((task) => task.id === id)).filter(Boolean) as GenerationTask[];
    const families = new Set(activeTasks.map((task) => task.generationType));
    const gpuClasses = new Set(activeTasks.map((task) => task.requiredGpuClass));
    if (families.size > 1) throw new Error("恢复会话包含图片和视频并发执行，已拒绝写入。");
    if (gpuClasses.size > 1) throw new Error("恢复会话包含不同 GPU 队列，已拒绝写入。");
    const generationFamily = activeTasks[0]?.generationType ?? null;
    const gpuClass = activeTasks[0]?.requiredGpuClass ?? state.execution.rentedGpuClass;
    const deployedFamily = deployedFamilyFromModelKeys(input.loadedModels ?? []);
    if (deployedFamily === "unknown") throw new Error("恢复会话检测到多个模型族同时部署。");
    state.execution = {
      ...state.execution,
      activity: input.observation.remoteInferenceKind ? "running" : "idle",
      deployedFamily,
      rentedGpuClass: gpuClass,
      providerOrderId: input.providerOrderId,
      runtimeSessionId: input.sessionId,
      activeExecution: generationFamily && gpuClass ? {
        generationFamily,
        gpuClass,
        confirmedTaskIds: activeTasks.map((task) => task.id),
        runtimeSessionId: input.sessionId,
      } : null,
      idleCancelAt: state.scheduler.session.automaticShutdownAt,
      operationId: null,
      updatedAt: now(),
    };
  }
  return writeGenerationPool(state, filePath);
}

export function requestSessionShutdown(mode: "immediate" | "after_current" | "cancel_waiting", filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  if (mode === "cancel_waiting") {
    state.tasks = state.tasks.map((task) => ["pending_confirmation", "waiting_for_batch", "armed", "waiting_for_gpu"].includes(task.status) ? { ...task, status: "cancelled" } : task);
    return writeGenerationPool(state, filePath);
  }
  if (!state.scheduler.session) {
    state.scheduler.state = "idle";
    state.scheduler.drainingRequested = mode === "immediate";
    return writeGenerationPool(state, filePath);
  }
  state.scheduler.session.shutdownMode = mode;
  state.scheduler.session.automaticShutdownAt = mode === "immediate" ? now() : null;
  state.scheduler.drainingRequested = true;
  state.scheduler.state = "draining";
  if (mode === "immediate") {
    state.tasks = state.tasks.map((task) => state.scheduler.session!.activeTaskIds.includes(task.id) && ACTIVE_TASK_STATUSES.has(task.status) ? { ...task, status: "cancel_requested" } : task);
  }
  return writeGenerationPool(state, filePath);
}

export function generationPoolSummary(state = readGenerationPool()) {
  const counts = state.tasks.reduce<Record<string, number>>((acc, task) => ({ ...acc, [task.status]: (acc[task.status] ?? 0) + 1 }), {});
  const selection = selectNextSession(state);
  const selected = state.scheduler.selectedTaskIds.map((id) => state.tasks.find((task) => task.id === id)).filter(Boolean) as GenerationTask[];
  const nextBatch = selection.batches?.[0];
  const estimateTasks = (selection.ready ? selection.tasks : selected).map((task) => ({ generationType: task.generationType, jobForm: task.jobForm }));
  const estimate = estimateProductionSession(estimateTasks, {
    activeSession: Boolean(state.scheduler.session?.providerOrderId),
    imageModelLoaded: state.scheduler.session?.loadedModels.includes(PRODUCTION_IMAGE_MODEL),
    videoModelLoaded: state.scheduler.session?.loadedModels.includes(PRODUCTION_VIDEO_MODEL),
  });
  const policy = loadSchedulerPolicy();
  const readiness = loadProductionReadiness();
  return {
    schedulerState: state.scheduler.state, selectedBatchId: state.scheduler.selectedBatchId, tasks: state.tasks, counts, queuedTaskCount: state.tasks.filter((task) => ["waiting_for_batch", "armed", "waiting_for_gpu"].includes(task.status)).length,
    confirmedQueueCounts: confirmedQueueCounts(state.tasks),
    execution: state.execution,
    selectedTaskIds: selected.map((task) => task.id), selectedTasks: selected, nextBatchTasks: nextBatch?.tasks.map((task) => task.id) ?? [], requiredModelProfile: nextBatch?.modelProfile ?? null,
    acceptableGpuClasses: selection.ready ? selection.acceptableGpuClasses ?? [] : [], estimatedSessionDurationMinutes: estimate.totalSession,
    costEstimate: estimate,
    maximumAcceptableHourlyPrice: MAX_ACCEPTABLE_HOURLY_USD, orderWouldBeCreated: false,
    orderBlockingReason: getCloreDeploymentHold().enabled ? "Clore 部署暂停已开启。" : selection.reason ?? "需要显式恢复命令后才允许创建。",
    imageBatchThreshold: policy.imageOnlyBatchThreshold, videoBatchThreshold: policy.videoI2vBatchThreshold, combinedBatchThreshold: policy.combinedChainBatchThreshold, maximumWaitMinutes: policy.maximumWaitMinutes, mixedBatchEnabled: false,
    tasksNeeded: { image: Math.max(0, generationThreshold("image") - eligibleGroups(state, "image").flat().length), video: Math.max(0, generationThreshold("video") - eligibleGroups(state, "video").flat().length) },
    marketMonitoringActive: ["market_watching", "candidate_found"].includes(state.scheduler.state), nextMarketplaceRequestAt: state.scheduler.nextMarketplaceRequestAt,
    estimatedMaximumSessionCost: 2.5, deploymentHold: getCloreDeploymentHold().enabled, productionModels: productionModelSummary(),
    session: state.scheduler.session,
    sessionPlan: selection.ready ? planSequentialProductionSession(selection.tasks.map(groupable)) : planSequentialProductionSession([]),
    readiness,
    sessionSequence: state.execution.activeExecution
      ? [state.execution.activeExecution.generationFamily === "image" ? "仅部署图片模型并处理所选图片队列" : "仅部署视频模型并处理所选视频队列", "空闲 120 秒后自动退租或由用户手动切换模型"]
      : [],
  };
}
