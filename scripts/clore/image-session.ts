import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import type { LocalImageTask } from "../../src/lib/image-generation/local-image-task-store";
import { classifyImageGpu, type ImageGpuClass } from "../../src/lib/image-generation/flux-stack";
import { assertImageTaskLoras, normalizeNegativePrompt } from "../../src/lib/image-generation/image-loras";
import { requiresManualInferenceRecovery } from "../../src/lib/image-generation/image-task-retry-policy";
import type { EligibleImageTask } from "./run-image-e2e";

export const IMAGE_SESSION_LIMITS = { maxBatchSize: 8, maxHours: 4, maxHourlyUsd: .30, maxCostUsd: 1.50, creationFeeUsd: .10, minimumWalletReserveUsd: 1.00, idleMinutes: 15, normalGenerationMinutes: 12, cleanupMinutes: 5 } as const;
export type ImageSessionPlan = { selectedTaskIds: string[]; selectedDimensions: Array<{ taskId: string; width: number; height: number }>; count: number; eligibleCount: number; estimatedMaximumSessionHours: number; selectedGpuClass: "RTX 4090" | "RTX 5090"; selectedGpuModel: string | null; modelSetIdentity: "fluxed-up-10.2-five-file"; oneModelStageServesAll: boolean; selectedHourlyUsd: number; projectedRentalCostUsd: number; projectedCreationFeeUsd: number; projectedProviderCostCeilingUsd: number; minimumWalletReserveUsd: number; walletBalanceUsd: number | null; activeOrderCount: number; executionEligible: boolean };
export type ImageTaskTerminal = "completed" | "failed" | "not_started" | "ambiguous";
export type ImageSessionReceipt = { schemaVersion: 1; sessionId: string; orderId: string | null; selectedTaskIds: string[]; currentTaskId: string | null; modelStage: "not_started" | "succeeded" | "failed"; tasks: Record<string, { terminal: ImageTaskTerminal; inferenceState: "not_started" | "submitting" | "accepted" | "succeeded" | "failed" }>; completedTaskCount: number; failedTaskCount: number; timestamps: Record<string, string>; idleDeadlineAt: string; hardDeadlineAt: string; cancellationState: "not_started" | "cancelled"; firstInfrastructureError: string | null };

export class DeterministicTaskFailure extends Error { readonly scope = "task" as const; }
export class AmbiguousInferenceFailure extends Error { readonly scope = "ambiguous" as const; }
export class FrozenImageSessionMembershipChangedError extends Error {
  readonly code = "image_session_planned_task_changed" as const;
  constructor(readonly taskId: string) { super(`${"image_session_planned_task_changed"}:${taskId}`); }
}

function positiveInteger(value: unknown) { return Number.isInteger(value) && Number(value) > 0; }
function taskPriority(task: LocalImageTask) { const value = String(task.priority ?? "").toLowerCase(); return value === "urgent" || value === "immediate" ? 0 : 1; }
function validExtendedTaskSettings(task: LocalImageTask) {
  try {
    normalizeNegativePrompt(task.negativePrompt);
    if (task.loras !== undefined) assertImageTaskLoras(task.loras);
    if (task.loraSelections !== undefined && task.loras === undefined) return false;
    return true;
  } catch {
    return false;
  }
}
export function isSessionEligibleTask(task: LocalImageTask): task is EligibleImageTask {
  const gpuClass = classifyImageGpu(Number(task.width), Number(task.height));
  return task.status === "waiting_for_gpu" && validExtendedTaskSettings(task) && !requiresManualInferenceRecovery(task) && task.mode === "text_generation" && task.referenceImage === null && !task.result && !task.localClaim && typeof task.prompt === "string" && task.prompt.trim().length > 0 &&
    positiveInteger(task.width) && positiveInteger(task.height) && gpuClass !== null && task.gpuClass === gpuClass &&
    positiveInteger(task.steps) && Number(task.steps) >= 25 && Number(task.steps) <= 40 && Number.isFinite(task.cfg) && Number(task.cfg) >= 3.5 && Number(task.cfg) <= 5 && Number.isFinite(task.loraStrength) && Number(task.loraStrength) >= .6 && Number(task.loraStrength) <= 1.1 && Number.isInteger(task.seed) && Number(task.seed) >= 0 && Number(task.seed) <= 2_147_483_647 && (task.sampler === "Euler" || task.sampler === "FlowMatch") && !Number.isNaN(Date.parse(String(task.createdAt)));
}

