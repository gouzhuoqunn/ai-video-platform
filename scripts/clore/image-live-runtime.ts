/** Shared live adapter for the restricted Agent.  Importing it has no provider side effects. */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { claimImageTask, failImageTask } from "../../src/lib/image-generation/local-image-task-store";
import { type LocalArtifactReference } from "../../src/lib/image-generation/local-image-artifacts";
import { loadCloreConfig } from "./config";
import { cloreRequest, CloreApiError, sleep } from "./client";
import { readLiveMarketplace, readLiveOrdersSummary, readWalletSummary } from "./live";
import { normalizeCloreServer } from "./marketplace";
import { createSessionNonce, isLocalWatchdogTaskInstalled, writeLocalWatchdogArmState } from "./watchdog-io";
import { agentGetJsonWithRetry, agentHealthResponse } from "./agent-get-transport";
import { agentPostJson, buildPublicAgentBootstrap, createOrderWithRateLimit, getArtifactMetadataWithRetry, persistAndFinalizeExactLocalTask, pollInferenceStage, preflightExactLocalImageTask, resolveExactEligibleImageTask, startImageTaskLeaseHeartbeat, waitForStage, type AcceptedStage, type EligibleImageTask } from "./run-image-e2e";
import { toAgentModelManifest, verifyFiveImageModelSources } from "./image-model-preflight";
import { ensureLocalUi, verifyImageUi } from "./image-e2e-ui";
import { IMAGE_SESSION_LIMITS, planImageSession, type ImageSessionPlan } from "./image-session";
import type { ImageGpuClass } from "../../src/lib/image-generation/flux-stack";
import { assertRtx4090GoldenDeploymentProfile, buildRtx4090GoldenBootstrap } from "../image-executor/rtx4090-golden-deployment-profile";

export type ImmutableRuntime = { commit: string; agentSha256: string; controllerSha256: string; workflowSha256: string };
export type LiveSessionOrder = { orderId: string; endpoint: string; hostname: string; serverId: string; hourlyUsd: number; startingBalanceUsd: number; plan: ImageSessionPlan; token: string; tokenSha256: string; hardDeadlineAt: string };
export type StageTerminal = { stageRunId: string; status: "succeeded" | "failed"; error?: string; data?: Record<string, unknown> };

const MAX_HOURS = 4;
const MAX_TOTAL = 1.50;
const SESSION_SECRET_ROOT = path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions");
const fixedConfig = (gpuClass: ImageGpuClass = "rtx4090") => ({ ...loadCloreConfig(), targetGpu: gpuClass === "rtx5090" ? "NVIDIA GeForce RTX 5090" as const : "NVIDIA GeForce RTX 4090" as const, minGpuVramGb: gpuClass === "rtx5090" ? 32 : 24, maxGpuPricePerHour: IMAGE_SESSION_LIMITS.maxHourlyUsd, orderType: "on-demand" as const });
const compact = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/(bearer\s+)[^\s]+/gi, "$1<redacted>").replace(/([?&](?:signature|token|credential)[^=&]*=)[^&\s]+/gi, "$1<redacted>").slice(0, 700);
const atomicJson = (file: string, value: unknown) => { mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`; const fd = openSync(tmp, "w", 0o600); try { writeSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); } renameSync(tmp, file); };

export function sessionPaths(sessionId: string) { const root = path.join(SESSION_SECRET_ROOT, sessionId); return { root, token: path.join(root, "agent-token.txt"), taskReceipt: (taskId: string) => path.join(root, "tasks", `${taskId}.json`), sessionReceipt: path.join(process.cwd(), ".secrets", "clore-image-session-receipt.json") }; }
export function writeSessionReceipt(value: Record<string, unknown>) { atomicJson(sessionPaths(String(value.sessionId)).sessionReceipt, value); }
export function writeTaskReceipt(sessionId: string, taskId: string, value: Record<string, unknown>) { atomicJson(sessionPaths(sessionId).taskReceipt(taskId), value); }
export function newSessionToken(sessionId: string) { const token = randomBytes(32).toString("base64url"); const file = sessionPaths(sessionId).token; mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${token}\n`, { mode: 0o600 }); return { token, sha256: createHash("sha256").update(token).digest("hex"), file }; }
function exactTaskIds(taskIds: readonly string[]) { if (!taskIds.length || new Set(taskIds).size !== taskIds.length) throw new Error("image_session_exact_task_ids_required"); const tasks = taskIds.map((id) => resolveExactEligibleImageTask(id)); const classes = new Set(tasks.map((task) => task.gpuClass)); if (classes.size !== 1) throw new Error("mixed_gpu_classes_are_not_allowed"); return tasks; }

