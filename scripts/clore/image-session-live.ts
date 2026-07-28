/** One-order, sequential one-to-eight-task image session. The CLI gates provider mutation. */
import { randomUUID } from "node:crypto";
import { listImageTasks } from "../../src/lib/image-generation/local-image-task-store";
import { hydrateFrozenImageSessionPlan, planImageSession, type ImageSessionPlan } from "./image-session";
import { cleanupLiveSession, createLiveSessionOrder, installModelsOnce, invokeStage, submitTaskInference, waitForAgentIdle, writeSessionReceipt, writeTaskReceipt, type CandidateAttemptEvent, type ImmutableRuntime, type MarketWaitEvent, type OwnedSessionOrder } from "./image-live-runtime";
import { resolveExactEligibleImageTask, sanitizeAgentStageAcceptanceEvidence, type AgentStageAcceptanceEvidence } from "./run-image-e2e";
import { RTX4090_GOLDEN_DEPLOYMENT_PROFILE, rtx4090GoldenDeploymentFingerprint } from "../image-executor/rtx4090-golden-deployment-profile";
import type { MarketplaceReadEvidence } from "./live";

export type SessionTaskState = { terminal: "not_started" | "completed" | "failed" | "ambiguous"; inferenceState: "not_started" | "submitting" | "accepted" | "succeeded" | "failed"; stageRunId: string | null };
export type SessionReceipt = { schemaVersion: 1; sessionId: string; sessionState: "planned" | "starting" | "running" | "draining" | "completed" | "failed" | "ambiguous"; orderId: string | null; serverId: string | null; endpointHostname: string | null; deploymentProfile: { id: string; fingerprint: string; image: string; commit: string; agentSourceSha256: string; bootstrapTemplateSha256: string; controllerSha256: string; agentSha256: string; workflowSha256: string }; requestedGpuClass: "RTX 4090" | "RTX 5090"; selectedGpuModel: string | null; selectedHourlyUsd: number; projectedRentalCostUsd: number; projectedCreationFeeUsd: number; projectedProviderCostCeilingUsd: number; selectedTaskIds: string[]; selectedDimensions: Array<{ taskId: string; width: number; height: number }>; currentTaskId: string | null; modelStage: { state: "not_started" | "succeeded" | "failed"; stageRunId: string | null }; tasks: Record<string, SessionTaskState>; completedCount: number; failedCount: number; cancellationState: string; cleanupErrors: string[]; cleanupEvidence: { zeroActiveOrderConfirmations: number; watchdogDisarmed: boolean; localOrderStateCleared: boolean } | null; agentAcceptanceEvidence: AgentStageAcceptanceEvidence[]; agentAcceptanceFailure: ReturnType<typeof sanitizeAgentStageAcceptanceEvidence>; firstError: string | null; timestamps: Record<string, string>; candidateAttempts: CandidateAttemptEvent[]; marketplaceEvidence: MarketplaceReadEvidence[] };
type LiveSessionReceipt = SessionReceipt & { currentRemoteStage?: string; currentStageRunId?: string };
const stamp = () => new Date().toISOString();
const sanitizedError = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/(bearer\s+)[^\s]+/gi, "$1<redacted>").slice(0, 700);
const deterministic = (error: unknown) => /result_dimensions_mismatch|inference_stage_failed:.*(?:validation|dimensions)/i.test(sanitizedError(error));

export function assertStageGpuMatches(selectedGpuClass: "RTX 4090" | "RTX 5090", data: Record<string, unknown> | undefined) {
  const nvidiaSmi = data?.nvidia_smi as {
    output?: unknown;
    stdout?: unknown;
    first_output_lines?: unknown;
    final_output_lines?: unknown;
  } | undefined;
  const boundedText = (value: unknown, maximum: number, field: string) => {
    if (value === undefined) return "";
    if (typeof value !== "string" || value.length > maximum) throw new Error(`gpu_stage_output_contract_invalid:${field}`);
    return value;
  };
  const boundedLines = (value: unknown, maximumLines: number, field: string) => {
    if (value === undefined) return [] as string[];
    if (!Array.isArray(value) || value.length > maximumLines || value.some((line) => typeof line !== "string" || line.length > 500)) {
      throw new Error(`gpu_stage_output_contract_invalid:${field}`);
    }
    return value as string[];
  };
  const outputLines = [
    boundedText(nvidiaSmi?.output, 6_000, "output"),
    boundedText(nvidiaSmi?.stdout, 6_000, "stdout"),
    ...boundedLines(nvidiaSmi?.first_output_lines, 30, "first_output_lines"),
    ...boundedLines(nvidiaSmi?.final_output_lines, 120, "final_output_lines"),
  ];
  const hardware = outputLines.join("\n");
  const expected = selectedGpuClass === "RTX 5090" ? /RTX\s*5090/i : /RTX\s*4090/i;
  if (!expected.test(hardware)) throw new Error(`gpu_hardware_mismatch:expected_${selectedGpuClass.replace(" ", "_")}`);
}