export type ImageSessionPlannerInput = { maxBatchSize?: number; activeOrderCount?: number; selectedHourlyUsd?: number; walletBalanceUsd?: number | null; gpuClass?: ImageGpuClass; requestedTaskIds?: readonly string[] };
export type ExecutableImageBatch = { plannedTaskIds: string[]; executableCount: number; excludedInconsistentTaskIds: string[] };

function planFromSelected(selected: readonly EligibleImageTask[], eligibleCount: number, selectedClass: ImageGpuClass | null, input: Omit<ImageSessionPlannerInput, "requestedTaskIds">): ImageSessionPlan {
  const hours = selected.length ? Math.min(IMAGE_SESSION_LIMITS.maxHours, .75 + selected.length * .35) : 0;
  const activeOrderCount = Math.max(0, Math.floor(input.activeOrderCount ?? 0));
  const selectedHourlyUsd = Number(input.selectedHourlyUsd ?? IMAGE_SESSION_LIMITS.maxHourlyUsd);
  const projectedRentalCostUsd = Number((hours * selectedHourlyUsd).toFixed(2));
  const projectedProviderCostCeilingUsd = Number((projectedRentalCostUsd + IMAGE_SESSION_LIMITS.creationFeeUsd).toFixed(2));
  const walletBalanceUsd = input.walletBalanceUsd ?? null;
  const executionEligible = selected.length > 0 && activeOrderCount === 0 && selectedHourlyUsd <= IMAGE_SESSION_LIMITS.maxHourlyUsd && projectedProviderCostCeilingUsd <= IMAGE_SESSION_LIMITS.maxCostUsd && (walletBalanceUsd === null || walletBalanceUsd - projectedProviderCostCeilingUsd >= IMAGE_SESSION_LIMITS.minimumWalletReserveUsd);
  return { selectedTaskIds: selected.map((task) => task.id), selectedDimensions: selected.map((task) => ({ taskId: task.id, width: task.width, height: task.height })), count: selected.length, eligibleCount, estimatedMaximumSessionHours: Number(hours.toFixed(2)), selectedGpuClass: selectedClass === "rtx5090" ? "RTX 5090" : "RTX 4090", selectedGpuModel: null, modelSetIdentity: "fluxed-up-10.2-five-file", oneModelStageServesAll: selected.length > 0, selectedHourlyUsd, projectedRentalCostUsd, projectedCreationFeeUsd: IMAGE_SESSION_LIMITS.creationFeeUsd, projectedProviderCostCeilingUsd, minimumWalletReserveUsd: IMAGE_SESSION_LIMITS.minimumWalletReserveUsd, walletBalanceUsd, activeOrderCount, executionEligible };
}

/** The start action calls this once.  Its result is the canonical batch order. */
export function planImageSession(tasks: readonly LocalImageTask[], input: ImageSessionPlannerInput = {}): ImageSessionPlan {
  const maxBatchSize = Math.max(1, Math.min(IMAGE_SESSION_LIMITS.maxBatchSize, Math.floor(input.maxBatchSize ?? IMAGE_SESSION_LIMITS.maxBatchSize)));
  const requested = input.requestedTaskIds ? [...new Set(input.requestedTaskIds.map(String).filter(Boolean))] : null;
  const requestedSet = requested ? new Set(requested) : null;
  const allEligible = tasks.filter((task) => !requestedSet || requestedSet.has(task.id)).filter(isSessionEligibleTask).sort((a, b) => taskPriority(a) - taskPriority(b) || Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt)) || a.id.localeCompare(b.id));
  const firstClass = allEligible[0]?.gpuClass;
  const selectedClass: ImageGpuClass | null = input.gpuClass ?? (firstClass === "rtx4090" || firstClass === "rtx5090" ? firstClass : null);
  const eligible = selectedClass ? allEligible.filter((task) => task.gpuClass === selectedClass) : [];
  return planFromSelected(eligible.slice(0, maxBatchSize), eligible.length, selectedClass, input);
}