/** Read-only prerequisites plus one explicit order creation.  No replacement order is attempted. */
export async function createLiveSessionOrder(input: { sessionId: string; taskIds: string[]; immutable: ImmutableRuntime; execute: boolean }): Promise<LiveSessionOrder> {
  if (!input.execute) throw new Error("image_session_execute_flag_required");
  const tasks = exactTaskIds(input.taskIds);
  const gpuClass = tasks[0].gpuClass as ImageGpuClass;
  const config = fixedConfig(gpuClass);
  const before = await readLiveOrdersSummary(config, { forceRefresh: true });
  if (before.some((order) => order.active)) throw new Error("active_clore_order_exists");
  for (const task of tasks) await preflightExactLocalImageTask(task.id);
  const market = await readLiveMarketplace(config, { forceRefresh: true });
  const candidates = market.map((raw) => normalizeCloreServer(raw, config)).filter((item) => item.gpuNormalizedName === config.targetGpu && item.orderType === "on-demand" && item.hostOnline !== false && item.priceUsdPerHour !== null && item.priceUsdPerHour <= IMAGE_SESSION_LIMITS.maxHourlyUsd && item.priceOriginalAmount !== null && item.priceOriginalUnit === "day").sort((left, right) => (left.priceUsdPerHour ?? Infinity) - (right.priceUsdPerHour ?? Infinity) || left.serverId.localeCompare(right.serverId));
  const selected = candidates[0] ?? null;
  if (!selected?.priceUsdPerHour || !selected.priceOriginalAmount) throw new Error(`no_compliant_${gpuClass}_candidate_available`);
  const wallet = await readWalletSummary(config, { forceRefresh: true });
  const plan = { ...planImageSession(tasks, { gpuClass, activeOrderCount: 0, selectedHourlyUsd: selected.priceUsdPerHour, walletBalanceUsd: wallet.availableUsdBalance }), selectedGpuModel: selected.gpuNormalizedName };
  if (!plan.executionEligible || wallet.availableUsdBalance === null || wallet.availableUsdBalance - plan.projectedProviderCostCeilingUsd < IMAGE_SESSION_LIMITS.minimumWalletReserveUsd) throw new Error("image_session_cost_or_wallet_guard_failed");
  if (!isLocalWatchdogTaskInstalled()) throw new Error("local_watchdog_not_installed");
  const token = newSessionToken(input.sessionId); const command = buildPublicAgentBootstrap({ ...input.immutable, tokenSha256: token.sha256 });
  const profile = assertRtx4090GoldenDeploymentProfile();
  if (input.immutable.commit !== profile.immutable.commit || input.immutable.agentSha256 !== profile.immutable.agentSha256 || input.immutable.controllerSha256 !== profile.immutable.controllerSha256 || input.immutable.workflowSha256 !== profile.immutable.workflowSha256) throw new Error("rtx4090_golden_profile_identity_mismatch");
  if (command !== buildRtx4090GoldenBootstrap(token.sha256)) throw new Error("rtx4090_golden_profile_bootstrap_mismatch");
  const fresh = await readLiveOrdersSummary(config, { forceRefresh: true }); if (fresh.some((order) => order.active)) throw new Error("active_clore_order_exists");
  const payload = { currency: config.rentalCurrency, image: profile.image, renting_server: Number(selected.serverId), type: "on-demand", ports: profile.ports, required_price: selected.priceOriginalAmount, command };
  let created: unknown = null;
  try { created = (await createOrderWithRateLimit({ serverId: selected.serverId, createOnce: () => cloreRequest(config, "/create_order", { method: "POST", body: JSON.stringify(payload) }, { maxNetworkRetries: 0, maxRateLimitRetries: 0 }), reconcile: async () => ({ orders: await readLiveOrdersSummary(config, { forceRefresh: true }) }) })).created; }
  catch (error) { if (error instanceof CloreApiError && error.failure.code === 1) { const retryOrders = await readLiveOrdersSummary(config, { forceRefresh: true }); if (retryOrders.some((order) => order.active)) throw error; await sleep(60_000); created = (await createOrderWithRateLimit({ serverId: selected.serverId, createOnce: () => cloreRequest(config, "/create_order", { method: "POST", body: JSON.stringify(payload) }, { maxNetworkRetries: 0, maxRateLimitRetries: 0 }), reconcile: async () => ({ orders: await readLiveOrdersSummary(config, { forceRefresh: true }) }) })).created; } else throw error; }
  const direct = created && typeof created === "object" ? String((created as Record<string, unknown>).id ?? (created as Record<string, unknown>).order_id ?? "") : "";
  const active = await readLiveOrdersSummary(config, { forceRefresh: true }); const order = direct ? active.find((item) => item.orderId === direct) : active.filter((item) => item.active && item.serverId === selected.serverId)[0];
  if (!order?.orderId) throw new Error("create_order_unreconciled");
  const hardDeadlineAt = new Date(Date.now() + MAX_HOURS * 3_600_000).toISOString();
  writeLocalWatchdogArmState({ schemaVersion: 1, armed: true, sessionNonce: createSessionNonce(), serverId: selected.serverId, orderType: "on-demand", currency: config.rentalCurrency, startingBalanceUsd: wallet.availableUsdBalance, armedAt: new Date().toISOString(), drainingAt: new Date(Date.parse(hardDeadlineAt) - 10 * 60_000).toISOString(), hardDeadlineAt, hardBudgetUsd: MAX_TOTAL, budgetSafetyUsd: .05, emergencyStop: false });
  let endpoint = order.controllerUrl; const deadline = Date.now() + 10 * 60_000; while (!endpoint && Date.now() < deadline) { await sleep(10_000); endpoint = (await readLiveOrdersSummary(config, { forceRefresh: true })).find((item) => item.orderId === order.orderId)?.controllerUrl ?? null; }
  if (!endpoint) {
    // Creation has already mutated the provider, so endpoint publication failure
    // must not escape without the same exact-order cleanup path.
    await cleanupLiveSession({ orderId: order.orderId, serverId: selected.serverId, startingBalanceUsd: wallet.availableUsdBalance });
    throw new Error("order_endpoint_not_published_within_timeout");
  }
  return { orderId: order.orderId, endpoint, hostname: new URL(endpoint).hostname, serverId: selected.serverId, hourlyUsd: selected.priceUsdPerHour, startingBalanceUsd: wallet.availableUsdBalance, plan, token: token.token, tokenSha256: token.sha256, hardDeadlineAt };
}

