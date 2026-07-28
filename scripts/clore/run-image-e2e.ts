/** Local-only coordinator primitives for the restricted Clore image run.
 * Provider mutation remains deliberately absent until the full preflight path
 * invokes these exact-task primitives after runtime/model success.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import { finalizeImageTask, mutateImageTasks, readImageTask, renewImageTaskLease, type LocalImageTask, type LocalTaskStoreOptions } from "../../src/lib/image-generation/local-image-task-store";
import { classifyImageGpu } from "../../src/lib/image-generation/flux-stack";
import { assertImageTaskLoras, normalizeNegativePrompt, type ImageTaskLora } from "../../src/lib/image-generation/image-loras";
import { requiresManualInferenceRecovery } from "../../src/lib/image-generation/image-task-retry-policy";
import { buildRtx4090GoldenBootstrap, RTX4090_GOLDEN_DEPLOYMENT_PROFILE } from "../image-executor/rtx4090-golden-deployment-profile";
import { publishLocalImageArtifact, type LocalArtifactReference } from "../../src/lib/image-generation/local-image-artifacts";
import { sanitizeImageModelPreflight, toAgentModelManifest, validateAgentModelManifestContract, verifyAdditionalTaskLoraSources, verifyFiveImageModelSources } from "./image-model-preflight";
import { CloreRateLimitError, sleep } from "./client";
import { readLiveOrdersSummary } from "./live";
import { agentArtifactMetadataResponse, agentGetJsonWithRetry, agentHealthResponse, agentStatusResponse, AgentGetTerminalError, type AgentTransportDiagnostic } from "./agent-get-transport";

export type EligibleImageTask = LocalImageTask & { prompt: string; negativePrompt?: string; loras?: ImageTaskLora[]; mode: "text_generation"; referenceImage: null; width: number; height: number; steps: number; cfg: number; loraStrength: number; seed: number; sampler: "Euler" | "FlowMatch" };
const RECEIPT_PATH = path.join(process.cwd(), ".secrets", "clore-image-e2e-fresh-receipt.json");
const RECEIPT_ARCHIVE_DIR = path.join(process.cwd(), ".secrets", "diagnostics", "clore-image-e2e-receipts");

export function buildPublicAgentBootstrap(input: { commit: string; agentSourceSha256: string; agentSha256: string; controllerSha256: string; workflowSha256: string; tokenSha256: string }) {
  if (![input.commit, input.agentSourceSha256, input.agentSha256, input.controllerSha256, input.workflowSha256, input.tokenSha256].every((value) => /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(value))) throw new Error("immutable_agent_bootstrap_values_required");
  const profile = assertGoldenBootstrapIdentity(input);
  return buildRtx4090GoldenBootstrap(profile.tokenSha256);
}

function assertGoldenBootstrapIdentity(input: { commit: string; agentSourceSha256: string; agentSha256: string; controllerSha256: string; workflowSha256: string; tokenSha256: string }) {
  const immutable = RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable;
  if (input.commit !== immutable.commit || input.agentSourceSha256 !== immutable.agentSourceSha256 || input.agentSha256 !== immutable.agentSha256 || input.controllerSha256 !== immutable.controllerSha256 || input.workflowSha256 !== immutable.workflowSha256) {
    throw new Error("rtx4090_golden_bootstrap_identity_mismatch");
  }
  return { tokenSha256: input.tokenSha256 };
}

export type FreshReceipt={schema:1;runId:string;taskId:string;orderId:string|null;endpoint:string|null;currentStep:string;inferenceState:"not_started"|"submitting"|"accepted"|"succeeded"|"failed";inferenceSubmitted:boolean;inferenceSucceeded:boolean;inferenceSubmittingAt:string|null;inferenceAcceptedAt:string|null;acceptedHttpStatus:202|null;inferenceCompletedAt:string|null;remoteArtifactAvailable:boolean;controllerPromptId:string|null;inferenceFailure:Record<string,unknown>|null;remoteArtifact:{byteSize:number;sha256:string;width:number;height:number;generationDurationSeconds:number}|null;artifactDownloaded:boolean;localArtifactPublished:boolean;taskFinalized:boolean;uiVerified:boolean;orderCancelled:boolean;timestamps:Record<string,string>;firstError:string|null};
function receiptRead(receiptPath=RECEIPT_PATH){try{return JSON.parse(readFileSync(receiptPath,"utf8")) as FreshReceipt}catch{return null}}
function receiptWrite(value:FreshReceipt,receiptPath=RECEIPT_PATH){mkdirSync(path.dirname(receiptPath),{recursive:true});const tmp=`${receiptPath}.${process.pid}.tmp`;const descriptor=openSync(tmp,"w",0o600);try{writeSync(descriptor,`${JSON.stringify(value,null,2)}\n`);fsyncSync(descriptor)}finally{closeSync(descriptor)}renameSync(tmp,receiptPath)}
export function freshRunRequiresManualRecovery(receipt: Pick<FreshReceipt, "taskId" | "inferenceState"> | null, taskId: string, taskStatus: string | undefined) { return receipt?.taskId === taskId && ["submitting", "accepted", "succeeded"].includes(receipt.inferenceState) && taskStatus !== "completed"; }
function freshReceipt(taskId:string):FreshReceipt{return {schema:1,runId:randomBytes(12).toString("hex"),taskId,orderId:null,endpoint:null,currentStep:"prerental",inferenceState:"not_started",inferenceSubmitted:false,inferenceSucceeded:false,inferenceSubmittingAt:null,inferenceAcceptedAt:null,acceptedHttpStatus:null,inferenceCompletedAt:null,remoteArtifactAvailable:false,controllerPromptId:null,inferenceFailure:null,remoteArtifact:null,artifactDownloaded:false,localArtifactPublished:false,taskFinalized:false,uiVerified:false,orderCancelled:false,timestamps:{prerental:new Date().toISOString()},firstError:null}}
export function isSafeFailedReceiptForFreshRun(receipt:FreshReceipt|null,taskId:string,taskStatus:string|undefined){
  if (receipt?.taskId !== taskId || receipt.inferenceSucceeded || receipt.taskFinalized || receipt.localArtifactPublished || receipt.artifactDownloaded || receipt.remoteArtifactAvailable || taskStatus !== "waiting_for_gpu") return false;
  const preOrderFailure = receipt.orderId === null && receipt.endpoint === null;
  const cancelledPostOrderFailure = Boolean(receipt.orderId && receipt.orderCancelled);
  const safePreInferenceFailure = receipt.inferenceState === "not_started" && !receipt.inferenceSubmitted;
  const failure = receipt.inferenceFailure;
  const safeDimensionFailure = receipt.inferenceState === "failed" && receipt.inferenceSubmitted && !receipt.remoteArtifact && Boolean(receipt.firstError?.includes("result_dimensions_mismatch:384x384"))
    && (!failure || (failure.code === "result_dimensions_mismatch" && failure.requested_width === 768 && failure.requested_height === 768 && failure.actual_width === 384 && failure.actual_height === 384));
  return (safePreInferenceFailure || safeDimensionFailure) && (preOrderFailure || cancelledPostOrderFailure);
}
export async function prepareFreshReceipt(input:{taskId:string;taskStatus:string|undefined;activeOrderCount:()=>Promise<number>;receiptPath?:string;archiveDir?:string}){const receiptPath=input.receiptPath??RECEIPT_PATH;const archiveDir=input.archiveDir??RECEIPT_ARCHIVE_DIR;const previous=receiptRead(receiptPath);if(freshRunRequiresManualRecovery(previous,input.taskId,input.taskStatus))throw new Error("previous_inference_state_requires_manual_recovery");if(previous?.taskId===input.taskId){if(!isSafeFailedReceiptForFreshRun(previous,input.taskId,input.taskStatus))throw new Error("previous_receipt_not_safe_to_rotate");if(await input.activeOrderCount()!==0)throw new Error("previous_receipt_active_order_exists");mkdirSync(archiveDir,{recursive:true});const archivePath=path.join(archiveDir,`${previous.taskId}-${previous.runId}.json`);renameSync(receiptPath,archivePath)}const receipt=freshReceipt(input.taskId);receiptWrite(receipt,receiptPath);return receipt}

/** Requeues only this exact canceled, artifact-free 384x384 dimension failure. */
export function requeueSafeFailedExactImageTask(input:{taskId:string;receipt:FreshReceipt|null;activeOrderCount:number;options?:LocalTaskStoreOptions}){
  if (input.activeOrderCount !== 0) throw new Error("safe_exact_retry_active_order_exists");
  const receipt = input.receipt;
  const failure = receipt?.inferenceFailure;
  if (input.taskId !== "eefc2b5b-5f25-4d82-aeeb-3b8ff501a1a0" || !receipt || receipt.taskId !== input.taskId || receipt.inferenceState !== "failed" || receipt.inferenceSucceeded || !receipt.inferenceSubmitted || receipt.remoteArtifact || receipt.remoteArtifactAvailable || receipt.artifactDownloaded || receipt.localArtifactPublished || receipt.taskFinalized || !receipt.orderCancelled || !receipt.firstError?.includes("result_dimensions_mismatch:384x384") || (failure && (failure.code !== "result_dimensions_mismatch" || failure.requested_width !== 768 || failure.requested_height !== 768 || failure.actual_width !== 384 || failure.actual_height !== 384))) throw new Error("safe_exact_retry_receipt_not_eligible");
  return mutateImageTasks((tasks) => {
    const task = tasks.find((candidate) => candidate.id === input.taskId);
    const error = task?.error as { retryable?: unknown; message?: unknown } | undefined;
    if (!task || task.status !== "failed" || task.result || task.localClaim || error?.retryable !== true || !String(error.message ?? "").includes("result_dimensions_mismatch:384x384")) throw new Error("safe_exact_retry_task_not_eligible");
    task.status = "waiting_for_gpu"; task.updatedAt = new Date().toISOString(); task.attempts = Number(task.attempts ?? 0) + 1; delete task.error;
    return { tasks, value: structuredClone(task) };
  }, input.options);
}