/** Shared source for Studio counts, the start-button payload, and batch freezing. */
export function planExecutableImageBatch(tasks: readonly LocalImageTask[], gpuClass: ImageGpuClass): ExecutableImageBatch {
  const classTasks = tasks.filter((task) => task.gpuClass === gpuClass);
  const plan = planImageSession(classTasks, { requestedTaskIds: classTasks.map((task) => task.id), gpuClass, maxBatchSize: IMAGE_SESSION_LIMITS.maxBatchSize, activeOrderCount: 0 });
  return {
    plannedTaskIds: plan.selectedTaskIds,
    executableCount: plan.count,
    excludedInconsistentTaskIds: classTasks.filter((task) => task.status === "waiting_for_gpu" && !isSessionEligibleTask(task)).map((task) => task.id),
  };
}

/**
 * Rehydrates a persisted canonical batch without sorting or selecting again.
 * It is intentionally the only later-stage task-store read permitted for a
 * frozen batch, and fails closed when membership or eligibility changed.
 */
export function hydrateFrozenImageSessionPlan(tasks: readonly LocalImageTask[], plannedTaskIds: readonly string[], input: Omit<ImageSessionPlannerInput, "requestedTaskIds" | "maxBatchSize"> = {}): ImageSessionPlan {
  const ids = plannedTaskIds.map(String).filter(Boolean);
  if (!ids.length || ids.length > IMAGE_SESSION_LIMITS.maxBatchSize || new Set(ids).size !== ids.length) throw new Error("image_session_invalid_frozen_task_ids");
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const selected = ids.map((taskId) => {
    const task = byId.get(taskId);
    if (!task || !isSessionEligibleTask(task)) throw new FrozenImageSessionMembershipChangedError(taskId);
    return task;
  });
  const firstClass = selected[0]?.gpuClass;
  const selectedClass: ImageGpuClass | null = input.gpuClass ?? (firstClass === "rtx4090" || firstClass === "rtx5090" ? firstClass : null);
  if (!selectedClass || selected.some((task) => task.gpuClass !== selectedClass)) throw new FrozenImageSessionMembershipChangedError(selected.find((task) => task.gpuClass !== selectedClass)?.id ?? ids[0]);
  return planFromSelected(selected, selected.length, selectedClass, input);
}

export function formatImageSessionPlanChinese(plan: ImageSessionPlan) {
  return [
    `可生成任务数量：${plan.eligibleCount}`, `本次选择任务数量：${plan.count}`, `预计使用的GPU：${plan.selectedGpuClass}`, `是否需要新租用：${plan.count > 0 && plan.activeOrderCount === 0 ? "是（仅计划）" : "否"}`,
    `预计最高费用：$${plan.projectedProviderCostCeilingUsd.toFixed(2)}`, `模型是否可共享：${plan.oneModelStageServesAll ? "是" : "否"}`, `当前是否存在活动订单：${plan.activeOrderCount > 0 ? "是" : "否"}`, `是否满足执行条件：${plan.executionEligible ? "是（仍需实时复核）" : "否"}`,
  ].join("\n");
}