export class RuntimeDeploymentFailure extends Error {
  constructor(input: { order: LiveSessionOrder; elapsedMs: number; lastHttpStatus: number | null; lastStartupDiagnostic: string | null }) {
    super(JSON.stringify({ code: "runtime_deployment_failed_before_model_or_inference", message: "运行环境未启动成功，尚未进入模型加载或图片生成。", deploymentProfileId: "rtx4090-golden-agent-v1", image: "cloreai/jupyter:ubuntu24.04-v2", serverId: input.order.serverId, orderId: input.order.orderId, elapsedDeploymentMs: input.elapsedMs, proxyUrl: input.order.endpoint, lastHttpStatus: input.lastHttpStatus, controllerEverListened: false, lastStartupDiagnostic: input.lastStartupDiagnostic }));
    this.name = "RuntimeDeploymentFailure";
  }
}

export async function waitForAgentIdle(order: LiveSessionOrder) {
  const started = Date.now(); let lastHttpStatus: number | null = null; let lastStartupDiagnostic: string | null = null;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = await agentGetJsonWithRetry({ endpoint: order.endpoint, token: order.token, route: "/healthz", validator: agentHealthResponse, attempt });
    if (result.ok && result.body.current_stage === "idle" && result.body.last_error === null) return;
    if (!result.ok) { lastHttpStatus = result.diagnostic.httpStatus; lastStartupDiagnostic = result.diagnostic.message; }
    await sleep(5_000);
  }
  throw new RuntimeDeploymentFailure({ order, elapsedMs: Date.now() - started, lastHttpStatus, lastStartupDiagnostic });
}
export async function invokeStage(order: LiveSessionOrder, stage: "environment" | "gpu" | "controller" | "comfyui" | "models", payload?: object): Promise<StageTerminal> { const accepted = await agentPostJson(order.endpoint, order.token, `/stage/${stage}`, payload); const terminal = await waitForStage({ endpoint: order.endpoint, token: order.token, stage, expectedStageRunId: accepted.stageRunId, timeoutMs: stage === "models" ? 3 * 60 * 60_000 : 45 * 60_000, reconcileExactOrder: async () => Boolean((await readLiveOrdersSummary(fixedConfig(order.plan.selectedGpuClass === "RTX 5090" ? "rtx5090" : "rtx4090"), { forceRefresh: true })).find((item) => item.orderId === order.orderId)?.active) }); return { stageRunId: accepted.stageRunId, ...terminal }; }
export async function installModelsOnce(order: LiveSessionOrder) { const models = toAgentModelManifest((await verifyFiveImageModelSources()).models); return await invokeStage(order, "models", models); }
export async function submitTaskInference(order: LiveSessionOrder, task: EligibleImageTask, receipt?: { submitting: () => void; accepted: (value: AcceptedStage) => void }): Promise<{ accepted: AcceptedStage; terminal: StageTerminal; artifact: LocalArtifactReference; controllerJobId: string | null; controllerPromptId: string | null; uiVerified: boolean; uiVerificationError: string | null }> {
  const claim = claimImageTask(task.id, `clore-image-session-${process.pid}`, 10 * 60_000); const heartbeat = startImageTaskLeaseHeartbeat({ taskId: task.id, claimToken: claim.claimToken, leaseMs: 10 * 60_000 });
  let finalized = false;
  try {
    heartbeat.assertHealthy(); const payload = { task_id: task.id, mode: "text_generation", prompt: task.prompt, width: task.width, height: task.height, steps: task.steps, cfg: task.cfg, lora_strength: task.loraStrength, seed: task.seed, sampler: task.sampler };
    receipt?.submitting(); const accepted = await agentPostJson(order.endpoint, order.token, "/stage/inference", payload); receipt?.accepted(accepted);
    const terminal = await pollInferenceStage(order.endpoint, order.token, accepted.stageRunId, { reconcileExactOrder: async () => Boolean((await readLiveOrdersSummary(fixedConfig(order.plan.selectedGpuClass === "RTX 5090" ? "rtx5090" : "rtx4090"), { forceRefresh: true })).find((item) => item.orderId === order.orderId)?.active) });
    if (terminal.status !== "succeeded") throw new Error(`inference_stage_failed:${compact(terminal.error)}`);
    const metadata = await getArtifactMetadataWithRetry({ endpoint: order.endpoint, token: order.token, taskId: task.id }); const image = await fetch(`${order.endpoint.replace(/\/$/, "")}/artifacts/${task.id}/image`, { headers: { Authorization: `Bearer ${order.token}` } }); const png = Buffer.from(await image.arrayBuffer());
    if (!image.ok || createHash("sha256").update(png).digest("hex") !== metadata.sha256) throw new Error("remote_png_verification_failed");
    const artifact = (await persistAndFinalizeExactLocalTask({ task, claimToken: claim.claimToken, png, remote: { generationDurationSeconds: Number(metadata.generation_duration_seconds), orderId: order.orderId, gpuModel: order.plan.selectedGpuClass, controllerPromptId: typeof metadata.controller_prompt_id === "string" ? metadata.controller_prompt_id : null } })).artifact;
    finalized = true;
    let uiVerified = true; let uiVerificationError: string | null = null;
    try { const ui = await ensureLocalUi({}); try { await verifyImageUi({ taskId: task.id }); } finally { if (ui.started) ui.stop(); } } catch (error) { uiVerified = false; uiVerificationError = compact(error); }
    return { accepted, terminal: { stageRunId: accepted.stageRunId, ...terminal }, artifact, controllerJobId: typeof terminal.data?.controller_job_id === "string" ? terminal.data.controller_job_id : null, controllerPromptId: typeof terminal.data?.controller_prompt_id === "string" ? terminal.data.controller_prompt_id : null, uiVerified, uiVerificationError };
  } catch (error) { if (!finalized) { try { failImageTask(task.id, claim.claimToken, compact(error)); } catch { /* Preserve the primary inference error. */ } } throw error; } finally { heartbeat.stop(); }
}

