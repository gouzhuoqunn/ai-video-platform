/** Local-only coordinator primitives for the restricted Clore image run.
 * Provider mutation remains deliberately absent until the full preflight path
 * invokes these exact-task primitives after runtime/model success.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claimImageTask, failImageTask, finalizeImageTask, mutateImageTasks, readImageTask, renewImageTaskLease, type LocalImageTask, type LocalTaskStoreOptions } from "../../src/lib/image-generation/local-image-task-store";
import { classifyImageGpu } from "../../src/lib/image-generation/flux-stack";
import { buildRtx4090GoldenBootstrap, RTX4090_GOLDEN_DEPLOYMENT_PROFILE } from "../image-executor/rtx4090-golden-deployment-profile";
import { publishLocalImageArtifact, type LocalArtifactReference } from "../../src/lib/image-generation/local-image-artifacts";
import { sanitizeImageModelPreflight, toAgentModelManifest, validateAgentModelManifestContract, verifyFiveImageModelSources } from "./image-model-preflight";
import { runImageE2e, claimTokenHash, type ModelEntry, type SanitizedImageE2eSession } from "./image-e2e-coordinator";
import { loadCloreConfig } from "./config";
import { cloreRequest, CloreApiError, CloreRateLimitError } from "./client";
import { readLiveMarketplace, readLiveOrdersSummary, readWalletSummary } from "./live";
import { computeCloreProjectedCost, normalizeCloreServer } from "./marketplace";
import { createSessionNonce, isLocalWatchdogTaskInstalled, writeLocalWatchdogArmState } from "./watchdog-io";
import { sleep } from "./client";
import { ensureLocalUi, verifyImageUi } from "./image-e2e-ui";
import { agentArtifactMetadataResponse, agentGetJsonWithRetry, agentHealthResponse, agentStatusResponse, AgentGetTerminalError, type AgentTransportDiagnostic } from "./agent-get-transport";

export type EligibleImageTask = LocalImageTask & { prompt: string; mode: "text_generation"; referenceImage: null; width: number; height: number; steps: number; cfg: number; loraStrength: number; seed: number; sampler: "Euler" | "FlowMatch" };
const SESSION_PATH = path.join(process.cwd(), ".secrets", "clore-image-e2e-session.json");
const TOKEN_PATH = path.join(process.cwd(), ".secrets", "clore-image-e2e-agent-token.txt");
const CLAIM_TOKEN_PATH = path.join(process.cwd(), ".secrets", "clore-image-e2e-claim-token.txt");
const RECEIPT_PATH = path.join(process.cwd(), ".secrets", "clore-image-e2e-fresh-receipt.json");
const RECEIPT_ARCHIVE_DIR = path.join(process.cwd(), ".secrets", "diagnostics", "clore-image-e2e-receipts");
const MAX_HOURS = 4; const MAX_HOURLY = .30; const MAX_TOTAL = 1.50;
let ACTIVE_RECEIPT: FreshReceipt | null = null;

export function buildPublicAgentBootstrap(input: { commit: string; agentSha256: string; controllerSha256: string; workflowSha256: string; tokenSha256: string }) {
  if (![input.commit, input.agentSha256, input.controllerSha256, input.workflowSha256, input.tokenSha256].every((value) => /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(value))) throw new Error("immutable_agent_bootstrap_values_required");
  const profile = assertGoldenBootstrapIdentity(input);
  return buildRtx4090GoldenBootstrap(profile.tokenSha256);
}

function assertGoldenBootstrapIdentity(input: { commit: string; agentSha256: string; controllerSha256: string; workflowSha256: string; tokenSha256: string }) {
  const immutable = RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable;
  if (input.commit !== immutable.commit || input.agentSha256 !== immutable.agentSha256 || input.controllerSha256 !== immutable.controllerSha256 || input.workflowSha256 !== immutable.workflowSha256) {
    throw new Error("rtx4090_golden_bootstrap_identity_mismatch");
  }
  return { tokenSha256: input.tokenSha256 };
}

function sessionRead() { try { return JSON.parse(readFileSync(SESSION_PATH, "utf8")) as SanitizedImageE2eSession; } catch { return null; } }
function sessionWrite(value: SanitizedImageE2eSession) { mkdirSync(path.dirname(SESSION_PATH), { recursive: true }); writeFileSync(SESSION_PATH, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function tokenRead() { return existsSync(TOKEN_PATH) ? readFileSync(TOKEN_PATH, "utf8").trim() : ""; }
function tokenCreate() { const token = randomBytes(32).toString("base64url"); mkdirSync(path.dirname(TOKEN_PATH), { recursive: true }); writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 }); return token; }
function claimTokenWrite(token: string) { writeFileSync(CLAIM_TOKEN_PATH, `${token}\n`, { mode: 0o600 }); }
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

function matchingCreatedOrder(orders: ActiveOrderSnapshot["orders"], serverId: string) { return orders.find((order) => order.active && order.serverId === serverId && order.orderId) ?? null; }
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
    throw new Error(JSON.stringify({ code: "create_order_rate_limit_persisted", http_status: 429, retry_after_ms: second.retryAfterMs, clore_code: second.code, attempt: 2 }));
  }
}
function url(endpoint: string, part: string) { return `${endpoint.replace(/\/$/, "")}${part}`; }
export type AcceptedStage = { acceptedHttpStatus: 202; stage: string; stageRunId: string };
function acceptedStage(route: string, status: number, body: Record<string, unknown>): AcceptedStage {
  const stage = route.replace(/^\/stage\//, ""); const stageRunId = body.stage_run_id;
  if (status !== 202 || body.accepted !== true || body.stage !== stage || typeof stageRunId !== "string" || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(stageRunId)) throw new Error(`agent_stage_acceptance_invalid:${stage}`);
  return { acceptedHttpStatus: 202, stage, stageRunId };
}
export async function agentPostJson(endpoint: string, token: string, route: string, payload?: object): Promise<AcceptedStage> {
  const response = await fetch(url(endpoint, route), { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`agent_post_http_${response.status}:${JSON.stringify(body).slice(0, 500)}`);
  return acceptedStage(route, response.status, body as Record<string, unknown>);
}
export async function submitInferenceStage(endpoint:string,token:string,payload:object){return await agentPostJson(endpoint,token,"/stage/inference",payload)}

export function resolveExactEligibleImageTask(taskId: string, options: LocalTaskStoreOptions = {}): EligibleImageTask {
  const task = readImageTask(taskId, options);
  if (!task || task.status !== "waiting_for_gpu" || task.mode !== "text_generation" || task.referenceImage || classifyImageGpu(Number(task.width), Number(task.height)) !== task.gpuClass) {
    throw new Error("image_task_not_eligible_for_restricted_text_run");
  }
  return task as EligibleImageTask;
}

/** Pre-rental only: it deliberately does not claim a task or call Clore. */
export async function preflightExactLocalImageTask(taskId: string, options: LocalTaskStoreOptions = {}, verifyModels = verifyFiveImageModelSources) {
  const task = resolveExactEligibleImageTask(taskId, options);
  const modelPreflight = await verifyModels();
  // Exercise the identical explicit projection used by the live coordinator
  // before a provider mutation. The returned preflight remains sanitized.
  validateAgentModelManifestContract(toAgentModelManifest(modelPreflight.models));
  const reread = readImageTask(taskId, options);
  if (!reread || reread.status !== "waiting_for_gpu") throw new Error("image_task_changed_during_prerental_preflight");
  return { task, modelPreflight: sanitizeImageModelPreflight(modelPreflight), createsOrder: false, claimsTask: false };
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

async function runLive(taskId: string, resume: boolean, commit: string, agentSha256: string, controllerSha256: string, workflowSha256: string, initialOrderSnapshot: ActiveOrderSnapshot) {
  const token = resume ? tokenRead() : tokenCreate(); if (!token) throw new Error("image_e2e_agent_token_missing_for_resume");
  const tokenSha256 = createHash("sha256").update(token).digest("hex");
  const config = { ...loadCloreConfig(), targetGpu: "NVIDIA GeForce RTX 4090" as const, minGpuVramGb: 24, maxGpuPricePerHour: MAX_HOURLY, orderType: "on-demand" as const };
  let selected: ReturnType<typeof normalizeCloreServer> | null = null; let startingBalance = 0; let activeOrderId: string | null = null; let orderSnapshot = initialOrderSnapshot;
  let transportDiagnostics: AgentTransportDiagnostic[] = [];
  let createDiagnostics: CreateRateLimitDiagnostic[] = [];
  const appendTransportDiagnostic = (diagnostic: AgentTransportDiagnostic) => { transportDiagnostics = [...transportDiagnostics, diagnostic].slice(-60); const current = sessionRead(); if (current) sessionWrite({ ...current, transportDiagnostics }); };
  const appendCreateDiagnostic = (diagnostic: CreateRateLimitDiagnostic) => { createDiagnostics = [...createDiagnostics, diagnostic].slice(-4); const current = sessionRead(); if (current) sessionWrite({ ...current, createDiagnostics }); };
  const refreshOrderSnapshot = async () => { orderSnapshot = { orders: await readLiveOrdersSummary(config, { forceRefresh: true }), checkedAt: Date.now() }; return orderSnapshot; };
  const deps = {
    now: () => new Date().toISOString(), persist: (session: SanitizedImageE2eSession) => sessionWrite({ ...session, transportDiagnostics, createDiagnostics }), load: sessionRead,
    readEligibleTask: async (id: string) => resolveExactEligibleImageTask(id),
    prerental: async (id: string) => {
      if (orderSnapshot.orders.some((item) => item.active)) throw new Error("active_clore_order_exists");
      await sleep(1_200); const market = await readLiveMarketplace(config, { forceRefresh: true });
      const candidates = market.map((raw) => normalizeCloreServer(raw, config)).filter((item) => item.gpuNormalizedName === "NVIDIA GeForce RTX 4090" && item.orderType === "on-demand" && item.hostOnline !== false && item.priceUsdPerHour !== null && item.priceUsdPerHour <= MAX_HOURLY && item.priceOriginalAmount !== null && item.priceOriginalUnit === "day");
      selected = candidates.find((item) => item.serverId === "98682") ?? candidates.sort((a, b) => (a.priceUsdPerHour ?? Infinity) - (b.priceUsdPerHour ?? Infinity))[0] ?? null;
      if (!selected) throw new Error("no_compliant_rtx4090_candidate"); const cost = computeCloreProjectedCost(selected.priceUsdPerHour, MAX_HOURS); if (!cost.projectedTotalUsd || cost.projectedTotalUsd > MAX_TOTAL) throw new Error("image_e2e_cost_guard_failed");
      const wallet = await readWalletSummary(config, { forceRefresh: true }); if (wallet.availableUsdBalance === null || wallet.availableUsdBalance < cost.projectedTotalUsd) throw new Error("insufficient_clore_balance"); startingBalance = wallet.availableUsdBalance;
      if (!isLocalWatchdogTaskInstalled()) throw new Error("local_watchdog_not_installed");
      await preflightExactLocalImageTask(id);
      if (Date.now() - orderSnapshot.checkedAt > 10_000) await refreshOrderSnapshot();
      if (orderSnapshot.orders.some((item) => item.active)) throw new Error("active_clore_order_exists");
      return resolveExactEligibleImageTask(id);
    },
    createOrder: async () => {
      if (!selected?.priceOriginalAmount) throw new Error("image_e2e_candidate_missing");
      const command = buildPublicAgentBootstrap({ commit, agentSha256, controllerSha256, workflowSha256, tokenSha256 }); if (Buffer.byteLength(command, "utf8") >= 700) throw new Error("image_e2e_bootstrap_too_long");
      const payload = { currency: config.rentalCurrency, image: "cloreai/jupyter:ubuntu24.04-v2", renting_server: Number(selected.serverId), type: "on-demand", ports: { "8080": "http" }, required_price: selected.priceOriginalAmount, command };
      if (Date.now() - orderSnapshot.checkedAt > 10_000) await refreshOrderSnapshot();
      if (orderSnapshot.orders.some((item) => item.active)) throw new Error("active_clore_order_exists");
      let created: unknown = null; let adoptedOrderId: string | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) { try {
        const outcome = await createOrderWithRateLimit({ serverId: selected.serverId, createOnce: () => cloreRequest(config, "/create_order", { method: "POST", body: JSON.stringify(payload) }, { maxNetworkRetries: 0, maxRateLimitRetries: 0 }), reconcile: refreshOrderSnapshot, onDiagnostic: appendCreateDiagnostic });
        created = outcome.created; adoptedOrderId = outcome.adoptedOrderId; break;
      } catch (error) { if (!(error instanceof CloreApiError) || error.failure.code !== 1 || attempt) throw error; await refreshOrderSnapshot(); if (orderSnapshot.orders.some((item) => item.active)) break; await sleep(60_000); } }
      const direct = adoptedOrderId ?? (created && typeof created === "object" ? String((created as Record<string, unknown>).id ?? (created as Record<string, unknown>).order_id ?? "") : "");
      const active = (await refreshOrderSnapshot()).orders; const order = direct ? active.find((item) => item.orderId === direct) : active.filter((item) => item.active && item.serverId === selected!.serverId)[0];
      if (!order?.orderId) throw new Error("create_order_unreconciled");
      const deadline = new Date(Date.now() + MAX_HOURS * 60 * 60 * 1000); writeLocalWatchdogArmState({ schemaVersion: 1, armed: true, sessionNonce: createSessionNonce(), serverId: selected.serverId, orderType: "on-demand", currency: config.rentalCurrency, startingBalanceUsd: startingBalance, armedAt: new Date().toISOString(), drainingAt: new Date(deadline.getTime() - 10 * 60 * 1000).toISOString(), hardDeadlineAt: deadline.toISOString(), hardBudgetUsd: MAX_TOTAL, budgetSafetyUsd: .05, emergencyStop: false });
      let endpoint = order.controllerUrl; const endpointDeadline = Date.now() + 10 * 60 * 1000;
      while (!endpoint && Date.now() < endpointDeadline) { await sleep(10_000); endpoint = (await readLiveOrdersSummary(config, { forceRefresh: true })).find((item) => item.orderId === order.orderId)?.controllerUrl ?? null; }
      if (!endpoint) throw new Error("order_endpoint_not_published_within_timeout"); activeOrderId = order.orderId; return { orderId: order.orderId, endpoint };
    },
    reconnect: async (orderId: string) => { activeOrderId = orderId; const order = (await readLiveOrdersSummary(config, { forceRefresh: true })).find((item) => item.orderId === orderId); return { active: Boolean(order?.active), endpoint: order?.controllerUrl ?? null }; },
    armWatchdog: async () => undefined, disarmWatchdog: async () => { const current = sessionRead(); if (current) writeLocalWatchdogArmState({ schemaVersion: 1, armed: false, sessionNonce: createSessionNonce(), serverId: selected?.serverId ?? "98682", orderType: "on-demand", currency: config.rentalCurrency, startingBalanceUsd: startingBalance, armedAt: new Date().toISOString(), drainingAt: new Date().toISOString(), hardDeadlineAt: new Date().toISOString(), hardBudgetUsd: MAX_TOTAL, budgetSafetyUsd: .05, emergencyStop: false }); },
    health: async (endpoint: string) => { const deadline = Date.now() + 5 * 60 * 1000; let last: { alive: boolean; currentStage: string; lastError: string | null } = { alive: false, currentStage: "", lastError: "health_not_reached" }; let attempt = 0; while (Date.now() < deadline) { attempt += 1; try { const result = await agentGetJsonWithRetry({ endpoint, token, route: "/healthz", validator: agentHealthResponse, stage: null, attempt }); if (!result.ok) { appendTransportDiagnostic(result.diagnostic); last.lastError = result.diagnostic.message; await sleep(5_000); continue; } last = { alive: result.body.alive === true, currentStage: String(result.body.current_stage ?? ""), lastError: result.body.last_error ? String(result.body.last_error) : null }; if (last.alive && last.currentStage === "idle" && !last.lastError) return last; } catch (error) { if (error instanceof AgentGetTerminalError) { appendTransportDiagnostic(error.diagnostic); last.lastError = error.message; break; } throw error; } await sleep(5_000); } return last; },
    stage: async (endpoint: string, stage: "environment" | "gpu" | "controller" | "comfyui" | "models" | "inference", payload?: object) => { if(stage==="inference")throw new Error("legacy_combined_inference_forbidden"); const accepted=await agentPostJson(endpoint, token, `/stage/${stage}`, payload); return await waitForStage({ endpoint, token, stage, expectedStageRunId:accepted.stageRunId, timeoutMs: stage === "models" ? 3 * 60 * 60 * 1000 : 45 * 60 * 1000, onDiagnostic: appendTransportDiagnostic, reconcileExactOrder: async () => { if (!activeOrderId) return null; return Boolean((await readLiveOrdersSummary(config, { forceRefresh: true })).find((order) => order.orderId === activeOrderId)?.active); } }); },
    submitInference: (endpoint:string,payload:object)=>submitInferenceStage(endpoint,token,payload),pollInference:(endpoint:string,stageRunId:string)=>pollInferenceStage(endpoint,token,stageRunId,{onDiagnostic:appendTransportDiagnostic,reconcileExactOrder:async()=>{if(!activeOrderId)return null;return Boolean((await readLiveOrdersSummary(config,{forceRefresh:true})).find((order)=>order.orderId===activeOrderId)?.active)}}),
    inferenceReceipt:async(event,detail)=>{if(!ACTIVE_RECEIPT)throw new Error("fresh_receipt_missing");const now=new Date().toISOString();const base={...ACTIVE_RECEIPT,currentStep:`inference_${event}`,inferenceState:event,inferenceSubmitted:event!=="submitting",inferenceSucceeded:event==="succeeded",timestamps:{...ACTIVE_RECEIPT.timestamps,[`inference_${event}`]:now}};const next:FreshReceipt=event==="submitting"?{...base,inferenceSubmittingAt:now,inferenceAcceptedAt:null,acceptedHttpStatus:null,inferenceCompletedAt:null,remoteArtifactAvailable:false,controllerPromptId:null,inferenceFailure:null,remoteArtifact:null,firstError:null}:event==="accepted"?{...base,inferenceAcceptedAt:now,acceptedHttpStatus:detail?.acceptedHttpStatus===202?202:null}:event==="succeeded"?{...base,inferenceCompletedAt:now,remoteArtifactAvailable:Boolean(detail?.remoteArtifact),controllerPromptId:detail?.controllerPromptId??null,inferenceFailure:null,remoteArtifact:detail?.remoteArtifact??null}: {...base,inferenceCompletedAt:now,controllerPromptId:detail?.controllerPromptId??base.controllerPromptId,inferenceFailure:detail?.failure??null,firstError:detail?.error??"inference_failed"};receiptWrite(next);ACTIVE_RECEIPT=next},
    receiptEvent:async(event,detail)=>{if(!ACTIVE_RECEIPT)throw new Error("fresh_receipt_missing");const now=new Date().toISOString();let next:FreshReceipt={...ACTIVE_RECEIPT,timestamps:{...ACTIVE_RECEIPT.timestamps,[event]:now}};if(event==="artifact_downloaded")next={...next,currentStep:event,artifactDownloaded:true,remoteArtifactAvailable:Boolean(detail?.remoteArtifact),controllerPromptId:detail?.controllerPromptId??next.controllerPromptId,remoteArtifact:detail?.remoteArtifact??next.remoteArtifact};else if(event==="task_finalized")next={...next,currentStep:event,taskFinalized:true};else if(event==="ui_verified")next={...next,currentStep:event,uiVerified:true};else next={...next,currentStep:event,orderCancelled:true};receiptWrite(next);ACTIVE_RECEIPT=next},
    resolveModels: async () => toAgentModelManifest((await verifyFiveImageModelSources()).models).models as ModelEntry[],
    claim: async (task: EligibleImageTask) => { const value = claimImageTask(task.id, `clore-image-e2e-${process.pid}`, 10 * 60 * 1000); claimTokenWrite(value.claimToken); return { token: value.claimToken, tokenHash: claimTokenHash(value.claimToken) }; },
    startHeartbeat: (id: string, claimToken: string) => startImageTaskLeaseHeartbeat({ taskId: id, claimToken, leaseMs: 10 * 60 * 1000 }),
    retrieveArtifact: async (endpoint: string, id: string) => { const metadata = await getArtifactMetadataWithRetry({ endpoint, token, taskId: id, onDiagnostic: appendTransportDiagnostic }); const response = await fetch(url(endpoint, `/artifacts/${id}/image`), { headers: { Authorization: `Bearer ${token}` } }); const png = Buffer.from(await response.arrayBuffer()); if (!response.ok || createHash("sha256").update(png).digest("hex") !== metadata.sha256) throw new Error("remote_png_verification_failed"); return { png, byteSize: Number(metadata.byte_size), sha256: String(metadata.sha256), width: Number(metadata.width), height: Number(metadata.height), generationDurationSeconds: Number(metadata.generation_duration_seconds), controllerPromptId: typeof metadata.controller_prompt_id === "string" ? metadata.controller_prompt_id : null }; },
    publishAndFinalize: async (task: EligibleImageTask, token: string, artifact: { png: Buffer; generationDurationSeconds: number; controllerPromptId: string | null }, orderId: string) => persistAndFinalizeExactLocalTask({ task, claimToken: token, png: artifact.png, remote: { generationDurationSeconds: artifact.generationDurationSeconds, orderId, gpuModel: "RTX 4090", controllerPromptId: artifact.controllerPromptId }, onArtifactPublished: async () => { if(!ACTIVE_RECEIPT)throw new Error("fresh_receipt_missing");const now=new Date().toISOString();const next:FreshReceipt={...ACTIVE_RECEIPT,currentStep:"local_artifact_published",localArtifactPublished:true,timestamps:{...ACTIVE_RECEIPT.timestamps,local_artifact_published:now}};receiptWrite(next);ACTIVE_RECEIPT=next; } }).then((value) => { rmSync(CLAIM_TOKEN_PATH, { force: true }); return value.artifact; }),
    verifyUi: async (id: string) => { const ui = await ensureLocalUi({}); try { await verifyImageUi({ taskId: id, screenshotPath: path.join("D:\\AI-Video-Library", "diagnostics", `image-e2e-${id}.png`) }); } finally { if (ui.started) ui.stop(); } }, failClaim: async (id: string, token: string, error: string) => { failImageTask(id, token, error); rmSync(CLAIM_TOKEN_PATH, { force: true }); },
    cancelExactOrder: async (id: string) => { await cloreRequest(config, "/cancel_order", { method: "POST", body: JSON.stringify({ id, issue: "image_e2e_complete_or_failed" }) }); },
    confirmNoActiveOrders: async () => { if ((await readLiveOrdersSummary(config, { forceRefresh: true })).some((item) => item.active)) throw new Error("active_order_remains_after_cancel"); },
  };
  return await runImageE2e({ taskId, immutableCommit: commit, tokenFile: TOKEN_PATH, tokenSha256, resume }, deps);
}

