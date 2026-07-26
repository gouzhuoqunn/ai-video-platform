/** One-order, sequential two-task image session.  The CLI gates provider mutation. */
import { randomUUID } from "node:crypto";
import { listImageTasks, readImageTask } from "../../src/lib/image-generation/local-image-task-store";
import { IMAGE_SESSION_LIMITS, planImageSession } from "./image-session";
import { cleanupLiveSession, createLiveSessionOrder, installModelsOnce, invokeStage, newSessionToken, sessionPaths, submitTaskInference, waitForAgentIdle, writeSessionReceipt, writeTaskReceipt, type ImmutableRuntime } from "./image-live-runtime";
import { resolveExactEligibleImageTask } from "./run-image-e2e";

export type SessionTaskState = { terminal: "not_started" | "completed" | "failed" | "ambiguous"; inferenceState: "not_started" | "submitting" | "accepted" | "succeeded" | "failed"; stageRunId: string | null };
export type SessionReceipt = { schemaVersion: 1; sessionId: string; sessionState: "planned" | "starting" | "running" | "draining" | "completed" | "failed" | "ambiguous"; orderId: string | null; endpointHostname: string | null; selectedTaskIds: string[]; currentTaskId: string | null; modelStage: { state: "not_started" | "succeeded" | "failed"; stageRunId: string | null }; tasks: Record<string, SessionTaskState>; completedCount: number; failedCount: number; cancellationState: string; cleanupErrors: string[]; firstError: string | null; timestamps: Record<string, string> };
const stamp = () => new Date().toISOString();
const sanitizedError = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/(bearer\s+)[^\s]+/gi, "$1<redacted>").slice(0, 700);
const deterministic = (error: unknown) => /result_dimensions_mismatch|inference_stage_failed:.*(?:validation|dimensions)/i.test(sanitizedError(error));

function initial(sessionId: string, taskIds: string[]): SessionReceipt { return { schemaVersion: 1, sessionId, sessionState: "planned", orderId: null, endpointHostname: null, selectedTaskIds: taskIds, currentTaskId: null, modelStage: { state: "not_started", stageRunId: null }, tasks: Object.fromEntries(taskIds.map((id) => [id, { terminal: "not_started", inferenceState: "not_started", stageRunId: null }])), completedCount: 0, failedCount: 0, cancellationState: "not_started", cleanupErrors: [], firstError: null, timestamps: { planned: stamp() } }; }
function persist(receipt: SessionReceipt) { writeSessionReceipt(receipt); }
function taskReceipt(receipt: SessionReceipt, taskId: string, patch: Record<string, unknown>) { writeTaskReceipt(receipt.sessionId, taskId, { taskId, inferenceState: receipt.tasks[taskId].inferenceState, stageRunId: receipt.tasks[taskId].stageRunId, timestamps: { updatedAt: stamp() }, ...patch }); }