/** Best-effort cleanup: each safety action runs even if an earlier network operation failed. */
export async function cleanupLiveSession(order: Pick<LiveSessionOrder, "orderId" | "serverId" | "startingBalanceUsd">) {
  const config = fixedConfig(); const errors: string[] = []; let cancellationState: "cancelled" | "reconciled_inactive" | "cancellation_failed" = "cancellation_failed";
  try { await cloreRequest(config, "/cancel_order", { method: "POST", body: JSON.stringify({ id: order.orderId, issue: "image_session_complete_or_failed" }) }); cancellationState = "cancelled"; } catch (error) { errors.push(compact(error)); }
  let zero = false; for (let attempt = 0; attempt < 2; attempt += 1) { try { const active = await readLiveOrdersSummary(config, { forceRefresh: true }); zero = !active.some((item) => item.active); if (!zero) errors.push("active_order_remains_after_cleanup"); } catch (error) { errors.push(compact(error)); } if (attempt === 0) await sleep(1_200); }
  if (zero && cancellationState !== "cancelled") cancellationState = "reconciled_inactive";
  let watchdogDisarmed = false;
  try { writeLocalWatchdogArmState({ schemaVersion: 1, armed: false, sessionNonce: createSessionNonce(), serverId: order.serverId, orderType: "on-demand", currency: config.rentalCurrency, startingBalanceUsd: order.startingBalanceUsd, armedAt: new Date().toISOString(), drainingAt: new Date().toISOString(), hardDeadlineAt: new Date().toISOString(), hardBudgetUsd: MAX_TOTAL, budgetSafetyUsd: .05, emergencyStop: false }); watchdogDisarmed = true; } catch (error) { errors.push(compact(error)); }
  return { cancellationState, zeroConfirmations: zero ? 2 : 0, watchdogDisarmed, cleanupErrors: errors };
}