function initial(sessionId: string, plan: ReturnType<typeof planImageSession>): SessionReceipt { return { schemaVersion: 1, sessionId, sessionState: "planned", orderId: null, serverId: null, endpointHostname: null, deploymentProfile: { id: RTX4090_GOLDEN_DEPLOYMENT_PROFILE.id, fingerprint: rtx4090GoldenDeploymentFingerprint(), image: RTX4090_GOLDEN_DEPLOYMENT_PROFILE.image, commit: RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable.commit, agentSourceSha256: RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable.agentSourceSha256, bootstrapTemplateSha256: RTX4090_GOLDEN_DEPLOYMENT_PROFILE.bootstrapTemplateSha256, controllerSha256: RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable.controllerSha256, agentSha256: RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable.agentSha256, workflowSha256: RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable.workflowSha256 }, requestedGpuClass: plan.selectedGpuClass, selectedGpuModel: plan.selectedGpuModel, selectedHourlyUsd: plan.selectedHourlyUsd, projectedRentalCostUsd: plan.projectedRentalCostUsd, projectedCreationFeeUsd: plan.projectedCreationFeeUsd, projectedProviderCostCeilingUsd: plan.projectedProviderCostCeilingUsd, selectedTaskIds: plan.selectedTaskIds, selectedDimensions: plan.selectedDimensions, currentTaskId: null, modelStage: { state: "not_started", stageRunId: null }, tasks: Object.fromEntries(plan.selectedTaskIds.map((id) => [id, { terminal: "not_started", inferenceState: "not_started", stageRunId: null }])), completedCount: 0, failedCount: 0, cancellationState: "not_started", cleanupErrors: [], cleanupEvidence: null, agentAcceptanceEvidence: [], agentAcceptanceFailure: null, firstError: null, timestamps: { planned: stamp() }, candidateAttempts: [], marketplaceEvidence: [] }; }
function persist(receipt: SessionReceipt) { writeSessionReceipt(receipt); }
function taskReceipt(receipt: SessionReceipt, taskId: string, patch: Record<string, unknown>) { writeTaskReceipt(receipt.sessionId, taskId, { taskId, inferenceState: receipt.tasks[taskId].inferenceState, stageRunId: receipt.tasks[taskId].stageRunId, timestamps: { updatedAt: stamp() }, ...patch }); }
function persistAgentAcceptanceEvidence(receipt: SessionReceipt, evidence: AgentStageAcceptanceEvidence) { receipt.agentAcceptanceEvidence = [...receipt.agentAcceptanceEvidence, evidence].slice(-24); persist(receipt); }
export function applySelectedPlanToReceipt(
  receipt: Pick<SessionReceipt, "selectedGpuModel" | "selectedHourlyUsd" | "projectedRentalCostUsd" | "projectedCreationFeeUsd" | "projectedProviderCostCeilingUsd">,
  plan: Pick<ImageSessionPlan, "selectedGpuModel" | "selectedHourlyUsd" | "projectedRentalCostUsd" | "projectedCreationFeeUsd" | "projectedProviderCostCeilingUsd">,
) {
  receipt.selectedGpuModel = plan.selectedGpuModel;
  receipt.selectedHourlyUsd = plan.selectedHourlyUsd;
  receipt.projectedRentalCostUsd = plan.projectedRentalCostUsd;
  receipt.projectedCreationFeeUsd = plan.projectedCreationFeeUsd;
  receipt.projectedProviderCostCeilingUsd = plan.projectedProviderCostCeilingUsd;
}

