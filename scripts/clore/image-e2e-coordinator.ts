import { createHash } from "node:crypto";
import type { EligibleImageTask } from "./run-image-e2e";
import type { LocalArtifactReference } from "../../src/lib/image-generation/local-image-artifacts";
import type { AgentTransportDiagnostic } from "./agent-get-transport";

export const IMAGE_E2E_PHASES = ["PRERENTAL", "ORDER", "AGENT", "RUNTIME", "MODELS", "CLAIM", "INFERENCE", "ARTIFACT", "FINALIZE", "UI_VERIFY", "CANCEL", "DONE"] as const;
export type ImageE2ePhase = (typeof IMAGE_E2E_PHASES)[number];

export type SanitizedImageE2eSession = {
  schemaVersion: 1;
  taskId: string;
  phase: ImageE2ePhase;
  orderId: string | null;
  endpoint: string | null;
  immutableCommit: string;
  tokenFile: string;
  tokenSha256: string;
  claimTokenHash: string | null;
  artifact: LocalArtifactReference | null;
  remoteArtifact: { byteSize: number; sha256: string; width: number; height: number; generationDurationSeconds: number; controllerPromptId: string | null } | null;
  stages: Record<string, "pending" | "running" | "succeeded" | "failed">;
  timestamps: Partial<Record<ImageE2ePhase, string>>;
  lastError: string | null;
  uiVerificationError?: string | null;
  transportDiagnostics?: AgentTransportDiagnostic[];
  createDiagnostics?: Array<{ httpStatus: 429; retryAfterMs: number | null; code: number; message: string | null; attempt: number }>;
  stageAcceptanceEvidence?: Array<{ route: string; stage: string; requestedStageRunId: string; capturedAt: string; httpStatus: number; contentType: string | null; responseByteLength: number; bodySha256: string; responseKind: string; body: { accepted: boolean | null; stage: string | null; stageRunId: string | null; state: string | null; status: string | null } | null; nonJsonPrefix: string | null; returnedStage: string | null; returnedStageRunId: string | null; acceptanceClassification: string }>;
};

export type RemoteArtifact = NonNullable<SanitizedImageE2eSession["remoteArtifact"]> & { png: Buffer };
export type ModelEntry = { role: string; filename: string; url: string; sha256: string; size_bytes: number };
export type InferenceReceiptDetail = {
  acceptedHttpStatus?: number;
  stageRunId?: string;
  error?: string;
  controllerPromptId?: string | null;
  failure?: Record<string, unknown>;
  remoteArtifact?: Omit<NonNullable<SanitizedImageE2eSession["remoteArtifact"]>, "controllerPromptId">;
};
export type ReceiptEvent = "artifact_downloaded" | "task_finalized" | "ui_verified" | "order_cancelled";

export type CoordinatorDeps = {
  now: () => string;
  persist: (session: SanitizedImageE2eSession) => void;
  load: () => SanitizedImageE2eSession | null;
  prerental: (taskId: string) => Promise<EligibleImageTask>;
  readEligibleTask: (taskId: string) => Promise<EligibleImageTask>;
  createOrder: () => Promise<{ orderId: string; endpoint: string }>;
  reconnect: (orderId: string) => Promise<{ active: boolean; endpoint: string | null }>;
  armWatchdog: (orderId: string) => Promise<void>;
  disarmWatchdog: () => Promise<void>;
  health: (endpoint: string) => Promise<{ alive: boolean; currentStage: string; lastError: string | null }>;
  stage: (endpoint: string, stage: "environment" | "gpu" | "controller" | "comfyui" | "models" | "inference", payload?: object) => Promise<{ status: "succeeded" | "failed"; error?: string; data?: Record<string, unknown> }>;
  submitInference: (endpoint: string, payload: object) => Promise<{ acceptedHttpStatus: 202; stageRunId: string }>;
  pollInference: (endpoint: string, expectedStageRunId: string) => Promise<{ status: "succeeded" | "failed"; error?: string; data?: Record<string, unknown> }>;
  inferenceReceipt?: (event: "submitting" | "accepted" | "succeeded" | "failed", detail?: InferenceReceiptDetail) => Promise<void>;
  receiptEvent?: (event: ReceiptEvent, detail?: InferenceReceiptDetail) => Promise<void>;
  resolveModels: () => Promise<ModelEntry[]>;
  claim: (task: EligibleImageTask) => Promise<{ token: string; tokenHash: string }>;
  startHeartbeat: (taskId: string, token: string) => { stop: () => void; assertHealthy: () => void };
  retrieveArtifact: (endpoint: string, taskId: string) => Promise<RemoteArtifact>;
  publishAndFinalize: (task: EligibleImageTask, token: string, artifact: RemoteArtifact, orderId: string) => Promise<LocalArtifactReference>;
  verifyUi: (taskId: string) => Promise<void>;
  failClaim: (taskId: string, token: string, error: string) => Promise<void>;
  cancelExactOrder: (orderId: string) => Promise<void>;
  confirmNoActiveOrders: () => Promise<void>;
};