export async function runLiveImageSession(input: { taskIds: string[]; immutable: ImmutableRuntime; execute: boolean; sessionId?: string }) {
  if (!input.execute) {
    const plan = planImageSession(listImageTasks(), { activeOrderCount: 0 });
    return { dryRun: true, providerMutationCount: 0, selectedTaskIds: plan.selectedTaskIds, executionEligible: plan.executionEligible };
  }
  const exact = input.taskIds; if (exact.length !== 2 || new Set(exact).size !== 2) throw new Error("first_live_image_session_requires_two_exact_task_ids");
  const selected = planImageSession(exact.map((id) => resolveExactEligibleImageTask(id)), { activeOrderCount: 0 });
  if (selected.selectedTaskIds.join(",") !== exact.join(",")) throw new Error("image_session_task_order_mismatch");
  const receipt = initial(input.sessionId ?? randomUUID(), exact); persist(receipt);
  let order: Awaited<ReturnType<typeof createLiveSessionOrder>> | null = null; let primary: unknown = null;
  try {
    receipt.sessionState = "starting"; receipt.timestamps.starting = stamp(); persist(receipt);
    order = await createLiveSessionOrder({ sessionId: receipt.sessionId, taskIds: exact, immutable: input.immutable, execute: true });
    receipt.orderId = order.orderId; receipt.endpointHostname = order.hostname; receipt.timestamps.orderCreated = stamp(); persist(receipt);
    await waitForAgentIdle(order);
    receipt.sessionState = "running"; receipt.timestamps.agentReady = stamp(); persist(receipt);
    for (const stage of ["environment", "gpu", "controller", "comfyui"] as const) { const result = await invokeStage(order, stage); if (result.status !== "succeeded") throw new Error(`${stage}_stage_failed:${sanitizedError(result.error)}`); receipt.timestamps[`${stage}:${result.stageRunId}`] = stamp(); persist(receipt); }
    const models = await installModelsOnce(order); receipt.modelStage = { state: models.status === "succeeded" ? "succeeded" : "failed", stageRunId: models.stageRunId }; persist(receipt); if (models.status !== "succeeded") throw new Error(`models_stage_failed:${sanitizedError(models.error)}`);
    for (const taskId of exact) {
      receipt.currentTaskId = taskId; persist(receipt);
      const task = resolveExactEligibleImageTask(taskId);
      try {
        const result = await submitTaskInference(order, task, { submitting: () => { receipt.tasks[taskId].inferenceState = "submitting"; taskReceipt(receipt, taskId, { acceptedHttpStatus: null, controllerJobId: null, controllerPromptId: null, terminalError: null }); persist(receipt); }, accepted: (accepted) => { receipt.tasks[taskId].inferenceState = "accepted"; receipt.tasks[taskId].stageRunId = accepted.stageRunId; taskReceipt(receipt, taskId, { acceptedHttpStatus: 202, stageRunId: accepted.stageRunId }); persist(receipt); } });
        receipt.tasks[taskId] = { terminal: "completed", inferenceState: "succeeded", stageRunId: result.accepted.stageRunId }; receipt.completedCount += 1;
        taskReceipt(receipt, taskId, { acceptedHttpStatus: 202, stageRunId: result.accepted.stageRunId, controllerJobId: result.controllerJobId, controllerPromptId: result.controllerPromptId, remoteArtifact: { byteSize: result.artifact.pngBytes, sha256: result.artifact.pngSha256, width: result.artifact.width, height: result.artifact.height }, localArtifact: { relativeDir: result.artifact.relativeDir }, uiVerified: true, terminalError: null }); persist(receipt);
      } catch (error) {
        const message = sanitizedError(error);
        if (receipt.tasks[taskId].inferenceState === "submitting" || receipt.tasks[taskId].inferenceState === "accepted") { receipt.tasks[taskId].terminal = "ambiguous"; receipt.sessionState = "ambiguous"; receipt.firstError ??= message; taskReceipt(receipt, taskId, { terminalError: message }); persist(receipt); throw error; }
        receipt.tasks[taskId].inferenceState = "failed"; receipt.tasks[taskId].terminal = "failed"; receipt.failedCount += 1; taskReceipt(receipt, taskId, { terminalError: message }); persist(receipt);
        if (!deterministic(error)) throw error;
      } finally { receipt.currentTaskId = null; persist(receipt); }
    }
    receipt.sessionState = receipt.failedCount ? "completed" : "completed"; receipt.timestamps.completed = stamp(); persist(receipt);
    return receipt;
  } catch (error) { primary = error; if (receipt.sessionState !== "ambiguous") receipt.sessionState = "failed"; receipt.firstError ??= sanitizedError(error); receipt.timestamps.failed = stamp(); persist(receipt); throw error;
  } finally {
    if (order) { const cleanup = await cleanupLiveSession(order); receipt.cancellationState = cleanup.cancellationState; receipt.cleanupErrors = cleanup.cleanupErrors; receipt.timestamps.cleanup = stamp(); persist(receipt); }
    if (primary && order === null) { /* no watchdog was armed before a successful order */ }
  }
}