/** Cost-aware operator output; it deliberately contains no prompt or endpoint. */
export function formatImageSessionCostPlanChinese(plan: ImageSessionPlan) {
  return [
    `可生成任务数量：${plan.eligibleCount}`,
    `本次选择任务数量：${plan.count}`,
    `预计使用的GPU：${plan.selectedGpuClass}`,
    `是否需要新租用：${plan.count > 0 && plan.activeOrderCount === 0 ? "是（仅计划）" : "否"}`,
    `预计租用费用：$${plan.projectedRentalCostUsd.toFixed(2)}`,
    `预计创建费用：$${plan.projectedCreationFeeUsd.toFixed(2)}`,
    `预计总费用：$${plan.projectedProviderCostCeilingUsd.toFixed(2)}`,
    `执行后最低保留余额要求：$${plan.minimumWalletReserveUsd.toFixed(2)}`,
    `模型是否可共享：${plan.oneModelStageServesAll ? "是" : "否"}`,
    `当前是否存在活动订单：${plan.activeOrderCount > 0 ? "是" : "否"}`,
    `是否满足执行条件：${plan.executionEligible ? "是（仍需实时复核）" : "否"}`,
  ].join("\n");
}

export function writeImageSessionReceipt(file: string, value: ImageSessionReceipt) {
  mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; const descriptor = openSync(temporary, "w");
  try { writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, file);
}
export function readImageSessionReceipt(file: string) { try { return JSON.parse(readFileSync(file, "utf8")) as ImageSessionReceipt; } catch { return null; } }

export type ImageSessionDeps = {
  now: () => string; nowMs: () => number; persist: (value: ImageSessionReceipt) => void; load: () => ImageSessionReceipt | null; reconcileZeroActiveOrders: () => Promise<void>; preflight: (taskIds: string[]) => Promise<void>; createOrder: () => Promise<{ orderId: string }>; armWatchdog: (orderId: string) => Promise<void>; prepareRuntimeOnce: () => Promise<void>; verifyModelsOnce: () => Promise<void>;
  readEligible: (taskId: string) => Promise<EligibleImageTask>; claim: (task: EligibleImageTask) => Promise<{ token: string }>; startHeartbeat: (taskId: string, token: string) => { stop: () => void; assertHealthy: () => void }; writeTaskReceipt: (taskId: string, state: "submitting" | "accepted" | "succeeded" | "failed") => Promise<void>; submitInference: (task: EligibleImageTask) => Promise<void>; pollAndFinalize: (task: EligibleImageTask, token: string, orderId: string) => Promise<void>; failTask: (taskId: string, token: string, error: string) => Promise<void>; cancelExactOrder: (orderId: string) => Promise<void>; confirmNoActiveOrders: () => Promise<void>; disarmWatchdog: () => Promise<void>;
};

function initial(plan: ImageSessionPlan, sessionId: string, now: string): ImageSessionReceipt {
  return { schemaVersion: 1, sessionId, orderId: null, selectedTaskIds: plan.selectedTaskIds, currentTaskId: null, modelStage: "not_started", tasks: Object.fromEntries(plan.selectedTaskIds.map((id) => [id, { terminal: "not_started", inferenceState: "not_started" }])), completedTaskCount: 0, failedTaskCount: 0, timestamps: { created: now }, idleDeadlineAt: new Date(Date.parse(now) + IMAGE_SESSION_LIMITS.idleMinutes * 60_000).toISOString(), hardDeadlineAt: new Date(Date.parse(now) + IMAGE_SESSION_LIMITS.maxHours * 3_600_000).toISOString(), cancellationState: "not_started", firstInfrastructureError: null };
}
function isAmbiguous(receipt: ImageSessionReceipt) { return Object.values(receipt.tasks).some((task) => task.inferenceState === "submitting" || task.inferenceState === "accepted"); }
function clean(error: unknown) { return String(error instanceof Error ? error.message : error).replace(/(token|secret|credential|authorization|prompt)\s*[:=]\s*\S+/gi, "$1=<redacted>").slice(0, 500); }