export async function runLiveImageSession(input: { taskIds: string[]; immutable: ImmutableRuntime; execute: boolean; sessionId?: string; onOrderCreated?: (order: { orderId: string; serverId: string; endpoint: string }, profile: SessionReceipt["deploymentProfile"]) => Promise<void> | void; onCandidateAttempt?: (event: CandidateAttemptEvent) => Promise<void> | void; onMarketWait?: (event: MarketWaitEvent) => Promise<void> | void }) {
  if (!input.execute) {
    const plan = planImageSession(listImageTasks(), { activeOrderCount: 0 });
    return { dryRun: true, providerMutationCount: 0, selectedTaskIds: plan.selectedTaskIds, executionEligible: plan.executionEligible };
  }
  const exact = input.taskIds; if (!exact.length || exact.length > 8 || new Set(exact).size !== exact.length) throw new Error("image_session_requires_one_to_eight_exact_task_ids");
  // The UI already persisted this canonical order.  Validate membership only;
  // never sort or independently rebuild it after the batch has been frozen.
  const selected = hydrateFrozenImageSessionPlan(exact.map((id) => resolveExactEligibleImageTask(id)), exact, { activeOrderCount: 0 });
  const receipt: LiveSessionReceipt = initial(input.sessionId ?? randomUUID(), selected); persist(receipt);
  let order: Awaited<ReturnType<typeof createLiveSessionOrder>> | null = null;
  let ownedOrder: OwnedSessionOrder | null = null;
  let primary: unknown = null;
  try {
    receipt.sessionState = "starting"; receipt.timestamps.starting = stamp(); persist(receipt);
    order = await createLiveSessionOrder({
      sessionId: receipt.sessionId,
      taskIds: exact,
      immutable: input.immutable,
      execute: true,
      onOrderPersisted: (persisted) => {
        ownedOrder = persisted;
        receipt.orderId = persisted.orderId;
        receipt.serverId = persisted.serverId;
        receipt.timestamps.orderCreated ??= stamp();
        persist(receipt);
      },
      onCandidateAttempt: async (event) => { receipt.candidateAttempts = [...receipt.candidateAttempts, event].slice(-10); receipt.timestamps[`candidate:${event.attempt}:${event.event}`] = stamp(); persist(receipt); await input.onCandidateAttempt?.(event); },
      onMarketEvidence: (evidence) => { receipt.marketplaceEvidence = [...receipt.marketplaceEvidence, evidence].slice(-24); persist(receipt); },
      onMarketWait: input.onMarketWait,
    });
    ownedOrder ??= order;
    receipt.orderId = order.orderId;
    receipt.endpointHostname = order.hostname;
    applySelectedPlanToReceipt(receipt, order.plan);
    receipt.timestamps.endpointPublished = stamp();
    persist(receipt);
    await input.onOrderCreated?.({ orderId: order.orderId, serverId: order.serverId, endpoint: order.endpoint }, receipt.deploymentProfile);
    await waitForAgentIdle(order);
    receipt.sessionState = "running"; receipt.timestamps.agentReady = stamp(); persist(receipt);
    for (const stage of ["environment", "gpu", "controller", "comfyui"] as const) { receipt.currentRemoteStage = stage; persist(receipt); const result = await invokeStage(order, stage, undefined, { requested: (stageRunId) => { receipt.currentStageRunId = stageRunId; receipt.timestamps[`${stage}:requested:${stageRunId}`] = stamp(); persist(receipt); }, accepted: (value) => { receipt.currentStageRunId = value.stageRunId; receipt.timestamps[`${stage}:accepted:${value.stageRunId}`] = stamp(); persist(receipt); }, evidence: (value) => persistAgentAcceptanceEvidence(receipt, value) }); receipt.currentStageRunId = result.stageRunId; if (result.status !== "succeeded") throw new Error(`${stage}_stage_failed:${sanitizedError(result.error)}`); if (stage === "gpu") assertStageGpuMatches(selected.selectedGpuClass, result.data); receipt.timestamps[`${stage}:${result.stageRunId}`] = stamp(); persist(receipt); }
    const models = await installModelsOnce(order, exact.map((taskId) => resolveExactEligibleImageTask(taskId)), { requested: (stageRunId) => { receipt.currentRemoteStage = "models"; receipt.currentStageRunId = stageRunId; receipt.timestamps[`models:requested:${stageRunId}`] = stamp(); persist(receipt); }, accepted: (value) => { receipt.currentStageRunId = value.stageRunId; receipt.timestamps[`models:accepted:${value.stageRunId}`] = stamp(); persist(receipt); }, evidence: (value) => persistAgentAcceptanceEvidence(receipt, value) }, order.modelManifest); receipt.modelStage = { state: models.status === "succeeded" ? "succeeded" : "failed", stageRunId: models.stageRunId }; persist(receipt); if (models.status !== "succeeded") throw new Error(`models_stage_failed:${sanitizedError(models.error)}`);
    for (const taskId of exact) {
      receipt.currentTaskId = taskId; persist(receipt);
      const task = resolveExactEligibleImageTask(taskId);
      try {
        const result = await submitTaskInference(order, task, { sessionId: receipt.sessionId, requested: (stageRunId) => { receipt.currentRemoteStage = "inference"; receipt.currentStageRunId = stageRunId; receipt.tasks[taskId].stageRunId = stageRunId; receipt.timestamps[`inference:requested:${stageRunId}`] = stamp(); taskReceipt(receipt, taskId, { stageRunId }); persist(receipt); }, submitting: () => { receipt.tasks[taskId].inferenceState = "submitting"; taskReceipt(receipt, taskId, { acceptedHttpStatus: null, controllerJobId: null, controllerPromptId: null, terminalError: null }); persist(receipt); }, accepted: (accepted) => { receipt.tasks[taskId].inferenceState = "accepted"; receipt.tasks[taskId].stageRunId = accepted.stageRunId; receipt.timestamps[`inference:accepted:${accepted.stageRunId}`] = stamp(); taskReceipt(receipt, taskId, { acceptedHttpStatus: 202, stageRunId: accepted.stageRunId }); persist(receipt); }, evidence: (value) => persistAgentAcceptanceEvidence(receipt, value) });
        receipt.tasks[taskId] = { terminal: "completed", inferenceState: "succeeded", stageRunId: result.accepted.stageRunId }; receipt.completedCount += 1;
        taskReceipt(receipt, taskId, { acceptedHttpStatus: 202, stageRunId: result.accepted.stageRunId, controllerJobId: result.controllerJobId, controllerPromptId: result.controllerPromptId, remoteArtifact: { byteSize: result.artifact.pngBytes, sha256: result.artifact.pngSha256, width: result.artifact.width, height: result.artifact.height }, localArtifact: { relativeDir: result.artifact.relativeDir }, uiVerified: result.uiVerified, terminalError: result.uiVerificationError }); persist(receipt);
      } catch (error) {
        const message = sanitizedError(error);
        if (receipt.tasks[taskId].inferenceState === "submitting" || receipt.tasks[taskId].inferenceState === "accepted") { receipt.tasks[taskId].terminal = "ambiguous"; receipt.sessionState = "ambiguous"; receipt.firstError ??= message; taskReceipt(receipt, taskId, { terminalError: message }); persist(receipt); throw error; }
        receipt.tasks[taskId].inferenceState = "failed"; receipt.tasks[taskId].terminal = "failed"; receipt.failedCount += 1; taskReceipt(receipt, taskId, { terminalError: message }); persist(receipt);
        if (!deterministic(error)) throw error;
      } finally { receipt.currentTaskId = null; persist(receipt); }
    }
    receipt.sessionState = receipt.failedCount ? "completed" : "completed"; receipt.timestamps.completed = stamp(); persist(receipt);
    return receipt;
  } catch (error) { primary = error; if (receipt.sessionState !== "ambiguous") receipt.sessionState = "failed"; receipt.agentAcceptanceFailure ??= sanitizeAgentStageAcceptanceEvidence(error); receipt.firstError ??= sanitizedError(error); receipt.timestamps.failed = stamp(); persist(receipt); throw error;
  } finally {
    if (ownedOrder) {
      let cleanupFailure: Error | null = null;
      try {
        const cleanup = await cleanupLiveSession(ownedOrder);
        receipt.cancellationState = cleanup.cancellationState;
        receipt.cleanupErrors = cleanup.cleanupErrors;
        receipt.cleanupEvidence = { zeroActiveOrderConfirmations: cleanup.zeroConfirmations, watchdogDisarmed: cleanup.watchdogDisarmed, localOrderStateCleared: cleanup.localOrderStateCleared };
        receipt.timestamps.cleanup = stamp();
        if (!cleanup.cleanupConfirmed) {
          receipt.sessionState = "ambiguous";
          receipt.firstError ??= "order_cleanup_unconfirmed_after_two_zero_checks";
          cleanupFailure = new Error("order_cleanup_unconfirmed_after_two_zero_checks");
        }
        persist(receipt);
      } catch (error) {
        receipt.sessionState = "ambiguous";
        receipt.cancellationState = "cancellation_unconfirmed";
        receipt.cleanupErrors = [...receipt.cleanupErrors, sanitizedError(error)];
        receipt.cleanupEvidence = { zeroActiveOrderConfirmations: 0, watchdogDisarmed: false, localOrderStateCleared: false };
        receipt.firstError ??= "order_cleanup_unconfirmed_after_two_zero_checks";
        receipt.timestamps.cleanup = stamp();
        persist(receipt);
        cleanupFailure = error instanceof Error ? error : new Error(String(error));
      }
      if (cleanupFailure && !primary) throw cleanupFailure;
    }
    if (primary && ownedOrder === null) {
      // A pre-order failure must leave a terminal, archivable receipt while
      // preserving the exact task state and all provider evidence collected so
      // far.  The supervisor performs a fresh active-order read before reuse.
      receipt.cancellationState = "not_created";
      receipt.cleanupEvidence = { zeroActiveOrderConfirmations: 0, watchdogDisarmed: true, localOrderStateCleared: true };
      receipt.timestamps.cleanup = stamp();
      persist(receipt);
    }
  }
}