export type ActiveOrderSnapshot = { orders: Awaited<ReturnType<typeof readLiveOrdersSummary>>; checkedAt: number };
export type CreateRateLimitDiagnostic = { httpStatus: 429; retryAfterMs: number | null; code: number; message: string | null; attempt: number };

function matchingCreatedOrder(orders: ActiveOrderSnapshot["orders"], serverId: string) {
  const active = orders.filter((order) => order.active && order.orderId);
  if (active.length > 1) throw new Error("active_order_state_ambiguous_after_create");
  const matching = active[0] ?? null;
  if (matching && matching.serverId !== serverId) throw new Error("active_order_server_mismatch_after_create");
  return matching;
}
function rateLimitFailure(error: unknown) { return error instanceof CloreRateLimitError ? error.failure : null; }

/** Exactly one caller-owned 429 retry. The payload closure is intentionally reused unchanged. */
export async function createOrderWithRateLimit(input: {
  serverId: string;
  createOnce: () => Promise<unknown>;
  reconcile: () => Promise<ActiveOrderSnapshot>;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  jitter?: () => number;
  onDiagnostic?: (diagnostic: CreateRateLimitDiagnostic) => void;
}): Promise<{ created: unknown | null; adoptedOrderId: string | null; attempts: number }> {
  const sleepImpl = input.sleepImpl ?? sleep;
  const jitter = input.jitter ?? Math.random;
  const reconcileAndAdopt = async () => {
    const snapshot = await input.reconcile();
    const adopted = matchingCreatedOrder(snapshot.orders, input.serverId);
    if (adopted?.orderId) return adopted.orderId;
    if (snapshot.orders.some((order) => order.active)) throw new Error("active_order_exists_after_create_rate_limit");
    return null;
  };
  try { return { created: await input.createOnce(), adoptedOrderId: null, attempts: 1 }; }
  catch (error) {
    const first = rateLimitFailure(error); if (!first) throw error;
    input.onDiagnostic?.(first);
    const adopted = await reconcileAndAdopt(); if (adopted) return { created: null, adoptedOrderId: adopted, attempts: 1 };
    const cooldown = (first.retryAfterMs ?? 90_000) + Math.floor(Math.max(0, Math.min(1, jitter())) * 10_000);
    await sleepImpl(cooldown);
  }
  const beforeRetry = await reconcileAndAdopt(); if (beforeRetry) return { created: null, adoptedOrderId: beforeRetry, attempts: 1 };
  try { return { created: await input.createOnce(), adoptedOrderId: null, attempts: 2 }; }
  catch (error) {
    const second = rateLimitFailure(error); if (!second) throw error;
    input.onDiagnostic?.(second);
    const adopted = await reconcileAndAdopt(); if (adopted) return { created: null, adoptedOrderId: adopted, attempts: 2 };
    const persisted = new Error(JSON.stringify({ code: "create_order_rate_limit_persisted", http_status: 429, retry_after_ms: second.retryAfterMs, clore_code: second.code, attempt: 2 }));
    Object.assign(persisted, {
      classification: "rate_limited" as const,
      httpStatus: 429 as const,
      code: second.code,
      retryAfterMs: second.retryAfterMs,
      requestAttempts: 2 as const,
    });
    throw persisted;
  }
}
function url(endpoint: string, part: string) { return `${endpoint.replace(/\/$/, "")}${part}`; }
export type AcceptedStage = { acceptedHttpStatus: 202; stage: string; stageRunId: string };
export const AGENT_STAGE_ACCEPTANCE_CONTRACT = "stage-acceptance-v2" as const;
export const AGENT_STAGE_ACCEPTANCE_RESPONSE_FIELDS = ["accepted", "state", "status", "stage", "stage_run_id"] as const;
type SanitizedStageAcceptanceBody = { accepted: boolean | null; stage: string | null; stageRunId: string | null; state: string | null; status: string | null };
export type AgentStageAcceptanceEvidence = { route: string; stage: string; requestedStageRunId: string; capturedAt: string; httpStatus: number; contentType: string | null; responseByteLength: number; bodySha256: string; responseKind: "json" | "html" | "invalid_json" | "wrong_schema"; body: SanitizedStageAcceptanceBody | null; nonJsonPrefix: string | null; returnedStage: string | null; returnedStageRunId: string | null; acceptanceClassification: "response_received" | "accepted" | "http_error" | "html" | "invalid_json" | "wrong_schema" };
export class AgentStageAcceptanceError extends Error {
  constructor(readonly evidence: AgentStageAcceptanceEvidence) { super(`agent_stage_acceptance_invalid:${evidence.stage}`); }
}
function safeStageAcceptanceBody(body: Record<string, unknown> | null) {
  if (!body) return null;
  return {
    accepted: typeof body.accepted === "boolean" ? body.accepted : null,
    stage: typeof body.stage === "string" ? body.stage : null,
    stageRunId: typeof body.stage_run_id === "string" ? body.stage_run_id : null,
    state: typeof body.state === "string" ? body.state : null,
    status: typeof body.status === "string" ? body.status : null,
  };
}
function safeStageAcceptancePrefix(value: string) {
  return value
    .replace(/(bearer\s+)[^\s]+/gi, "$1<redacted>")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<redacted-url>")
    .replace(/([?&](?:x-amz-|signature|token|credential)[^=&]*=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(["']?(?:token|secret|password|authorization|api[_-]?key)["']?\s*:\s*)["'][^"']*["']/gi, "$1\"<redacted>\"")
    .slice(0, 160);
}
function stageAcceptanceEvidence(input: { route: string; stage: string; requestedStageRunId: string; httpStatus: number; contentType: string | null; bytes: Buffer; text: string; body: Record<string, unknown> | null; responseKind: AgentStageAcceptanceEvidence["responseKind"]; acceptanceClassification: AgentStageAcceptanceEvidence["acceptanceClassification"] }): AgentStageAcceptanceEvidence {
  const body = safeStageAcceptanceBody(input.body);
  return { route: input.route, stage: input.stage, requestedStageRunId: input.requestedStageRunId, capturedAt: new Date().toISOString(), httpStatus: input.httpStatus, contentType: input.contentType?.slice(0, 200) ?? null, responseByteLength: input.bytes.byteLength, bodySha256: createHash("sha256").update(input.bytes).digest("hex"), responseKind: input.responseKind, body, nonJsonPrefix: body || input.acceptanceClassification === "response_received" ? null : safeStageAcceptancePrefix(input.text), returnedStage: body?.stage ?? null, returnedStageRunId: body?.stageRunId ?? null, acceptanceClassification: input.acceptanceClassification };
}
export function sanitizeAgentStageAcceptanceEvidence(error: unknown) {
  if (!(error instanceof AgentStageAcceptanceError)) return null;
  const { route, stage, requestedStageRunId, httpStatus, contentType, responseKind, body } = error.evidence;
  return { route, stage, requestedStageRunId, httpStatus, contentType, responseKind, body };
}
export function assertCallerAgentStageAcceptanceContract(profile: { agentContract: string; acceptedStageResponseFields: readonly string[] }) {
  if (profile.agentContract !== AGENT_STAGE_ACCEPTANCE_CONTRACT || profile.acceptedStageResponseFields.join(",") !== AGENT_STAGE_ACCEPTANCE_RESPONSE_FIELDS.join(",")) throw new Error("rtx4090_stage_acceptance_contract_mismatch");
  return { callerContract: AGENT_STAGE_ACCEPTANCE_CONTRACT, requiredResponseFields: [...AGENT_STAGE_ACCEPTANCE_RESPONSE_FIELDS] };
}
function acceptedStage(route: string, status: number, body: Record<string, unknown>, requestedStageRunId: string): AcceptedStage {
  const stage = route.replace(/^\/stage\//, ""); const stageRunId = body.stage_run_id;
  const valid = status === 202 && (body.accepted === true || body.state === "accepted") && (body.state === "accepted" || body.status === "running") && body.stage === stage && stageRunId === requestedStageRunId;
  if (!valid) throw new Error(`agent_stage_acceptance_invalid:${stage}`);
  return { acceptedHttpStatus: 202, stage, stageRunId: requestedStageRunId };
}
export type AgentPostOptions = { stageRunId?: string; onRequested?: (stageRunId: string) => void | Promise<void>; onEvidence?: (evidence: AgentStageAcceptanceEvidence) => void; fetchImpl?: typeof fetch };
export async function agentPostJson(endpoint: string, token: string, route: string, payload?: object, options: AgentPostOptions = {}): Promise<AcceptedStage> {
  const stage = route.replace(/^\/stage\//, ""); const stageRunId = options.stageRunId ?? randomUUID(); await options.onRequested?.(stageRunId);
  const response = await (options.fetchImpl ?? fetch)(url(endpoint, route), { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", Accept: "application/json" }, body: JSON.stringify({ ...(payload ?? {}), stage_run_id: stageRunId }) });
  const contentType = response.headers.get("content-type"); const bytes = Buffer.from(await response.arrayBuffer()); const text = bytes.toString("utf8");
  // Persist response metadata before JSON parsing or acceptance validation.
  options.onEvidence?.(stageAcceptanceEvidence({ route, stage, requestedStageRunId: stageRunId, httpStatus: response.status, contentType, bytes, text, body: null, responseKind: /text\/html/i.test(contentType ?? "") ? "html" : "invalid_json", acceptanceClassification: "response_received" }));
  let body: Record<string, unknown> | null = null;
  try { const parsed: unknown = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>; } catch { /* classified below */ }
  const valid = body !== null && response.status === 202 && (body.accepted === true || body.state === "accepted") && (body.state === "accepted" || body.status === "running") && body.stage === stage && body.stage_run_id === stageRunId;
  const responseKind = /text\/html/i.test(contentType ?? "") ? "html" : body ? valid ? "json" : "wrong_schema" : "invalid_json";
  const acceptanceClassification = !response.ok ? "http_error" : responseKind === "html" ? "html" : responseKind === "invalid_json" ? "invalid_json" : valid ? "accepted" : "wrong_schema";
  const evidence = stageAcceptanceEvidence({ route, stage, requestedStageRunId: stageRunId, httpStatus: response.status, contentType, bytes, text, body, responseKind, acceptanceClassification });
  options.onEvidence?.(evidence);
  if (!response.ok || !body || !valid) throw new AgentStageAcceptanceError(evidence);
  return acceptedStage(route, response.status, body, stageRunId);
}

export function resolveExactEligibleImageTask(taskId: string, options: LocalTaskStoreOptions = {}): EligibleImageTask {
  const task = readImageTask(taskId, options);
  let extendedSettingsValid = true;
  try {
    normalizeNegativePrompt(task?.negativePrompt);
    if (task?.loras !== undefined) assertImageTaskLoras(task.loras);
  } catch {
    extendedSettingsValid = false;
  }
  if (!task || !extendedSettingsValid || requiresManualInferenceRecovery(task) || task.status !== "waiting_for_gpu" || task.mode !== "text_generation" || task.referenceImage || classifyImageGpu(Number(task.width), Number(task.height)) !== task.gpuClass) {
    throw new Error("image_task_not_eligible_for_restricted_text_run");
  }
  return task as EligibleImageTask;
}

/** Pre-rental only: it deliberately does not claim a task or call Clore. */
export async function preflightExactLocalImageTask(
  taskId: string,
  options: LocalTaskStoreOptions = {},
  verifyModels = verifyFiveImageModelSources,
  verifyLoras = verifyAdditionalTaskLoraSources,
) {
  const task = resolveExactEligibleImageTask(taskId, options);
  const modelPreflight = await verifyModels();
  const loraPreflight = await verifyLoras(task.loras);
  // Exercise the identical explicit projection used by the live coordinator
  // before a provider mutation. The returned preflight remains sanitized.
  validateAgentModelManifestContract(toAgentModelManifest(modelPreflight.models, loraPreflight.loras));
  const reread = readImageTask(taskId, options);
  if (!reread || requiresManualInferenceRecovery(reread) || reread.status !== "waiting_for_gpu") throw new Error("image_task_changed_during_prerental_preflight");
  return {
    task,
    modelPreflight: {
      ...sanitizeImageModelPreflight(modelPreflight),
      additionalLoras: loraPreflight.loras.map(({ id, filename, sha256, size_bytes }) => ({
        id,
        filename,
        sha256,
        size_bytes,
      })),
      additionalLoraChecks: loraPreflight.checked,
    },
    createsOrder: false,
    claimsTask: false,
  };
}

export function startImageTaskLeaseHeartbeat(input: { taskId: string; claimToken: string; leaseMs: number; options?: LocalTaskStoreOptions }) {
  const intervalMs = Math.max(5_000, Math.floor(input.leaseMs / 3));
  let stopped = false; let lastError: Error | null = null;
  const timer = setInterval(() => {
    if (stopped) return;
    try { renewImageTaskLease(input.taskId, input.claimToken, input.leaseMs, input.options); }
    catch (error) { lastError = error instanceof Error ? error : new Error("local_task_lease_renewal_failed"); }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); }, assertHealthy: () => { if (lastError) throw lastError; } };
}

export async function persistAndFinalizeExactLocalTask(input: {
  task: EligibleImageTask;
  claimToken: string;
  png: Buffer;
  remote: { generationDurationSeconds: number; orderId: string; gpuModel: string; controllerPromptId: string | null };
  options?: LocalTaskStoreOptions;
  maxFinalizeAttempts?: number;
  onArtifactPublished?: (artifact: LocalArtifactReference) => void | Promise<void>;
}): Promise<{ artifact: LocalArtifactReference; completed: LocalImageTask }> {
  const artifact = await publishLocalImageArtifact({ task: input.task, png: input.png, remote: input.remote, root: input.options?.artifactRoot });
  await input.onArtifactPublished?.(artifact);
  const attempts = input.maxFinalizeAttempts ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const completed = await finalizeImageTask(input.task.id, input.claimToken, artifact, input.options);
      return { artifact, completed };
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error("image_task_finalization_failed");
}

function argument(name: string) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }

export type WaitForStageOptions = {
  endpoint: string;
  token: string;
  stage: string;
  expectedStageRunId: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timestamp?: () => string;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  onDiagnostic?: (diagnostic: AgentTransportDiagnostic) => void;
  reconcileExactOrder?: () => Promise<boolean | null>;
};

function compactTransportOutage(input: { stage: string; outageStartedAt: number; now: number; getAttemptCount: number; last: AgentTransportDiagnostic | null; lastSuccessAt: string | null; exactOrderActive: boolean | null }) {
  return JSON.stringify({ code: "agent_transport_outage_exceeded", stage: input.stage, outage_duration_ms: Math.max(0, input.now - input.outageStartedAt), get_attempt_count: input.getAttemptCount, last_http_status: input.last?.httpStatus ?? null, last_response_kind: input.last?.responseKind ?? null, last_content_type: input.last?.contentType ?? null, last_body_sha256: input.last?.bodySha256 ?? null, last_success_agent_status_at: input.lastSuccessAt, exact_order_active: input.exactOrderActive });
}

/** GET-only stage polling. A stage POST is issued exactly once by the caller. */
export async function waitForStage(input: WaitForStageOptions) {
  const now = input.now ?? Date.now;
  const timestamp = input.timestamp ?? (() => new Date().toISOString());
  const sleepImpl = input.sleepImpl ?? sleep;
  const deadline = now() + input.timeoutMs;
  const backoff = [2_000, 3_000, 5_000];
  let statusAttempt = 0; let getAttemptCount = 0; let consecutiveFailures = 0; let outageStartedAt: number | null = null; let healthProbed = false; let lastDiagnostic: AgentTransportDiagnostic | null = null; let lastSuccessfulStatusAt: string | null = null;
  const record = (diagnostic: AgentTransportDiagnostic) => { lastDiagnostic = diagnostic; input.onDiagnostic?.(diagnostic); };
  while (now() < deadline) {
    statusAttempt += 1; getAttemptCount += 1;
    try {
      const status = await agentGetJsonWithRetry({ endpoint: input.endpoint, token: input.token, route: "/status", validator: agentStatusResponse, stage: input.stage, attempt: statusAttempt, fetchImpl: input.fetchImpl, timestamp });
      if (status.ok) {
        consecutiveFailures = 0; outageStartedAt = null; healthProbed = false; lastSuccessfulStatusAt = timestamp();
        const stageRecord = (status.body.stages as Record<string, Record<string, unknown>> | undefined)?.[input.stage];
        // A same-name terminal record from a prior POST is stale evidence.  Only
        // the immutable accepted stage_run_id may complete this invocation.
        if (stageRecord?.stage_run_id === input.expectedStageRunId && stageRecord.status === "succeeded") return { status: "succeeded" as const, data: typeof stageRecord.data === "object" && stageRecord.data !== null ? stageRecord.data as Record<string, unknown> : undefined };
        if (stageRecord?.stage_run_id === input.expectedStageRunId && stageRecord.status === "failed") return { status: "failed" as const, error: String(stageRecord.first_exact_failure ?? "agent_stage_failed"), data: typeof stageRecord.data === "object" && stageRecord.data !== null ? stageRecord.data as Record<string, unknown> : undefined };
        await sleepImpl(2_000); continue;
      }
      record(status.diagnostic);
    } catch (error) {
      if (error instanceof AgentGetTerminalError) return { status: "failed" as const, error: error.message };
      throw error;
    }
    consecutiveFailures += 1;
    outageStartedAt ??= now();
    if (consecutiveFailures >= 3 && !healthProbed) {
      healthProbed = true; getAttemptCount += 1;
      try {
        const health = await agentGetJsonWithRetry({ endpoint: input.endpoint, token: input.token, route: "/healthz", validator: agentHealthResponse, stage: input.stage, attempt: statusAttempt, fetchImpl: input.fetchImpl, timestamp });
        if (health.ok && health.body.alive === true && health.body.current_stage === input.stage) record({ route: "/healthz", stage: input.stage, attempt: statusAttempt, httpStatus: health.status, errorName: null, causeCode: null, message: "agent_alive", timestamp: timestamp() });
        else if (!health.ok) record(health.diagnostic);
      } catch (error) {
        if (error instanceof AgentGetTerminalError) return { status: "failed" as const, error: error.message };
        throw error;
      }
    }
    if (outageStartedAt !== null && now() - outageStartedAt >= 8 * 60 * 1000) {
      const exactOrderActive = input.reconcileExactOrder ? await input.reconcileExactOrder().catch(() => null) : null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        for (const route of ["/healthz", "/status"] as const) {
          getAttemptCount += 1;
          try { const result = await agentGetJsonWithRetry({ endpoint: input.endpoint, token: input.token, route, validator: route === "/healthz" ? agentHealthResponse : agentStatusResponse, stage: input.stage, attempt: statusAttempt + attempt, fetchImpl: input.fetchImpl, timestamp }); if (!result.ok) record(result.diagnostic); }
          catch (error) { if (error instanceof AgentGetTerminalError) record(error.diagnostic); else throw error; }
        }
      }
      return { status: "failed" as const, error: compactTransportOutage({ stage: input.stage, outageStartedAt, now: now(), getAttemptCount, last: lastDiagnostic, lastSuccessAt: lastSuccessfulStatusAt, exactOrderActive }) };
    }
    await sleepImpl(backoff[Math.min(consecutiveFailures - 1, backoff.length - 1)]);
  }
  return { status: "failed" as const, error: "agent_stage_timeout" };
}

export async function pollInferenceStage(endpoint:string,token:string,expectedStageRunId:string,options: Partial<Omit<WaitForStageOptions, "endpoint" | "token" | "stage" | "expectedStageRunId" | "timeoutMs">> = {}) { return await waitForStage({ endpoint, token, stage: "inference", expectedStageRunId, timeoutMs: 25*60*1000, ...options }); }

export async function getArtifactMetadataWithRetry(input: { endpoint: string; token: string; taskId: string; fetchImpl?: typeof fetch; onDiagnostic?: (diagnostic: AgentTransportDiagnostic) => void; sleepImpl?: (milliseconds: number) => Promise<void> }) {
  const sleepImpl = input.sleepImpl ?? sleep;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const result = await agentGetJsonWithRetry({ endpoint: input.endpoint, token: input.token, route: `/artifacts/${input.taskId}/metadata`, validator: agentArtifactMetadataResponse(input.taskId), stage: "artifact_metadata", attempt, fetchImpl: input.fetchImpl });
      if (result.ok) return result.body;
      input.onDiagnostic?.(result.diagnostic);
    } catch (error) {
      if (error instanceof AgentGetTerminalError) throw error;
      throw error;
    }
    if (attempt < 4) await sleepImpl([2_000, 3_000, 5_000][attempt - 1]);
  }
  throw new Error("agent_artifact_metadata_transport_unavailable");
}

async function main() {
  const taskId = argument("--task-id");
  if (!taskId) throw new Error("--task-id is required; the coordinator never selects another task");
  if (process.argv.includes("--resume")) throw new Error("resume_not_enabled_for_live_executor");
  if (process.argv.includes("--execute-fresh")) {
    throw new Error("legacy_live_executor_disabled_use_image_session_supervisor");
  }
  const preflight = await preflightExactLocalImageTask(taskId);
  console.log(JSON.stringify({ ready_for_remote_preflight: true, creates_order: false, claims_task: false, task: { id: preflight.task.id, status: preflight.task.status, width: preflight.task.width, height: preflight.task.height }, model_preflight: preflight.modelPreflight, next: "immutable_agent_and_provider_cost_preflight" }, null, 2));
}

if (process.argv[1]?.endsWith("run-image-e2e.ts")) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : "image_e2e_failed"); process.exitCode = 1; });
}