/** Dependency-injected future live semantics. This module never imports a provider client. */
export async function runImageSession(input: { sessionId: string; plan: ImageSessionPlan; normalGenerationMs?: number; cleanupMs?: number }, deps: ImageSessionDeps) {
  const receipt = deps.load() ?? initial(input.plan, input.sessionId, deps.now()); if (isAmbiguous(receipt)) throw new AmbiguousInferenceFailure("image_session_resume_ambiguous_inference");
  let orderId: string | null = receipt.orderId; let infrastructureError: unknown;
  const persist = () => deps.persist(structuredClone(receipt));
  const touchIdle = () => { receipt.idleDeadlineAt = new Date(deps.nowMs() + IMAGE_SESSION_LIMITS.idleMinutes * 60_000).toISOString(); };
  try {
    await deps.reconcileZeroActiveOrders(); if (orderId) throw new Error("image_session_resume_existing_order_requires_manual_reconciliation"); await deps.preflight(receipt.selectedTaskIds); const created = await deps.createOrder(); orderId = created.orderId; receipt.orderId = orderId; receipt.timestamps.order_created = deps.now(); persist(); await deps.armWatchdog(orderId);
    await deps.prepareRuntimeOnce(); await deps.verifyModelsOnce(); receipt.modelStage = "succeeded"; receipt.timestamps.models_verified = deps.now(); touchIdle(); persist();
    for (const taskId of receipt.selectedTaskIds) {
      const remaining = Math.min(Date.parse(receipt.idleDeadlineAt), Date.parse(receipt.hardDeadlineAt)) - deps.nowMs(); const required = input.normalGenerationMs ?? IMAGE_SESSION_LIMITS.normalGenerationMinutes * 60_000;
      if (remaining < required + (input.cleanupMs ?? IMAGE_SESSION_LIMITS.cleanupMinutes * 60_000)) { receipt.timestamps.draining = deps.now(); persist(); break; }
      let task: EligibleImageTask; try { task = await deps.readEligible(taskId); } catch (error) { if (!(error instanceof DeterministicTaskFailure)) throw error; receipt.tasks[taskId].terminal = "failed"; receipt.failedTaskCount += 1; touchIdle(); persist(); continue; }
      let token: string | null = null; let heartbeat: ReturnType<ImageSessionDeps["startHeartbeat"]> | null = null;
      try {
        receipt.currentTaskId = taskId; persist(); const claim = await deps.claim(task); token = claim.token; heartbeat = deps.startHeartbeat(taskId, token); heartbeat.assertHealthy();
        receipt.tasks[taskId].inferenceState = "submitting"; persist(); await deps.writeTaskReceipt(taskId, "submitting"); await deps.submitInference(task);
        receipt.tasks[taskId].inferenceState = "accepted"; persist(); await deps.writeTaskReceipt(taskId, "accepted"); await deps.pollAndFinalize(task, token, orderId);
        receipt.tasks[taskId] = { terminal: "completed", inferenceState: "succeeded" }; receipt.completedTaskCount += 1; await deps.writeTaskReceipt(taskId, "succeeded"); touchIdle(); persist();
      } catch (error) {
        if (error instanceof DeterministicTaskFailure && token) { await deps.failTask(taskId, token, clean(error)); receipt.tasks[taskId] = { terminal: "failed", inferenceState: "failed" }; receipt.failedTaskCount += 1; await deps.writeTaskReceipt(taskId, "failed"); touchIdle(); persist(); continue; }
        if (receipt.tasks[taskId].inferenceState === "submitting" || receipt.tasks[taskId].inferenceState === "accepted") receipt.tasks[taskId].terminal = "ambiguous";
        persist(); throw error;
      } finally { heartbeat?.stop(); receipt.currentTaskId = null; persist(); }
    }
  } catch (error) { infrastructureError = error; receipt.firstInfrastructureError = clean(error); if (receipt.modelStage === "not_started") receipt.modelStage = "failed"; persist(); throw error;
  } finally {
    if (orderId) { await deps.cancelExactOrder(orderId); await deps.confirmNoActiveOrders(); await deps.confirmNoActiveOrders(); receipt.cancellationState = "cancelled"; receipt.timestamps.cancelled = deps.now(); persist(); }
    await deps.disarmWatchdog(); if (infrastructureError && isAmbiguous(receipt)) throw infrastructureError;
  }
  return receipt;
}