async function main() {
  const taskId = argument("--task-id");
  if (!taskId) throw new Error("--task-id is required; the coordinator never selects another task");
  if (process.argv.includes("--resume")) throw new Error("resume_not_enabled_for_live_executor");
  if (process.argv.includes("--execute-fresh")) {
    const commit = argument("--immutable-commit"); const agent = argument("--agent-sha256"); const controller = argument("--controller-sha256"); const workflow = argument("--workflow-sha256");
    if (!commit || !agent || !controller || !workflow) throw new Error("immutable_commit_and_agent_hashes_required");
    let task=readImageTask(taskId);const config={...loadCloreConfig(),targetGpu:"NVIDIA GeForce RTX 4090" as const,minGpuVramGb:24,maxGpuPricePerHour:MAX_HOURLY,orderType:"on-demand" as const};const initialOrderSnapshot:ActiveOrderSnapshot={orders:await readLiveOrdersSummary(config,{forceRefresh:true}),checkedAt:Date.now()};if(task?.status==="failed"){requeueSafeFailedExactImageTask({taskId,receipt:receiptRead(),activeOrderCount:initialOrderSnapshot.orders.filter((item)=>item.active).length});task=readImageTask(taskId)}const receipt=await prepareFreshReceipt({taskId,taskStatus:task?.status,activeOrderCount:async()=>initialOrderSnapshot.orders.filter((item)=>item.active).length});ACTIVE_RECEIPT=receipt;
    try{console.log(JSON.stringify(await runLive(taskId,false,commit,agent,controller,workflow,initialOrderSnapshot),null,2));receiptWrite({...ACTIVE_RECEIPT!,currentStep:"done",timestamps:{...ACTIVE_RECEIPT!.timestamps,done:new Date().toISOString()}})}catch(error){receiptWrite({...ACTIVE_RECEIPT!,currentStep:"failed",firstError:error instanceof Error?error.message.slice(0,800):"fresh_run_failed",timestamps:{...ACTIVE_RECEIPT!.timestamps,failed:new Date().toISOString()}});throw error}finally{ACTIVE_RECEIPT=null} return;
  }
  const preflight = await preflightExactLocalImageTask(taskId);
  console.log(JSON.stringify({ ready_for_remote_preflight: true, creates_order: false, claims_task: false, task: { id: preflight.task.id, status: preflight.task.status, width: preflight.task.width, height: preflight.task.height }, model_preflight: preflight.modelPreflight, next: "immutable_agent_and_provider_cost_preflight" }, null, 2));
}

if (process.argv[1]?.endsWith("run-image-e2e.ts")) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : "image_e2e_failed"); process.exitCode = 1; });
}
