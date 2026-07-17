import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getCloreDeploymentHold } from "../../../scripts/clore/deployment-hold";
import { modelAvailabilityGate, type ModelAvailabilityRegistry } from "./model-availability";
import { PRODUCTION_GPU_CLASSES, PRODUCTION_IMAGE_MODEL, PRODUCTION_VIDEO_MODEL, productionModelSummary } from "./production-models";

export type GenerationType = "image" | "video";
export type GenerationPriority = "normal" | "immediate";
export type GenerationTaskStatus =
  | "pending_confirmation"
  | "waiting_for_batch"
  | "armed"
  | "waiting_for_gpu"
  | "deploying"
  | "restoring_models"
  | "generating"
  | "syncing"
  | "completed"
  | "failed"
  | "cancelled";
export type SchedulerState = "idle" | "batch_ready" | "market_watching" | "candidate_found" | "order_pending" | "session_active" | "draining" | "completed" | "blocked_by_provider";

export type GenerationTask = {
  id: string;
  generationType: GenerationType;
  prompt: string;
  modelProfile: string;
  gpuPreference: string[];
  priority: GenerationPriority;
  status: GenerationTaskStatus;
  createdAt: string;
  confirmedAt: string | null;
  batchId: string | null;
  estimatedVram: number;
  outputMetadata: Record<string, string | number | boolean | null>;
};

export type RejectedHost = { serverId: string; reasons: string[]; rejectedAt: string };
export type GenerationPoolState = {
  schemaVersion: 1;
  tasks: GenerationTask[];
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

export const GENERATION_POOL_PATH = path.join(process.cwd(), ".secrets", "generation-pool-state.json");
export const MAX_ACCEPTABLE_HOURLY_USD = 0.7;

const PRODUCTION_MODELS = new Set([PRODUCTION_IMAGE_MODEL, PRODUCTION_VIDEO_MODEL]);

function now() { return new Date().toISOString(); }

export function generationThreshold(type: GenerationType, value?: string) {
  const fallback = type === "image" ? 3 : 2;
  const parsed = Number(value ?? process.env[type === "image" ? "GENERATION_IMAGE_BATCH_THRESHOLD" : "GENERATION_VIDEO_BATCH_THRESHOLD"]);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 50 ? parsed : fallback;
}

export function acceptableGpuClasses(type: GenerationType, modelProfile: string) {
  if (type === "image" && [PRODUCTION_IMAGE_MODEL, "flux2-klein-4b"].includes(modelProfile)) return [...PRODUCTION_GPU_CLASSES];
  if (type === "video" && [PRODUCTION_VIDEO_MODEL, "wan22-ti2v-5b"].includes(modelProfile)) return [...PRODUCTION_GPU_CLASSES];
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
    schemaVersion: 1,
    tasks: [],
    scheduler: { state: "idle", selectedBatchId: null, selectedTaskIds: [], watchStartedAt: null, lastMarketplaceRequestAt: null, nextMarketplaceRequestAt: null, selectedServerId: null, rejectedHosts: [], orderCreationAttempted: false, drainingRequested: false, updatedAt: now() },
  };
}

