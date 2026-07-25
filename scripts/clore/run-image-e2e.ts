/** Local-only coordinator primitives for the restricted Clore image run.
 * Provider mutation remains deliberately absent until the full preflight path
 * invokes these exact-task primitives after runtime/model success.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claimImageTask, failImageTask, finalizeImageTask, readImageTask, renewImageTaskLease, type LocalImageTask, type LocalTaskStoreOptions } from "../../src/lib/image-generation/local-image-task-store";
import { publishLocalImageArtifact, type LocalArtifactReference } from "../../src/lib/image-generation/local-image-artifacts";
import { sanitizeImageModelPreflight, toAgentModelManifest, validateAgentModelManifestContract, verifyFiveImageModelSources } from "./image-model-preflight";
import { runImageE2e, claimTokenHash, type ModelEntry, type SanitizedImageE2eSession } from "./image-e2e-coordinator";
import { loadCloreConfig } from "./config";
import { cloreRequest, CloreApiError } from "./client";
import { readLiveMarketplace, readLiveOrdersSummary, readWalletSummary } from "./live";
import { computeCloreProjectedCost, normalizeCloreServer } from "./marketplace";
import { createSessionNonce, isLocalWatchdogTaskInstalled, writeLocalWatchdogArmState } from "./watchdog-io";
import { sleep } from "./client";
import { ensureLocalUi, verifyImageUi } from "./image-e2e-ui";

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
  const url = `https://raw.githubusercontent.com/gouzhuoqunn/ai-video-platform/${input.commit}/scripts/clore/diagnostic-agent.py`;
  return `python3 -c "import urllib.request as u,hashlib as h,os;p='/tmp/a.py';d=u.urlopen('${url}',timeout=30).read();assert h.sha256(d).hexdigest()=='${input.agentSha256}';open(p,'wb').write(d);os.execvp('python3',['python3',p,'--token-sha256','${input.tokenSha256}','--immutable','${input.commit}:${input.controllerSha256}:${input.workflowSha256}'])"`;
}

function sessionRead() { try { return JSON.parse(readFileSync(SESSION_PATH, "utf8")) as SanitizedImageE2eSession; } catch { return null; } }
function sessionWrite(value: SanitizedImageE2eSession) { mkdirSync(path.dirname(SESSION_PATH), { recursive: true }); writeFileSync(SESSION_PATH, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function tokenRead() { return existsSync(TOKEN_PATH) ? readFileSync(TOKEN_PATH, "utf8").trim() : ""; }
function tokenCreate() { const token = randomBytes(32).toString("base64url"); mkdirSync(path.dirname(TOKEN_PATH), { recursive: true }); writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 }); return token; }
function claimTokenWrite(token: string) { writeFileSync(CLAIM_TOKEN_PATH, `${token}\n`, { mode: 0o600 }); }
export type FreshReceipt={schema:1;runId:string;taskId:string;orderId:string|null;endpoint:string|null;currentStep:string;inferenceState:"not_started"|"submitting"|"accepted"|"succeeded"|"failed";inferenceSubmitted:boolean;inferenceSucceeded:boolean;inferenceSubmittingAt:string|null;inferenceAcceptedAt:string|null;acceptedHttpStatus:202|null;inferenceCompletedAt:string|null;remoteArtifactAvailable:boolean;controllerPromptId:string|null;remoteArtifact:{byteSize:number;sha256:string;width:number;height:number;generationDurationSeconds:number}|null;artifactDownloaded:boolean;localArtifactPublished:boolean;taskFinalized:boolean;uiVerified:boolean;orderCancelled:boolean;timestamps:Record<string,string>;firstError:string|null};
function receiptRead(receiptPath=RECEIPT_PATH){try{return JSON.parse(readFileSync(receiptPath,"utf8")) as FreshReceipt}catch{return null}}
function receiptWrite(value:FreshReceipt,receiptPath=RECEIPT_PATH){mkdirSync(path.dirname(receiptPath),{recursive:true});const tmp=`${receiptPath}.${process.pid}.tmp`;const descriptor=openSync(tmp,"w",0o600);try{writeSync(descriptor,`${JSON.stringify(value,null,2)}\n`);fsyncSync(descriptor)}finally{closeSync(descriptor)}renameSync(tmp,receiptPath)}
export function freshRunRequiresManualRecovery(receipt: Pick<FreshReceipt, "taskId" | "inferenceState"> | null, taskId: string, taskStatus: string | undefined) { return receipt?.taskId === taskId && ["submitting", "accepted", "succeeded"].includes(receipt.inferenceState) && taskStatus !== "completed"; }
function freshReceipt(taskId:string):FreshReceipt{return {schema:1,runId:randomBytes(12).toString("hex"),taskId,orderId:null,endpoint:null,currentStep:"prerental",inferenceState:"not_started",inferenceSubmitted:false,inferenceSucceeded:false,inferenceSubmittingAt:null,inferenceAcceptedAt:null,acceptedHttpStatus:null,inferenceCompletedAt:null,remoteArtifactAvailable:false,controllerPromptId:null,remoteArtifact:null,artifactDownloaded:false,localArtifactPublished:false,taskFinalized:false,uiVerified:false,orderCancelled:false,timestamps:{prerental:new Date().toISOString()},firstError:null}}
export function isSafeFailedReceiptForFreshRun(receipt:FreshReceipt|null,taskId:string,taskStatus:string|undefined){return receipt?.taskId===taskId&&receipt.inferenceState==="not_started"&&receipt.inferenceSubmitted===false&&receipt.taskFinalized===false&&receipt.orderCancelled===true&&taskStatus==="waiting_for_gpu"}
export async function prepareFreshReceipt(input:{taskId:string;taskStatus:string|undefined;activeOrderCount:()=>Promise<number>;receiptPath?:string;archiveDir?:string}){const receiptPath=input.receiptPath??RECEIPT_PATH;const archiveDir=input.archiveDir??RECEIPT_ARCHIVE_DIR;const previous=receiptRead(receiptPath);if(freshRunRequiresManualRecovery(previous,input.taskId,input.taskStatus))throw new Error("previous_inference_state_requires_manual_recovery");if(previous?.taskId===input.taskId){if(!isSafeFailedReceiptForFreshRun(previous,input.taskId,input.taskStatus))throw new Error("previous_receipt_not_safe_to_rotate");if(await input.activeOrderCount()!==0)throw new Error("previous_receipt_active_order_exists");mkdirSync(archiveDir,{recursive:true});const archivePath=path.join(archiveDir,`${previous.taskId}-${previous.runId}.json`);renameSync(receiptPath,archivePath)}const receipt=freshReceipt(input.taskId);receiptWrite(receipt,receiptPath);return receipt}
function url(endpoint: string, part: string) { return `${endpoint.replace(/\/$/, "")}${part}`; }
async function agentJson(endpoint: string, token: string, route: string, init: RequestInit = {}) { const response = await fetch(url(endpoint, route), { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`agent_http_${response.status}:${JSON.stringify(body).slice(0, 500)}`); return body as Record<string, unknown>; }
export async function submitInferenceStage(endpoint:string,token:string,payload:object){const r=await fetch(url(endpoint,"/stage/inference"),{method:"POST",headers:{Authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(payload)});if(r.status!==202)throw new Error(`inference_submit_http_${r.status}`);return {acceptedHttpStatus:202 as const}}
export async function pollInferenceStage(endpoint:string,token:string){return await waitForStage(endpoint,token,"inference",25*60*1000)}

export function resolveExactEligibleImageTask(taskId: string, options: LocalTaskStoreOptions = {}): EligibleImageTask {
  const task = readImageTask(taskId, options);
  if (!task || task.status !== "waiting_for_gpu" || task.mode !== "text_generation" || task.referenceImage || !Number.isInteger(task.width) || !Number.isInteger(task.height) || task.width > 1280 || task.height > 1280) {
    throw new Error("image_task_not_eligible_for_restricted_4090_run");
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

async function waitForStage(endpoint: string, token: string, stage: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await agentJson(endpoint, token, "/status"); const record = (status.stages as Record<string, Record<string, unknown>> | undefined)?.[stage];
    if (record?.status === "succeeded") return { status: "succeeded" as const, data: typeof record.data === "object" && record.data !== null ? record.data as Record<string, unknown> : undefined };
    if (record?.status === "failed") return { status: "failed" as const, error: String(record.first_exact_failure ?? "agent_stage_failed") };
    await sleep(2_000);
  }
  return { status: "failed" as const, error: "agent_stage_timeout" };
}

async function runLive(taskId: string, resume: boolean, commit: string, agentSha256: string, controllerSha256: string, workflowSha256: string) {
  const token = resume ? tokenRead() : tokenCreate(); if (!token) throw new Error("image_e2e_agent_token_missing_for_resume");
  const tokenSha256 = createHash("sha256").update(token).digest("hex");
  const config = { ...loadCloreConfig(), targetGpu: "NVIDIA GeForce RTX 4090" as const, minGpuVramGb: 24, maxGpuPricePerHour: MAX_HOURLY, orderType: "on-demand" as const };
  let selected: ReturnType<typeof normalizeCloreServer> | null = null; let startingBalance = 0;
  const deps = {
    now: () => new Date().toISOString(), persist: sessionWrite, load: sessionRead,
    readEligibleTask: async (id: string) => resolveExactEligibleImageTask(id),
    prerental: async (id: string) => {
      const orders = await readLiveOrdersSummary(config, { forceRefresh: true }); if (orders.some((item) => item.active)) throw new Error("active_clore_order_exists");
      await sleep(1_200); const market = await readLiveMarketplace(config, { forceRefresh: true });
      const candidates = market.map((raw) => normalizeCloreServer(raw, config)).filter((item) => item.gpuNormalizedName === "NVIDIA GeForce RTX 4090" && item.orderType === "on-demand" && item.hostOnline !== false && item.priceUsdPerHour !== null && item.priceUsdPerHour <= MAX_HOURLY && item.priceOriginalAmount !== null && item.priceOriginalUnit === "day");
      selected = candidates.find((item) => item.serverId === "98682") ?? candidates.sort((a, b) => (a.priceUsdPerHour ?? Infinity) - (b.priceUsdPerHour ?? Infinity))[0] ?? null;
      if (!selected) throw new Error("no_compliant_rtx4090_candidate"); const cost = computeCloreProjectedCost(selected.priceUsdPerHour, MAX_HOURS); if (!cost.projectedTotalUsd || cost.projectedTotalUsd > MAX_TOTAL) throw new Error("image_e2e_cost_guard_failed");
      const wallet = await readWalletSummary(config, { forceRefresh: true }); if (wallet.availableUsdBalance === null || wallet.availableUsdBalance < cost.projectedTotalUsd) throw new Error("insufficient_clore_balance"); startingBalance = wallet.availableUsdBalance;
      if (!isLocalWatchdogTaskInstalled()) throw new Error("local_watchdog_not_installed");
      await preflightExactLocalImageTask(id); return resolveExactEligibleImageTask(id);
    },
    createOrder: async () => {
      if (!selected?.priceOriginalAmount) throw new Error("image_e2e_candidate_missing");
      const command = buildPublicAgentBootstrap({ commit, agentSha256, controllerSha256, workflowSha256, tokenSha256 }); if (Buffer.byteLength(command, "utf8") >= 700) throw new Error("image_e2e_bootstrap_too_long");
      const payload = { currency: config.rentalCurrency, image: "cloreai/jupyter:ubuntu24.04-v2", renting_server: Number(selected.serverId), type: "on-demand", ports: { "8080": "http" }, required_price: selected.priceOriginalAmount, command };
      let created: unknown; for (let attempt = 0; attempt < 2; attempt += 1) { try { created = await cloreRequest(config, "/create_order", { method: "POST", body: JSON.stringify(payload) }, { maxNetworkRetries: 0, maxRateLimitRetries: 0 }); break; } catch (error) { if (!(error instanceof CloreApiError) || error.failure.code !== 1 || attempt) throw error; const active = await readLiveOrdersSummary(config, { forceRefresh: true }); if (active.some((item) => item.active)) break; await sleep(60_000); } }
      const direct = created && typeof created === "object" ? String((created as Record<string, unknown>).id ?? (created as Record<string, unknown>).order_id ?? "") : "";
      const active = await readLiveOrdersSummary(config, { forceRefresh: true }); const order = direct ? active.find((item) => item.orderId === direct) : active.filter((item) => item.active && item.serverId === selected!.serverId)[0];
      if (!order?.orderId) throw new Error("create_order_unreconciled");
      const deadline = new Date(Date.now() + MAX_HOURS * 60 * 60 * 1000); writeLocalWatchdogArmState({ schemaVersion: 1, armed: true, sessionNonce: createSessionNonce(), serverId: selected.serverId, orderType: "on-demand", currency: config.rentalCurrency, startingBalanceUsd: startingBalance, armedAt: new Date().toISOString(), drainingAt: new Date(deadline.getTime() - 10 * 60 * 1000).toISOString(), hardDeadlineAt: deadline.toISOString(), hardBudgetUsd: MAX_TOTAL, budgetSafetyUsd: .05, emergencyStop: false });
      let endpoint = order.controllerUrl; const endpointDeadline = Date.now() + 10 * 60 * 1000;
      while (!endpoint && Date.now() < endpointDeadline) { await sleep(10_000); endpoint = (await readLiveOrdersSummary(config, { forceRefresh: true })).find((item) => item.orderId === order.orderId)?.controllerUrl ?? null; }
      if (!endpoint) throw new Error("order_endpoint_not_published_within_timeout"); return { orderId: order.orderId, endpoint };
    },
    reconnect: async (orderId: string) => { const order = (await readLiveOrdersSummary(config, { forceRefresh: true })).find((item) => item.orderId === orderId); return { active: Boolean(order?.active), endpoint: order?.controllerUrl ?? null }; },
    armWatchdog: async () => undefined, disarmWatchdog: async () => { const current = sessionRead(); if (current) writeLocalWatchdogArmState({ schemaVersion: 1, armed: false, sessionNonce: createSessionNonce(), serverId: selected?.serverId ?? "98682", orderType: "on-demand", currency: config.rentalCurrency, startingBalanceUsd: startingBalance, armedAt: new Date().toISOString(), drainingAt: new Date().toISOString(), hardDeadlineAt: new Date().toISOString(), hardBudgetUsd: MAX_TOTAL, budgetSafetyUsd: .05, emergencyStop: false }); },
    health: async (endpoint: string) => { const deadline = Date.now() + 5 * 60 * 1000; let last: { alive: boolean; currentStage: string; lastError: string | null } = { alive: false, currentStage: "", lastError: "health_not_reached" }; while (Date.now() < deadline) { try { const body = await agentJson(endpoint, token, "/healthz"); last = { alive: body.alive === true, currentStage: String(body.current_stage ?? ""), lastError: body.last_error ? String(body.last_error) : null }; if (last.alive && last.currentStage === "idle" && !last.lastError) return last; } catch (error) { last.lastError = error instanceof Error ? error.message : "health_request_failed"; } await sleep(5_000); } return last; },
    stage: async (endpoint: string, stage: "environment" | "gpu" | "controller" | "comfyui" | "models" | "inference", payload?: object) => { if(stage==="inference")throw new Error("legacy_combined_inference_forbidden"); await agentJson(endpoint, token, `/stage/${stage}`, { method: "POST", headers: { "content-type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined }); return await waitForStage(endpoint, token, stage, stage === "models" ? 3 * 60 * 60 * 1000 : 45 * 60 * 1000); },
    submitInference: (endpoint:string,payload:object)=>submitInferenceStage(endpoint,token,payload),pollInference:(endpoint:string)=>pollInferenceStage(endpoint,token),
    inferenceReceipt:async(event,detail)=>{if(!ACTIVE_RECEIPT)throw new Error("fresh_receipt_missing");const now=new Date().toISOString();const base={...ACTIVE_RECEIPT,currentStep:`inference_${event}`,inferenceState:event,inferenceSubmitted:event!=="submitting",inferenceSucceeded:event==="succeeded",timestamps:{...ACTIVE_RECEIPT.timestamps,[`inference_${event}`]:now}};const next:FreshReceipt=event==="submitting"?{...base,inferenceSubmittingAt:now,inferenceAcceptedAt:null,acceptedHttpStatus:null,inferenceCompletedAt:null,remoteArtifactAvailable:false,controllerPromptId:null,remoteArtifact:null,firstError:null}:event==="accepted"?{...base,inferenceAcceptedAt:now,acceptedHttpStatus:detail?.acceptedHttpStatus===202?202:null}:event==="succeeded"?{...base,inferenceCompletedAt:now,remoteArtifactAvailable:Boolean(detail?.remoteArtifact),controllerPromptId:detail?.controllerPromptId??null,remoteArtifact:detail?.remoteArtifact??null}: {...base,inferenceCompletedAt:now,firstError:detail?.error??"inference_failed"};receiptWrite(next);ACTIVE_RECEIPT=next},
    receiptEvent:async(event,detail)=>{if(!ACTIVE_RECEIPT)throw new Error("fresh_receipt_missing");const now=new Date().toISOString();let next:FreshReceipt={...ACTIVE_RECEIPT,timestamps:{...ACTIVE_RECEIPT.timestamps,[event]:now}};if(event==="artifact_downloaded")next={...next,currentStep:event,artifactDownloaded:true,remoteArtifactAvailable:Boolean(detail?.remoteArtifact),controllerPromptId:detail?.controllerPromptId??next.controllerPromptId,remoteArtifact:detail?.remoteArtifact??next.remoteArtifact};else if(event==="task_finalized")next={...next,currentStep:event,taskFinalized:true};else if(event==="ui_verified")next={...next,currentStep:event,uiVerified:true};else next={...next,currentStep:event,orderCancelled:true};receiptWrite(next);ACTIVE_RECEIPT=next},
    resolveModels: async () => toAgentModelManifest((await verifyFiveImageModelSources()).models).models as ModelEntry[],
    claim: async (task: EligibleImageTask) => { const value = claimImageTask(task.id, `clore-image-e2e-${process.pid}`, 10 * 60 * 1000); claimTokenWrite(value.claimToken); return { token: value.claimToken, tokenHash: claimTokenHash(value.claimToken) }; },
    startHeartbeat: (id: string, claimToken: string) => startImageTaskLeaseHeartbeat({ taskId: id, claimToken, leaseMs: 10 * 60 * 1000 }),
    retrieveArtifact: async (endpoint: string, id: string) => { const metadata = await agentJson(endpoint, token, `/artifacts/${id}/metadata`); const response = await fetch(url(endpoint, `/artifacts/${id}/image`), { headers: { Authorization: `Bearer ${token}` } }); const png = Buffer.from(await response.arrayBuffer()); if (!response.ok || createHash("sha256").update(png).digest("hex") !== metadata.sha256) throw new Error("remote_png_verification_failed"); return { png, byteSize: Number(metadata.byte_size), sha256: String(metadata.sha256), width: Number(metadata.width), height: Number(metadata.height), generationDurationSeconds: Number(metadata.generation_duration_seconds), controllerPromptId: typeof metadata.controller_prompt_id === "string" ? metadata.controller_prompt_id : null }; },
    publishAndFinalize: async (task: EligibleImageTask, token: string, artifact: any, orderId: string) => persistAndFinalizeExactLocalTask({ task, claimToken: token, png: artifact.png, remote: { generationDurationSeconds: artifact.generationDurationSeconds, orderId, gpuModel: "RTX 4090", controllerPromptId: artifact.controllerPromptId }, onArtifactPublished: async () => { if(!ACTIVE_RECEIPT)throw new Error("fresh_receipt_missing");const now=new Date().toISOString();const next:FreshReceipt={...ACTIVE_RECEIPT,currentStep:"local_artifact_published",localArtifactPublished:true,timestamps:{...ACTIVE_RECEIPT.timestamps,local_artifact_published:now}};receiptWrite(next);ACTIVE_RECEIPT=next; } }).then((value) => { rmSync(CLAIM_TOKEN_PATH, { force: true }); return value.artifact; }),
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
    const task=readImageTask(taskId);const receipt=await prepareFreshReceipt({taskId,taskStatus:task?.status,activeOrderCount:async()=>{const config={...loadCloreConfig(),targetGpu:"NVIDIA GeForce RTX 4090" as const,minGpuVramGb:24,maxGpuPricePerHour:MAX_HOURLY,orderType:"on-demand" as const};return (await readLiveOrdersSummary(config,{forceRefresh:true})).filter((item)=>item.active).length}});ACTIVE_RECEIPT=receipt;
    try{console.log(JSON.stringify(await runLive(taskId,false,commit,agent,controller,workflow),null,2));receiptWrite({...ACTIVE_RECEIPT!,currentStep:"done",timestamps:{...ACTIVE_RECEIPT!.timestamps,done:new Date().toISOString()}})}catch(error){receiptWrite({...ACTIVE_RECEIPT!,currentStep:"failed",firstError:error instanceof Error?error.message.slice(0,800):"fresh_run_failed",timestamps:{...ACTIVE_RECEIPT!.timestamps,failed:new Date().toISOString()}});throw error}finally{ACTIVE_RECEIPT=null} return;
  }
  const preflight = await preflightExactLocalImageTask(taskId);
  console.log(JSON.stringify({ ready_for_remote_preflight: true, creates_order: false, claims_task: false, task: { id: preflight.task.id, status: preflight.task.status, width: preflight.task.width, height: preflight.task.height }, model_preflight: preflight.modelPreflight, next: "immutable_agent_and_provider_cost_preflight" }, null, 2));
}

if (process.argv[1]?.endsWith("run-image-e2e.ts")) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : "image_e2e_failed"); process.exitCode = 1; });
}