function clean(value: unknown) {
  return String(value instanceof Error ? value.message : value)
    .replace(/([?&](?:x-amz-|signature|token|credential)[^=&]*=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(bearer\s+)[^\s]+/gi, "$1<redacted>")
    .replace(/(civitai_api_token|hf_token|clore_api_key|password|secret)\s*[:=]\s*[^\s]+/gi, "$1=<redacted>")
    .slice(0, 1000);
}

function initial(input: { taskId: string; immutableCommit: string; tokenFile: string; tokenSha256: string }): SanitizedImageE2eSession {
  return { schemaVersion: 1, taskId: input.taskId, phase: "PRERENTAL", orderId: null, endpoint: null, immutableCommit: input.immutableCommit, tokenFile: input.tokenFile, tokenSha256: input.tokenSha256, claimTokenHash: null, artifact: null, remoteArtifact: null, stages: {}, timestamps: { PRERENTAL: new Date().toISOString() }, lastError: null, transportDiagnostics: [], createDiagnostics: [], stageAcceptanceEvidence: [] };
}

function mark(deps: CoordinatorDeps, session: SanitizedImageE2eSession, phase: ImageE2ePhase, patch: Partial<SanitizedImageE2eSession> = {}) {
  const next = { ...session, ...patch, phase, timestamps: { ...session.timestamps, [phase]: deps.now() } };
  deps.persist(next);
  return next;
}

function inferencePayload(task: EligibleImageTask) {
  return { task_id: task.id, mode: "text_generation", prompt: task.prompt, width: task.width, height: task.height, steps: task.steps, cfg: task.cfg, lora_strength: task.loraStrength, seed: task.seed, sampler: task.sampler };
}

function inferenceReceiptDetail(data: Record<string, unknown> | undefined): InferenceReceiptDetail {
  if (!data) return {};
  const byteSize = Number(data.byte_size);
  const width = Number(data.width);
  const height = Number(data.height);
  const generationDurationSeconds = Number(data.generation_duration_seconds);
  const sha256 = typeof data.sha256 === "string" && /^[a-f0-9]{64}$/i.test(data.sha256) ? data.sha256.toLowerCase() : null;
  const remoteArtifact = Number.isSafeInteger(byteSize) && byteSize > 0 && Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 && Number.isFinite(generationDurationSeconds) && generationDurationSeconds >= 0 && sha256
    ? { byteSize, sha256, width, height, generationDurationSeconds }
    : undefined;
  return {
    controllerPromptId: typeof data.controller_prompt_id === "string" ? data.controller_prompt_id.slice(0, 200) : null,
    remoteArtifact,
  };
}

function inferenceFailureReceiptDetail(data: Record<string, unknown> | undefined): InferenceReceiptDetail {
  const allowed = ["code", "controller_job_id", "controller_prompt_id", "requested_width", "requested_height", "actual_width", "actual_height", "png_byte_size", "png_sha256"];
  const failure = Object.fromEntries(allowed.flatMap((key) => data && key in data ? [[key, data[key]]] : []));
  return { controllerPromptId: typeof failure.controller_prompt_id === "string" ? failure.controller_prompt_id.slice(0, 200) : null, failure };
}

async function requiredStage(deps: CoordinatorDeps, session: SanitizedImageE2eSession, endpoint: string, name: "environment" | "gpu" | "controller" | "comfyui", payload?: object) {
  session.stages[name] = "running"; deps.persist(session);
  const result = await deps.stage(endpoint, name, payload);
  session.stages[name] = result.status; deps.persist(session);
  if (result.status !== "succeeded") throw new Error(`${name}_stage_failed:${clean(result.error ?? "unknown")}`);
}

/** Runs one exact task and never creates a replacement order. All provider-facing
 * details live in the dependency adapter; this state machine owns ordering,
 * resume decisions, local finalization, and exact-order cleanup. */
export async function runImageE2e(input: { taskId: string; immutableCommit: string; tokenFile: string; tokenSha256: string; resume: boolean }, deps: CoordinatorDeps) {
  let session = input.resume ? deps.load() : null;
  if (session && session.taskId !== input.taskId) throw new Error("image_e2e_resume_task_mismatch");
  session ??= initial(input);
  let task: EligibleImageTask | null = null;
  let claim: { token: string; tokenHash: string } | null = null;
  let heartbeat: ReturnType<CoordinatorDeps["startHeartbeat"]> | null = null;
  let preserveRemoteArtifact = false;
  try {
    task = await deps.prerental(input.taskId);
    session = mark(deps, session, "PRERENTAL");
    if (session.orderId) {
      const live = await deps.reconnect(session.orderId);
      if (!live.active) {
        if (session.phase === "FINALIZE" && session.artifact) return mark(deps, session, "DONE");
        session = mark(deps, session, "PRERENTAL", { orderId: null, endpoint: null, lastError: "stale_local_order_cleared" });
      } else if (live.endpoint) {
        session = mark(deps, session, session.phase, { endpoint: live.endpoint });
      }
    }
    if (!session.orderId) {
      const created = await deps.createOrder();
      session = mark(deps, session, "ORDER", { orderId: created.orderId, endpoint: created.endpoint });
      await deps.armWatchdog(created.orderId);
    }
    if (!session.endpoint || !session.orderId) throw new Error("image_e2e_order_endpoint_missing");
    const endpoint = session.endpoint;
    const orderId = session.orderId;
    const health = await deps.health(endpoint);
    if (!health.alive || health.currentStage !== "idle" || health.lastError) throw new Error(`agent_not_ready:${clean(health.lastError ?? health.currentStage)}`);
    session = mark(deps, session, "AGENT");
    for (const stage of ["environment", "gpu", "controller", "comfyui"] as const) await requiredStage(deps, session, endpoint, stage);
    session = mark(deps, session, "RUNTIME");
    const isRefreshableModelFailure = (result: { status: "succeeded" | "failed"; error?: string; data?: Record<string, unknown> }) => result.status === "failed" && (result.data?.code === "model_download_incomplete_after_retries" || (result.data?.code === "model_download_http_error" && (result.data.http_status === 401 || result.data.http_status === 403)));
    let models = await deps.resolveModels();
    let modelsResult = await deps.stage(endpoint, "models", { models });
    if (isRefreshableModelFailure(modelsResult)) {
      // This is still before claim/inference. Rebuilding all five exact entries lets
      // the Agent retain verified files and resume the failed .part safely.
      if (session.claimTokenHash !== null) throw new Error("model_refresh_after_claim_forbidden");
      models = await deps.resolveModels();
      modelsResult = await deps.stage(endpoint, "models", { models });
      if (isRefreshableModelFailure(modelsResult)) {
        const code = modelsResult.data?.code;
        throw new Error(`${code === "model_download_http_error" ? "model_download_authorization_failed_after_refresh" : "model_download_incomplete_after_refresh"}:${clean(JSON.stringify(modelsResult.data))}`);
      }
    }
    session.stages.models = modelsResult.status; deps.persist(session);
    if (modelsResult.status !== "succeeded") throw new Error(`models_stage_failed:${clean(modelsResult.error ?? "unknown")}`);
    session = mark(deps, session, "MODELS");
    task = await deps.readEligibleTask(input.taskId);
    claim = await deps.claim(task);
    session = mark(deps, session, "CLAIM", { claimTokenHash: claim.tokenHash });
    heartbeat = deps.startHeartbeat(task.id, claim.token);
    heartbeat.assertHealthy();
    // The pre-submit receipt is deliberately persisted before the sole remote POST.
    // If this fails, the POST is never allowed to occur.
    await deps.inferenceReceipt?.("submitting");
    const accepted = await deps.submitInference(endpoint, inferencePayload(task));
    await deps.inferenceReceipt?.("accepted", { acceptedHttpStatus: accepted.acceptedHttpStatus, stageRunId: accepted.stageRunId });
    const inference = await deps.pollInference(endpoint, accepted.stageRunId);
    session.stages.inference = inference.status; deps.persist(session);
    if (inference.status !== "succeeded") { await deps.inferenceReceipt?.("failed", { error: clean(inference.error ?? "unknown"), ...inferenceFailureReceiptDetail(inference.data) }); throw new Error(`inference_stage_failed:${clean(inference.error ?? "unknown")}`); }
    await deps.inferenceReceipt?.("succeeded", inferenceReceiptDetail(inference.data));
    preserveRemoteArtifact = true;
    session = mark(deps, session, "INFERENCE");
    heartbeat.assertHealthy();
    let remote: RemoteArtifact | null = null;
    let retrievalError: unknown;
    for (let attempt = 0; attempt < 3 && !remote; attempt += 1) {
      try { remote = await deps.retrieveArtifact(endpoint, task.id); }
      catch (error) { retrievalError = error; }
    }
    if (!remote) throw retrievalError instanceof Error ? retrievalError : new Error("remote_artifact_download_failed");
    await deps.receiptEvent?.("artifact_downloaded", { controllerPromptId: remote.controllerPromptId, remoteArtifact: { byteSize: remote.byteSize, sha256: remote.sha256, width: remote.width, height: remote.height, generationDurationSeconds: remote.generationDurationSeconds } });
    session = mark(deps, session, "ARTIFACT", { remoteArtifact: { byteSize: remote.byteSize, sha256: remote.sha256, width: remote.width, height: remote.height, generationDurationSeconds: remote.generationDurationSeconds, controllerPromptId: remote.controllerPromptId } });
    let artifact: LocalArtifactReference | null = null;
    let finalizationError: unknown;
    for (let attempt = 0; attempt < 3 && !artifact; attempt += 1) {
      try { artifact = await deps.publishAndFinalize(task, claim.token, remote, orderId); }
      catch (error) { finalizationError = error; }
    }
    if (!artifact) throw finalizationError instanceof Error ? finalizationError : new Error("local_artifact_finalization_failed");
    await deps.receiptEvent?.("task_finalized");
    heartbeat.stop(); heartbeat = null;
    session = mark(deps, session, "FINALIZE", { artifact });
    let uiVerificationError: string | null = null;
    try {
      await deps.verifyUi(task.id);
      await deps.receiptEvent?.("ui_verified");
    } catch (error) {
      // Local artifact publication and task finalization are the durable success
      // boundary. A later UI/readback problem is diagnostic-only and must not
      // downgrade the completed task or route it through failClaim.
      uiVerificationError = clean(error);
    }
    session = mark(deps, session, "UI_VERIFY", { uiVerificationError });
    return session;
  } catch (error) {
    const failure = clean(error);
    if (claim && task && !preserveRemoteArtifact) await deps.failClaim(task.id, claim.token, failure).catch(() => undefined);
    session = mark(deps, session, session.phase, { lastError: failure });
    throw error;
  } finally {
    heartbeat?.stop();
    const exactOrderId = session.orderId;
    if (exactOrderId) {
      session = mark(deps, session, "CANCEL");
      await deps.cancelExactOrder(exactOrderId);
      await deps.confirmNoActiveOrders();
      await deps.confirmNoActiveOrders();
      await deps.receiptEvent?.("order_cancelled");
    }
    await deps.disarmWatchdog();
    mark(deps, session, "DONE");
  }
}

export function claimTokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