export function readGenerationPool(filePath = GENERATION_POOL_PATH): GenerationPoolState {
  if (!existsSync(filePath)) return defaultGenerationPoolState();
  try {
    const state = JSON.parse(readFileSync(filePath, "utf8")) as GenerationPoolState;
    if (state.schemaVersion !== 1 || !Array.isArray(state.tasks) || !state.scheduler) throw new Error("invalid");
    return state;
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
  const allowed: string[] = acceptableGpuClasses(input.generationType, input.modelProfile);
  const requested = input.gpuPreference?.filter((gpu) => allowed.includes(gpu)) ?? [];
  const gpuPreference = requested.length ? [...new Set(requested)] : allowed;
  return {
    id: input.id ?? randomUUID(), generationType: input.generationType, prompt: input.prompt.trim(), modelProfile: input.modelProfile,
    gpuPreference, priority: input.priority ?? "normal", status: input.status ?? "pending_confirmation", createdAt: input.createdAt ?? now(), confirmedAt: input.confirmedAt ?? null,
    batchId: input.batchId ?? null, estimatedVram: input.estimatedVram ?? (input.generationType === "image" ? 20 : 24), outputMetadata: input.outputMetadata ?? {},
  };
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
  else state.tasks = state.tasks.map((task) => !selected.has(task.id) ? task : action === "cancel" ? { ...task, status: "cancelled" as const } : { ...task, priority: action === "immediate" ? "immediate" as const : task.priority, status: action === "immediate" ? "armed" as const : "waiting_for_batch" as const, confirmedAt: task.confirmedAt ?? now() });
  return writeGenerationPool(state, filePath);
}

export function setGenerationTaskStatus(taskIds: string[], status: GenerationTaskStatus, outputMetadata: GenerationTask["outputMetadata"] = {}, filePath = GENERATION_POOL_PATH) {
  const state = readGenerationPool(filePath);
  const selected = new Set(taskIds);
  state.tasks = state.tasks.map((task) => selected.has(task.id) ? { ...task, status, outputMetadata: { ...task.outputMetadata, ...outputMetadata } } : task);
  return writeGenerationPool(state, filePath);
}

export function armSpecificGenerationBatch(taskIds: string[], batchId: string, filePath = GENERATION_POOL_PATH, availabilityRegistry?: ModelAvailabilityRegistry) {
  if (!/^[A-Za-z0-9_-]{3,120}$/.test(batchId)) throw new Error("固定批次编号格式无效。");
  const state = readGenerationPool(filePath);
  const uniqueIds = [...new Set(taskIds)];
  const tasks = uniqueIds.map((id) => state.tasks.find((task) => task.id === id)).filter(Boolean) as GenerationTask[];
  if (tasks.length !== uniqueIds.length || tasks.length === 0) throw new Error("固定批次任务不存在或为空。");
  for (const task of tasks) {
    const gate = modelAvailabilityGate(task.modelProfile, availabilityRegistry);
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
  const tasks = state.tasks.filter((task) => task.generationType === type && ["waiting_for_batch", "armed", "waiting_for_gpu"].includes(task.status));
  const groups = new Map<string, GenerationTask[]>();
  for (const task of tasks) groups.set(task.modelProfile, [...(groups.get(task.modelProfile) ?? []), task]);
  return [...groups.values()].map((items) => items.sort((left, right) => left.priority === right.priority ? Date.parse(left.createdAt) - Date.parse(right.createdAt) : left.priority === "immediate" ? -1 : 1));
}

export function selectNextSession(state: GenerationPoolState) {
  const batches: Array<{ generationType: GenerationType; modelProfile: string; tasks: GenerationTask[]; acceptableGpuClasses: string[]; estimatedVram: number }> = [];
  for (const type of ["image", "video"] as const) {
    const ready = eligibleGroups(state, type).find((group) => group.some((task) => task.priority === "immediate") || group.length >= generationThreshold(type));
    if (!ready) continue;
    const gate = modelAvailabilityGate(ready[0].modelProfile);
    if (!gate.allowed) return { ready: false, reason: gate.reason, batches: [], tasks: [] as GenerationTask[] };
    const compatibleGpuClasses = ready.map((task) => new Set(task.gpuPreference.length ? task.gpuPreference : acceptableGpuClasses(type, task.modelProfile))).reduce((left, right) => new Set([...left].filter((gpu) => right.has(gpu))));
    batches.push({ generationType: type, modelProfile: ready[0].modelProfile, tasks: ready, acceptableGpuClasses: [...compatibleGpuClasses], estimatedVram: Math.max(...ready.map((task) => task.estimatedVram)) });
  }
  if (batches.length === 0) return { ready: false, reason: "普通图片需满 3 个、普通视频需满 2 个；立即任务可直接触发。", batches, tasks: [] as GenerationTask[] };
  const compatible = batches.map((batch) => new Set(batch.acceptableGpuClasses)).reduce((left, right) => new Set([...left].filter((value) => right.has(value))));
  if (compatible.size === 0) return { ready: false, reason: "图片与视频批次没有共同兼容的显卡类别。", batches: [], tasks: [] as GenerationTask[] };
  return { ready: true, reason: null, batches, tasks: batches.flatMap((batch) => batch.tasks), acceptableGpuClasses: [...compatible] };
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

export function generationPoolSummary(state = readGenerationPool()) {
  const counts = state.tasks.reduce<Record<string, number>>((acc, task) => ({ ...acc, [task.status]: (acc[task.status] ?? 0) + 1 }), {});
  const selection = selectNextSession(state);
  const selected = state.scheduler.selectedTaskIds.map((id) => state.tasks.find((task) => task.id === id)).filter(Boolean) as GenerationTask[];
  const nextBatch = selection.batches?.[0];
  const estimatedMinutes = selection.batches?.reduce((total, batch) => total + (batch.generationType === "image" ? 15 + batch.tasks.length * 6 : 20 + batch.tasks.length * 20), 0) + ((selection.batches?.length ?? 0) > 1 ? 5 : 0);
  return {
    schedulerState: state.scheduler.state, selectedBatchId: state.scheduler.selectedBatchId, tasks: state.tasks, counts, queuedTaskCount: state.tasks.filter((task) => ["waiting_for_batch", "armed", "waiting_for_gpu"].includes(task.status)).length,
    selectedTaskIds: selected.map((task) => task.id), selectedTasks: selected, nextBatchTasks: nextBatch?.tasks.map((task) => task.id) ?? [], requiredModelProfile: nextBatch?.modelProfile ?? null,
    acceptableGpuClasses: selection.ready ? selection.acceptableGpuClasses ?? [] : [], estimatedSessionDurationMinutes: typeof estimatedMinutes === "number" && Number.isFinite(estimatedMinutes) ? estimatedMinutes : 0,
    maximumAcceptableHourlyPrice: MAX_ACCEPTABLE_HOURLY_USD, orderWouldBeCreated: false,
    orderBlockingReason: getCloreDeploymentHold().enabled ? "Clore 部署暂停已开启。" : selection.reason ?? "需要显式恢复命令后才允许创建。",
    imageBatchThreshold: generationThreshold("image"), videoBatchThreshold: generationThreshold("video"), mixedBatchEnabled: false,
    tasksNeeded: { image: Math.max(0, generationThreshold("image") - eligibleGroups(state, "image").flat().length), video: Math.max(0, generationThreshold("video") - eligibleGroups(state, "video").flat().length) },
    marketMonitoringActive: ["market_watching", "candidate_found"].includes(state.scheduler.state), nextMarketplaceRequestAt: state.scheduler.nextMarketplaceRequestAt,
    estimatedMaximumSessionCost: 2.5, deploymentHold: getCloreDeploymentHold().enabled, productionModels: productionModelSummary(),
    sessionSequence: selection.batches?.length === 2 ? ["图片批次", "卸载图片模型", "视频批次", "结束会话"] : selection.batches?.length === 1 ? [selection.batches[0].generationType === "image" ? "图片批次" : "视频批次", "结束会话"] : [],
  };
}
