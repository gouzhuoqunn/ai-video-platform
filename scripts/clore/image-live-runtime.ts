/** Shared live adapter for the restricted Agent.  Importing it has no provider side effects. */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { claimImageTask, failImageTask, markImageTaskInferenceRetryBlocked } from "../../src/lib/image-generation/local-image-task-store";
import { type LocalArtifactReference } from "../../src/lib/image-generation/local-image-artifacts";
import { effectiveImageTaskLoras } from "../../src/lib/image-generation/image-loras";
import { loadCloreConfig } from "./config";
import { cloreRequest, CloreApiError, sleep } from "./client";
import { MarketplaceReadError, readLiveMarketplaceOutcome, readLiveOrdersSummary, readWalletSummary, type CloreOrderSummary, type MarketplaceReadEvidence } from "./live";
import { normalizeCloreServer } from "./marketplace";
import { rankFreshMarketplaceCandidates, type MarketScanEvidence } from "./live-market-selection";
import { createSessionNonce, isLocalWatchdogTaskInstalled, writeLocalWatchdogArmState } from "./watchdog-io";
import { agentGetJsonWithRetry, agentHealthResponse } from "./agent-get-transport";
import { clearTemporaryDeploymentDeny, recordDeploymentFailure, recordDeploymentSuccess, recordTemporaryDeploymentDeny } from "./deployment-host-blacklist";
import { agentPostJson, assertCallerAgentStageAcceptanceContract, buildPublicAgentBootstrap, createOrderWithRateLimit, getArtifactMetadataWithRetry, persistAndFinalizeExactLocalTask, pollInferenceStage, preflightExactLocalImageTask, resolveExactEligibleImageTask, startImageTaskLeaseHeartbeat, waitForStage, type AcceptedStage, type AgentStageAcceptanceEvidence, type EligibleImageTask } from "./run-image-e2e";
import { toAgentModelManifest, verifyAdditionalTaskLoraSources, verifyFiveImageModelSources, type AgentAdditionalLoraEntry, type AgentModelManifest } from "./image-model-preflight";
import { ensureLocalUi, verifyImageUi } from "./image-e2e-ui";
import { IMAGE_SESSION_LIMITS, planImageSession, type ImageSessionPlan } from "./image-session";
import type { ImageGpuClass } from "../../src/lib/image-generation/flux-stack";
import {
  assertRtx4090GoldenDeploymentProfile,
  buildRtx4090GoldenBootstrap,
  rtx4090GoldenDeploymentFingerprint,
  verifyRtx4090GoldenPublishedSources,
} from "../image-executor/rtx4090-golden-deployment-profile";
import { resilientCreateOrder, type ResilientCreateAttempt, type ResilientCreateCandidate } from "./resilient-create";
import { acquireOrderCreateLock, clearActiveOrder, readActiveOrder, writeActiveOrder, type ActiveCloreOrder } from "./order-state";

export type ImmutableRuntime = { commit: string; agentSourceSha256: string; agentSha256: string; controllerSha256: string; workflowSha256: string };
export type LiveSessionOrder = { orderId: string; endpoint: string; hostname: string; serverId: string; hourlyUsd: number; startingBalanceUsd: number; plan: ImageSessionPlan; token: string; tokenSha256: string; hardDeadlineAt: string; deploymentProfileFingerprint: string; modelManifest?: AgentModelManifest };
export type OwnedSessionOrder = Pick<LiveSessionOrder, "orderId" | "serverId" | "hourlyUsd" | "startingBalanceUsd" | "hardDeadlineAt" | "deploymentProfileFingerprint">;
export type StageTerminal = { stageRunId: string; status: "succeeded" | "failed"; error?: string; data?: Record<string, unknown> };
export type CandidateAttemptEvent = { attempt: number; serverId: string; hourlyUsd: number | null; event: "selected" | "candidate_already_rented" | "candidate_failed" | "order_created"; classification: string | null; marketplaceRefreshedAt: string; logicalAttemptId?: string; requestAttempts?: number };
export type MarketWaitEvent = MarketScanEvidence & { phase: "scanning_market" | "waiting_for_market" | "market_rate_limited" | "market_authentication_failed" | "market_transport_failed" | "market_invalid_json" | "market_schema_incompatible" | "market_provider_error"; cycle: number; nextScanAt: string | null; marketplaceRead?: Pick<MarketplaceReadEvidence, "classification" | "httpStatus" | "contentType" | "responseByteLength" | "bodySha256" | "selectedListField" | "rawListingCount"> };

const MAX_HOURS = 4;
const MAX_TOTAL = 1.50;
export const MAX_CANDIDATE_CREATE_ATTEMPTS = 5;
export const MARKET_NO_CANDIDATE_MESSAGE = "当前没有符合价格和配置要求的 RTX 4090，正在等待市场刷新。";
export const MARKET_WAIT_PAUSED_MESSAGE = "市场持续没有可用候选，搜索已暂停；可以继续等待市场。";
export const MARKET_REFRESH_INTERVAL_MS = 20_000;
export const MARKET_WAIT_TIMEOUT_MS = 30 * 60_000;
export const NO_COMPLIANT_RTX4090_CANDIDATE_MESSAGE = "当前符合价格和配置要求的 RTX 4090 已被租用，请稍后重试。";
const SESSION_SECRET_ROOT = path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions");

async function fetchArtifactWithTimeout(url: string, token: string, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const withDeadline = async <T>(operation: Promise<T>) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("remote_artifact_timeout")), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  try {
    const response = await withDeadline(fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }));
    const bytes = await withDeadline(response.arrayBuffer());
    return { response, bytes: Buffer.from(bytes) };
  } finally {
    clearTimeout(timer);
  }
}
const fixedConfig = (gpuClass: ImageGpuClass = "rtx4090") => ({
  ...loadCloreConfig(gpuClass === "rtx4090"
    ? { deploymentProfileFingerprint: rtx4090GoldenDeploymentFingerprint() }
    : {}),
  targetGpu: gpuClass === "rtx5090" ? "NVIDIA GeForce RTX 5090" as const : "NVIDIA GeForce RTX 4090" as const,
  minGpuVramGb: gpuClass === "rtx5090" ? 32 : 24,
  maxGpuPricePerHour: IMAGE_SESSION_LIMITS.maxHourlyUsd,
  orderType: "on-demand" as const,
});
const compact = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/(bearer\s+)[^\s]+/gi, "$1<redacted>").replace(/([?&](?:signature|token|credential)[^=&]*=)[^&\s]+/gi, "$1<redacted>").slice(0, 700);
const atomicJson = (file: string, value: unknown) => { mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`; const fd = openSync(tmp, "w", 0o600); try { writeSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); } renameSync(tmp, file); };

export function assertDownloadedPngMatchesMetadata(png: Buffer, metadata: { byte_size: unknown; sha256: unknown }) {
  const byteSize = Number(metadata.byte_size);
  if (!Number.isSafeInteger(byteSize) || byteSize !== png.length || typeof metadata.sha256 !== "string" || createHash("sha256").update(png).digest("hex") !== metadata.sha256) {
    throw new Error("remote_png_verification_failed");
  }
}

export function sessionPaths(sessionId: string) { const root = path.join(SESSION_SECRET_ROOT, sessionId); return { root, token: path.join(root, "agent-token.txt"), taskReceipt: (taskId: string) => path.join(root, "tasks", `${taskId}.json`), sessionReceipt: path.join(process.cwd(), ".secrets", "clore-image-session-receipt.json") }; }
export function writeSessionReceipt(value: Record<string, unknown>) { atomicJson(sessionPaths(String(value.sessionId)).sessionReceipt, value); }
export function writeTaskReceipt(sessionId: string, taskId: string, value: Record<string, unknown>) { atomicJson(sessionPaths(sessionId).taskReceipt(taskId), value); }
export function newSessionToken(sessionId: string) { const token = randomBytes(32).toString("base64url"); const file = sessionPaths(sessionId).token; mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${token}\n`, { mode: 0o600 }); return { token, sha256: createHash("sha256").update(token).digest("hex"), file }; }
function exactTaskIds(taskIds: readonly string[]) { if (!taskIds.length || new Set(taskIds).size !== taskIds.length) throw new Error("image_session_exact_task_ids_required"); const tasks = taskIds.map((id) => resolveExactEligibleImageTask(id)); const classes = new Set(tasks.map((task) => task.gpuClass)); if (classes.size !== 1) throw new Error("mixed_gpu_classes_are_not_allowed"); return tasks; }

export function isCandidateAlreadyRented(error: unknown) {
  return error instanceof CloreApiError && error.failure.classification === "candidate_already_rented";
}

export class MarketplaceWaitTimeoutError extends Error {
  constructor() { super(MARKET_WAIT_PAUSED_MESSAGE); this.name = "MarketplaceWaitTimeoutError"; }
}

function marketFailurePhase(classification: MarketplaceReadEvidence["classification"]): MarketWaitEvent["phase"] {
  if (classification === "rate_limited") return "market_rate_limited";
  if (classification === "authentication_failed") return "market_authentication_failed";
  if (classification === "transport_failed") return "market_transport_failed";
  if (classification === "invalid_json") return "market_invalid_json";
  if (classification === "schema_incompatible") return "market_schema_incompatible";
  return "market_provider_error";
}

function projectMarketplaceReadEvidence(evidence: MarketplaceReadEvidence): NonNullable<MarketWaitEvent["marketplaceRead"]> {
  return {
    classification: evidence.classification,
    httpStatus: evidence.httpStatus,
    contentType: evidence.contentType,
    responseByteLength: evidence.responseByteLength,
    bodySha256: evidence.bodySha256,
    selectedListField: evidence.selectedListField,
    rawListingCount: evidence.rawListingCount,
  };
}

function orderTimestampMs(order: CloreOrderSummary) {
  if (order.createdTimestamp !== null) {
    return order.createdTimestamp > 10_000_000_000
      ? order.createdTimestamp
      : order.createdTimestamp * 1_000;
  }
  const parsed = order.startedAt ? Date.parse(order.startedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A create/reconcile read may adopt exactly one active order and nothing else.
 * The pre-create zero check plus the held create lock make a timestamp-less,
 * single matching order safe; an older or additional active order is billing
 * ambiguity and must never be silently selected.
 */
export function resolveSingleCreatedOrder(input: {
  activeOrders: CloreOrderSummary[];
  serverId: string;
  requestStartedAt: Date;
  directOrderId?: string | null;
}) {
  const active = input.activeOrders.filter((order) => order.active && order.orderId);
  if (active.length > 1) throw new Error("active_order_state_ambiguous_after_create");
  const order = active[0] ?? null;
  if (!order) return null;
  if (input.directOrderId && order.orderId !== input.directOrderId) {
    throw new Error("create_order_id_mismatch_during_reconciliation");
  }
  if (order.serverId !== input.serverId) throw new Error("active_order_server_mismatch_after_create");
  const observedAt = orderTimestampMs(order);
  if (observedAt !== null && observedAt < input.requestStartedAt.getTime() - 120_000) {
    throw new Error("active_order_predates_create_attempt");
  }
  return order;
}

export async function createOrderWithCandidateFallback<Candidate extends ResilientCreateCandidate, Value>(input: {
  maximumCreateRequests?: number;
  activeOrderCount: () => Promise<number>;
  selectFreshCandidate: (attempted: ReadonlySet<string>) => Promise<Candidate | null>;
  create: (candidate: Candidate) => Promise<{ orderId: string | null; value: Value }>;
  reconcile: (candidate: Candidate, requestStartedAt: Date) => Promise<{ orderId: string; value: Value } | null>;
  onAttempt?: (attempt: ResilientCreateAttempt) => Promise<void> | void;
}) {
  try {
    return await resilientCreateOrder({
      maximumCreateRequests: input.maximumCreateRequests ?? MAX_CANDIDATE_CREATE_ATTEMPTS,
      activeOrderCount: input.activeOrderCount,
      selectFreshCandidate: input.selectFreshCandidate,
      create: input.create,
      reconcile: input.reconcile,
      onAttempt: input.onAttempt,
      shouldRetryOnNextCandidate: isCandidateAlreadyRented,
      noFreshCandidateError: () => new Error(MARKET_NO_CANDIDATE_MESSAGE),
    });
  } catch (error) {
    const attempts = (error as { resilientAttempts?: unknown[] } | null)?.resilientAttempts;
    if (isCandidateAlreadyRented(error) && Array.isArray(attempts) && attempts.length >= (input.maximumCreateRequests ?? MAX_CANDIDATE_CREATE_ATTEMPTS)) {
      throw new Error(MARKET_NO_CANDIDATE_MESSAGE);
    }
    throw error;
  }
}

/** Read-only prerequisites plus a bounded same-attempt fallback for an already-rented candidate. */
export async function createLiveSessionOrder(input: { sessionId: string; taskIds: string[]; immutable: ImmutableRuntime; execute: boolean; onOrderPersisted?: (order: OwnedSessionOrder) => Promise<void> | void; onCandidateAttempt?: (event: CandidateAttemptEvent) => Promise<void> | void; onMarketWait?: (event: MarketWaitEvent) => Promise<void> | void; onMarketEvidence?: (evidence: MarketplaceReadEvidence) => Promise<void> | void }): Promise<LiveSessionOrder> {
  if (!input.execute) throw new Error("image_session_execute_flag_required");
  const tasks = exactTaskIds(input.taskIds);
  const profile = assertRtx4090GoldenDeploymentProfile();
  assertCallerAgentStageAcceptanceContract(profile);
  await verifyRtx4090GoldenPublishedSources();
  const gpuClass = tasks[0].gpuClass as ImageGpuClass;
  if (gpuClass !== "rtx4090") throw new Error("rtx4090_golden_session_requires_rtx4090_tasks");
  const config = fixedConfig(gpuClass);
  const before = await readLiveOrdersSummary(config, { forceRefresh: true });
  if (before.some((order) => order.active)) throw new Error("active_clore_order_exists");
  for (const task of tasks) await preflightExactLocalImageTask(task.id);
  // Resolve and validate the union before create_order. Per-task preflight
  // cannot detect two different IDs claiming one filename or conflicting
  // immutable bytes across a batch; neither must reach a paid host.
  const modelManifest = await buildLiveAgentModelManifest(tasks);
  if (!isLocalWatchdogTaskInstalled()) throw new Error("local_watchdog_not_installed");
  const token = newSessionToken(input.sessionId); const command = buildPublicAgentBootstrap({ ...input.immutable, tokenSha256: token.sha256 });
  if (input.immutable.commit !== profile.immutable.commit || input.immutable.agentSourceSha256 !== profile.immutable.agentSourceSha256 || input.immutable.agentSha256 !== profile.immutable.agentSha256 || input.immutable.controllerSha256 !== profile.immutable.controllerSha256 || input.immutable.workflowSha256 !== profile.immutable.workflowSha256) throw new Error("rtx4090_golden_profile_identity_mismatch");
  if (command !== buildRtx4090GoldenBootstrap(token.sha256)) throw new Error("rtx4090_golden_profile_bootstrap_mismatch");
  type CandidateContext = { candidate: ReturnType<typeof normalizeCloreServer>; wallet: Awaited<ReturnType<typeof readWalletSummary>>; plan: ImageSessionPlan; marketplaceRefreshedAt: string; logicalAttemptNumber: number };
  const contexts = new Map<string, CandidateContext>();
  const attemptedAcrossCycles = new Set<string>();
  const persistedOrders = new Map<string, OwnedSessionOrder>();
  let fatalPostCreateError: Error | null = null;
  const persistCandidateOrder = async (context: CandidateContext, orderId: string) => {
    const existing = persistedOrders.get(orderId);
    if (existing) return existing;
    const hardDeadlineAt = new Date(Date.now() + MAX_HOURS * 3_600_000).toISOString();
    const owned: OwnedSessionOrder = {
      orderId,
      serverId: context.candidate.serverId,
      hourlyUsd: context.candidate.priceUsdPerHour ?? 0,
      startingBalanceUsd: context.wallet.availableUsdBalance ?? 0,
      hardDeadlineAt,
      deploymentProfileFingerprint: rtx4090GoldenDeploymentFingerprint(profile),
    };
    persistedOrders.set(orderId, owned);
    try {
      // The caller-owned receipt is written before any further provider read,
      // so an observed paid order cannot later be mislabeled "not_created".
      await input.onOrderPersisted?.(owned);
      writeActiveOrder({
        order_id: orderId,
        server_id: context.candidate.serverId,
        project_tag: "ai-video-platform-wan22",
        created_at: new Date().toISOString(),
        status: "order_pending",
        usd_per_hour: owned.hourlyUsd,
        max_price_usd_per_hour: config.maxGpuPricePerHour,
        order_type: "on-demand",
        open_ports: ["controller/http:8080"],
        gpu_type: context.candidate.gpu,
        gpu_profile: gpuClass,
        bootstrap_image: profile.image,
        deployment_profile_fingerprint: owned.deploymentProfileFingerprint,
        create_attempt_id: input.sessionId,
      });
      writeLocalWatchdogArmState({
        schemaVersion: 1,
        armed: true,
        sessionNonce: createSessionNonce(),
        serverId: owned.serverId,
        orderType: "on-demand",
        currency: config.rentalCurrency,
        startingBalanceUsd: owned.startingBalanceUsd,
        armedAt: new Date().toISOString(),
        drainingAt: new Date(Date.parse(hardDeadlineAt) - 10 * 60_000).toISOString(),
        hardDeadlineAt,
        hardBudgetUsd: MAX_TOTAL,
        budgetSafetyUsd: .05,
        emergencyStop: false,
      });
      return owned;
    } catch (error) {
      fatalPostCreateError = new Error(`post_create_local_persistence_failed:${compact(error)}`);
      throw fatalPostCreateError;
    }
  };
  let result: Awaited<ReturnType<typeof createOrderWithCandidateFallback>>;
  let lastMarketEvent: MarketWaitEvent | null = null;
  const waitingStartedAt = Date.now();
  for (let cycle = 0; ; cycle += 1) {
    if (attemptedAcrossCycles.size >= MAX_CANDIDATE_CREATE_ATTEMPTS) {
      const nextScanAt = new Date(Date.now() + MARKET_REFRESH_INTERVAL_MS).toISOString();
      const exhaustedEvent: MarketWaitEvent = lastMarketEvent
        ? { ...lastMarketEvent, phase: "waiting_for_market", cycle, nextScanAt, selectedServerId: null, selectedHourlyUsd: null }
        : {
          scannedAt: new Date().toISOString(),
          totalServerCount: null,
          compliantCandidateCount: null,
          rejectedServerIds: [],
          attemptedServerIds: [...attemptedAcrossCycles],
          selectedServerId: null,
          selectedHourlyUsd: null,
          filterCounts: null,
          phase: "waiting_for_market",
          cycle,
          nextScanAt,
        };
      lastMarketEvent = exhaustedEvent;
      await input.onMarketWait?.(exhaustedEvent);
      if (Date.now() - waitingStartedAt >= MARKET_WAIT_TIMEOUT_MS) throw new MarketplaceWaitTimeoutError();
      await sleep(MARKET_REFRESH_INTERVAL_MS);
      continue;
    }
    contexts.clear();
    const createLock = acquireOrderCreateLock(`${input.sessionId}:candidate-cycle-${cycle}`);
    try {
    result = await createOrderWithCandidateFallback({
    maximumCreateRequests: MAX_CANDIDATE_CREATE_ATTEMPTS - attemptedAcrossCycles.size,
    activeOrderCount: async () => (await readLiveOrdersSummary(config, { forceRefresh: true })).filter((order) => order.active).length,
    selectFreshCandidate: async (attempted) => {
      const marketplaceRefreshedAt = new Date().toISOString();
      const market = await readLiveMarketplaceOutcome(config, { forceRefresh: true });
      await input.onMarketEvidence?.(market.evidence);
      const allAttempted = new Set([...attemptedAcrossCycles, ...attempted]);
      if (market.classification !== "success_nonempty" && market.classification !== "success_empty") {
        await input.onMarketWait?.({
          scannedAt: market.evidence.capturedAt,
          totalServerCount: null,
          compliantCandidateCount: null,
          rejectedServerIds: [],
          attemptedServerIds: [...allAttempted],
          selectedServerId: null,
          selectedHourlyUsd: null,
          filterCounts: null,
          phase: marketFailurePhase(market.classification),
          cycle,
          nextScanAt: null,
          marketplaceRead: projectMarketplaceReadEvidence(market.evidence),
        });
        throw new MarketplaceReadError(market);
      }
      const ranked = rankFreshMarketplaceCandidates({ marketplace: market.servers, config, attemptedServerIds: allAttempted, now: () => marketplaceRefreshedAt });
      ranked.evidence.marketplaceRead = projectMarketplaceReadEvidence(market.evidence);
      const candidate = ranked.candidates[0] ?? null;
      lastMarketEvent = { ...ranked.evidence, phase: "scanning_market", cycle, nextScanAt: null, marketplaceRead: projectMarketplaceReadEvidence(market.evidence) };
      await input.onMarketWait?.(lastMarketEvent);
      if (!candidate?.priceUsdPerHour || !candidate.priceOriginalAmount) return null;
      const wallet = await readWalletSummary(config, { forceRefresh: true });
      const plan = { ...planImageSession(tasks, { gpuClass, activeOrderCount: 0, selectedHourlyUsd: candidate.priceUsdPerHour, walletBalanceUsd: wallet.availableUsdBalance }), selectedGpuModel: candidate.gpuNormalizedName };
      if (!plan.executionEligible || wallet.availableUsdBalance === null || wallet.availableUsdBalance - plan.projectedProviderCostCeilingUsd < IMAGE_SESSION_LIMITS.minimumWalletReserveUsd) throw new Error("image_session_cost_or_wallet_guard_failed");
      const logicalAttemptNumber = attemptedAcrossCycles.size + 1;
      const value = { candidate, wallet, plan, marketplaceRefreshedAt, logicalAttemptNumber }; contexts.set(candidate.serverId, value);
      attemptedAcrossCycles.add(candidate.serverId);
      await input.onCandidateAttempt?.({ attempt: logicalAttemptNumber, serverId: candidate.serverId, hourlyUsd: candidate.priceUsdPerHour, event: "selected", classification: null, marketplaceRefreshedAt, logicalAttemptId: input.sessionId });
      return { id: candidate.serverId, value };
    },
    create: async (entry) => {
      const context = contexts.get(entry.id); if (!context) throw new Error("candidate_context_missing");
      const payload = { currency: config.rentalCurrency, image: profile.image, renting_server: Number(context.candidate.serverId), type: "on-demand" as const, ports: profile.ports, required_price: context.candidate.priceOriginalAmount!, command };
      const requestStartedAt = new Date();
      const readAttemptOrders = async () => await readLiveOrdersSummary(config, { forceRefresh: true });
      const createOnce = async () => await createOrderWithRateLimit({
        serverId: context.candidate.serverId,
        createOnce: () => cloreRequest(config, "/create_order", { method: "POST", body: JSON.stringify(payload) }, {
          maxNetworkRetries: 1,
          maxRateLimitRetries: 0,
          onCreateUncertain: async () => {
            if (fatalPostCreateError) throw fatalPostCreateError;
            const orders = await readAttemptOrders();
            const active = orders.filter((order) => order.active && order.orderId);
            if (active.length > 1) throw new Error("active_order_state_ambiguous_after_create");
            return active.some((order) => order.serverId === context.candidate.serverId);
          },
          beforeCreateRetry: async () => {
            const active = (await readAttemptOrders()).filter((order) => order.active && order.orderId);
            if (active.length > 1) throw new Error("active_order_state_ambiguous_before_create_retry");
            if (active.length === 1) throw new Error("active_order_exists_before_create_retry");
          },
        }),
        reconcile: async () => ({ orders: await readAttemptOrders() }),
      });
      const outcome = await createOnce();
      const direct = outcome.adoptedOrderId ?? (outcome.created && typeof outcome.created === "object" ? String((outcome.created as Record<string, unknown>).id ?? (outcome.created as Record<string, unknown>).order_id ?? "") : "");
      if (fatalPostCreateError) throw fatalPostCreateError;
      if (direct) await persistCandidateOrder(context, direct);
      const active = await readAttemptOrders();
      const order = resolveSingleCreatedOrder({ activeOrders: active, serverId: context.candidate.serverId, requestStartedAt, directOrderId: direct || null });
      if (!order?.orderId) throw new Error("create_order_unreconciled");
      await persistCandidateOrder(context, order.orderId);
      return { orderId: order.orderId, value: { ...context, order } };
    },
    reconcile: async (entry) => {
      if (fatalPostCreateError) throw fatalPostCreateError;
      const context = contexts.get(entry.id); if (!context) return null;
      const active = await readLiveOrdersSummary(config, { forceRefresh: true });
      const matching = resolveSingleCreatedOrder({ activeOrders: active, serverId: context.candidate.serverId, requestStartedAt: new Date(0) });
      if (matching?.orderId) {
        await persistCandidateOrder(context, matching.orderId);
        return { orderId: matching.orderId, value: { ...context, order: matching } };
      }
      return null;
    },
    onAttempt: async (attempt) => {
      const context = contexts.get(attempt.candidateId);
      if (!context) return;
      const classification = attempt.failure && "classification" in attempt.failure ? attempt.failure.classification : null;
      const requestAttempts = attempt.failure && typeof attempt.failure === "object" && "requestAttempts" in attempt.failure && Number.isSafeInteger(attempt.failure.requestAttempts)
        ? attempt.failure.requestAttempts
        : attempt.result === "failed_request" || attempt.result === "reconciled_order" ? 1 : undefined;
      await input.onCandidateAttempt?.({ attempt: context.logicalAttemptNumber, serverId: attempt.candidateId, hourlyUsd: context.candidate.priceUsdPerHour, event: attempt.result === "failed_request" ? (classification === "candidate_already_rented" ? "candidate_already_rented" : "candidate_failed") : "order_created", classification, marketplaceRefreshedAt: context.marketplaceRefreshedAt, logicalAttemptId: input.sessionId, requestAttempts });
    },
    });
    break;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== MARKET_NO_CANDIDATE_MESSAGE) throw error;
      if (Date.now() - waitingStartedAt >= MARKET_WAIT_TIMEOUT_MS) throw new MarketplaceWaitTimeoutError();
      const nextScanAt = new Date(Date.now() + MARKET_REFRESH_INTERVAL_MS).toISOString();
      const waitingEvent: MarketWaitEvent = lastMarketEvent
        ? { ...lastMarketEvent, phase: "waiting_for_market", cycle: cycle + 1, nextScanAt }
        : {
          scannedAt: new Date().toISOString(),
          totalServerCount: 0,
          compliantCandidateCount: 0,
          rejectedServerIds: [],
          attemptedServerIds: [],
          selectedServerId: null,
          selectedHourlyUsd: null,
          filterCounts: {
            totalProviderListings: 0,
            exactRtx4090Listings: 0,
            rentableRtx4090Listings: 0,
            onDemandRtx4090Listings: 0,
            priceCompliantListings: 0,
            hardwareDeploymentCompliantListings: 0,
            fullyCompliantCandidates: 0,
            rejectionCounts: {},
          },
          phase: "waiting_for_market",
          cycle: cycle + 1,
          nextScanAt,
        };
      lastMarketEvent = waitingEvent;
      await input.onMarketWait?.(waitingEvent);
      await sleep(MARKET_REFRESH_INTERVAL_MS);
    } finally {
      createLock.release();
    }
  }
  const plan = result.order.value.plan; const order = result.order.value.order;
  const persisted = persistedOrders.get(order.orderId);
  if (!persisted) throw new Error("created_order_local_state_missing");
  let endpoint = order.controllerUrl;
  const deadline = Date.now() + 10 * 60_000;
  while (!endpoint && Date.now() < deadline) {
    await sleep(10_000);
    endpoint = (await readLiveOrdersSummary(config, { forceRefresh: true })).find((item) => item.orderId === order.orderId)?.controllerUrl ?? null;
  }
  if (!endpoint) {
    recordGoldenRuntimeDeploymentFailureEvidence({
      orderId: order.orderId,
      serverId: order.serverId,
      lastHttpStatus: null,
      profileFingerprint: persisted.deploymentProfileFingerprint,
    });
    throw new Error("order_endpoint_not_published_within_timeout");
  }
  return { orderId: order.orderId, endpoint, hostname: new URL(endpoint).hostname, serverId: persisted.serverId, hourlyUsd: persisted.hourlyUsd, startingBalanceUsd: persisted.startingBalanceUsd, plan, token: token.token, tokenSha256: token.sha256, hardDeadlineAt: persisted.hardDeadlineAt, deploymentProfileFingerprint: persisted.deploymentProfileFingerprint, modelManifest };
}

export class RuntimeDeploymentFailure extends Error {
  constructor(input: { order: Pick<LiveSessionOrder, "orderId" | "serverId">; elapsedMs: number; lastHttpStatus: number | null; lastStartupDiagnostic: string | null }) {
    super(JSON.stringify({ code: "runtime_deployment_failed_before_model_or_inference", message: "运行环境未启动成功，尚未进入模型加载或图片生成。", deploymentProfileId: "rtx4090-golden-agent-v1", image: "cloreai/jupyter:ubuntu24.04-v2", serverId: input.order.serverId, orderId: input.order.orderId, elapsedDeploymentMs: input.elapsedMs, lastHttpStatus: input.lastHttpStatus, controllerEverListened: false, lastStartupDiagnostic: input.lastStartupDiagnostic }));
    this.name = "RuntimeDeploymentFailure";
  }
}

export function recordGoldenRuntimeDeploymentFailureEvidence(
  input: { orderId: string; serverId: string; lastHttpStatus: number | null; profileFingerprint: string },
  paths: { historyPath?: string; denylistPath?: string } = {},
) {
  const reason = input.lastHttpStatus === 502 ? "golden_agent_proxy_502_timeout" : "golden_agent_health_timeout";
  const record = {
    serverId: input.serverId,
    orderId: input.orderId,
    reason,
    profileFingerprint: input.profileFingerprint,
  };
  // Retaining either record is useful, but an evidence-write failure must not
  // replace the deployment error or interrupt exact-order cleanup.
  try { recordDeploymentFailure(record, paths.historyPath); } catch { /* Preserve the primary deployment failure. */ }
  try { recordTemporaryDeploymentDeny(record, paths.denylistPath); } catch { /* Preserve the primary deployment failure. */ }
  return record;
}

export function recordGoldenRuntimeDeploymentSuccessEvidence(
  input: { orderId: string; serverId: string; profileFingerprint: string },
  paths: { historyPath?: string; denylistPath?: string } = {},
) {
  const record = {
    serverId: input.serverId,
    orderId: input.orderId,
    profileFingerprint: input.profileFingerprint,
  };
  try { recordDeploymentSuccess(record, paths.historyPath); } catch { /* Health success must remain authoritative. */ }
  try { clearTemporaryDeploymentDeny({ serverId: input.serverId, profileFingerprint: input.profileFingerprint }, paths.denylistPath); } catch { /* A stale deny entry must not replace a proven health success. */ }
  return record;
}

export async function waitForAgentIdle(order: LiveSessionOrder) {
  const started = Date.now(); let lastHttpStatus: number | null = null; let lastStartupDiagnostic: string | null = null;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = await agentGetJsonWithRetry({ endpoint: order.endpoint, token: order.token, route: "/healthz", validator: (body) => agentHealthResponse(body) && body.agent_contract === "stage-acceptance-v2" && body.agent_sha256 === assertRtx4090GoldenDeploymentProfile().immutable.agentSha256, attempt });
    if (result.ok && result.body.current_stage === "idle" && result.body.last_error === null) {
      recordGoldenRuntimeDeploymentSuccessEvidence({ orderId: order.orderId, serverId: order.serverId, profileFingerprint: order.deploymentProfileFingerprint });
      return;
    }
    if (!result.ok) { lastHttpStatus = result.diagnostic.httpStatus; lastStartupDiagnostic = result.diagnostic.message; }
    await sleep(5_000);
  }
  recordGoldenRuntimeDeploymentFailureEvidence({ orderId: order.orderId, serverId: order.serverId, lastHttpStatus, profileFingerprint: order.deploymentProfileFingerprint });
  throw new RuntimeDeploymentFailure({ order, elapsedMs: Date.now() - started, lastHttpStatus, lastStartupDiagnostic });
}
export async function invokeStage(order: LiveSessionOrder, stage: "environment" | "gpu" | "controller" | "comfyui" | "models", payload?: object, receipt?: { requested: (stageRunId: string) => void; accepted: (value: { stageRunId: string }) => void; evidence: (value: AgentStageAcceptanceEvidence) => void }): Promise<StageTerminal> { const accepted = await agentPostJson(order.endpoint, order.token, `/stage/${stage}`, payload, { onRequested: receipt?.requested, onEvidence: receipt?.evidence }); receipt?.accepted(accepted); const terminal = await waitForStage({ endpoint: order.endpoint, token: order.token, stage, expectedStageRunId: accepted.stageRunId, timeoutMs: stage === "models" ? 3 * 60 * 60_000 : 45 * 60_000, reconcileExactOrder: async () => Boolean((await readLiveOrdersSummary(fixedConfig(order.plan.selectedGpuClass === "RTX 5090" ? "rtx5090" : "rtx4090"), { forceRefresh: true })).find((item) => item.orderId === order.orderId)?.active) }); return { stageRunId: accepted.stageRunId, ...terminal }; }
export async function buildLiveAgentModelManifest(tasks: readonly EligibleImageTask[]) {
  const core = await verifyFiveImageModelSources();
  const byId = new Map<string, AgentAdditionalLoraEntry>();
  for (const task of tasks) {
    const additional = await verifyAdditionalTaskLoraSources(task.loras);
    for (const lora of additional.loras) {
      const existing = byId.get(lora.id);
      if (existing && (
        existing.filename !== lora.filename
        || existing.sha256 !== lora.sha256
        || existing.size_bytes !== lora.size_bytes
      )) throw new Error(`session_lora_identity_conflict:${lora.id}`);
      byId.set(lora.id, lora);
    }
  }
  return toAgentModelManifest(core.models, [...byId.values()]);
}

export async function installModelsOnce(order: LiveSessionOrder, tasks: readonly EligibleImageTask[], receipt?: { requested: (stageRunId: string) => void; accepted: (value: { stageRunId: string }) => void; evidence: (value: AgentStageAcceptanceEvidence) => void }, manifest?: AgentModelManifest) {
  return await invokeStage(order, "models", manifest ?? await buildLiveAgentModelManifest(tasks), receipt);
}
export async function capturePostFinalizationUiVerification(verify: () => Promise<void>) {
  try {
    await verify();
    return { uiVerified: true, uiVerificationError: null };
  } catch (error) {
    return { uiVerified: false, uiVerificationError: compact(error) };
  }
}
export async function submitTaskInference(order: LiveSessionOrder, task: EligibleImageTask, receipt: { sessionId: string; requested: (stageRunId: string) => void; submitting: () => void; accepted: (value: AcceptedStage) => void; evidence: (value: AgentStageAcceptanceEvidence) => void }): Promise<{ accepted: AcceptedStage; terminal: StageTerminal; artifact: LocalArtifactReference; controllerJobId: string | null; controllerPromptId: string | null; uiVerified: boolean; uiVerificationError: string | null }> {
  const claim = claimImageTask(task.id, `clore-image-session-${process.pid}`, 10 * 60_000); const heartbeat = startImageTaskLeaseHeartbeat({ taskId: task.id, claimToken: claim.claimToken, leaseMs: 10 * 60_000 });
  let finalized = false;
  try {
    heartbeat.assertHealthy(); const payload = {
      task_id: task.id,
      mode: "text_generation",
      prompt: task.prompt,
      negative_prompt: task.negativePrompt ?? "",
      loras: effectiveImageTaskLoras(task),
      width: task.width,
      height: task.height,
      steps: task.steps,
      cfg: task.cfg,
      lora_strength: task.loraStrength,
      seed: task.seed,
      sampler: task.sampler,
    };
    receipt.submitting();
    const accepted = await agentPostJson(order.endpoint, order.token, "/stage/inference", payload, {
      onRequested: (stageRunId) => {
        // This durable task tombstone is written synchronously before fetch().
        // If the process dies after the POST begins, neither group retry nor a
        // later session may submit the same task again.
        markImageTaskInferenceRetryBlocked(task.id, claim.claimToken, {
          sessionId: receipt.sessionId,
          stageRunId,
          inferenceState: "submitting",
        });
        receipt.requested(stageRunId);
      },
      onEvidence: receipt.evidence,
    });
    markImageTaskInferenceRetryBlocked(task.id, claim.claimToken, {
      sessionId: receipt.sessionId,
      stageRunId: accepted.stageRunId,
      inferenceState: "accepted",
    });
    receipt.accepted(accepted);
    const terminal = await pollInferenceStage(order.endpoint, order.token, accepted.stageRunId, { reconcileExactOrder: async () => Boolean((await readLiveOrdersSummary(fixedConfig(order.plan.selectedGpuClass === "RTX 5090" ? "rtx5090" : "rtx4090"), { forceRefresh: true })).find((item) => item.orderId === order.orderId)?.active) });
    if (terminal.status !== "succeeded") throw new Error(`inference_stage_failed:${compact(terminal.error)}`);
    const metadata = await getArtifactMetadataWithRetry({ endpoint: order.endpoint, token: order.token, taskId: task.id }); const image = await fetchArtifactWithTimeout(`${order.endpoint.replace(/\/$/, "")}/artifacts/${task.id}/image`, order.token); const png = image.bytes;
    if (!image.response.ok) throw new Error("remote_png_verification_failed");
    assertDownloadedPngMatchesMetadata(png, metadata);
    const artifact = (await persistAndFinalizeExactLocalTask({ task, claimToken: claim.claimToken, png, remote: { generationDurationSeconds: Number(metadata.generation_duration_seconds), orderId: order.orderId, gpuModel: order.plan.selectedGpuClass, controllerPromptId: typeof metadata.controller_prompt_id === "string" ? metadata.controller_prompt_id : null } })).artifact;
    finalized = true;
    const { uiVerified, uiVerificationError } = await capturePostFinalizationUiVerification(async () => {
      const ui = await ensureLocalUi({});
      try { await verifyImageUi({ taskId: task.id }); } finally { if (ui.started) ui.stop(); }
    });
    return { accepted, terminal: { stageRunId: accepted.stageRunId, ...terminal }, artifact, controllerJobId: typeof terminal.data?.controller_job_id === "string" ? terminal.data.controller_job_id : null, controllerPromptId: typeof terminal.data?.controller_prompt_id === "string" ? terminal.data.controller_prompt_id : null, uiVerified, uiVerificationError };
  } catch (error) { if (!finalized) { try { failImageTask(task.id, claim.claimToken, compact(error)); } catch { /* Preserve the primary inference error. */ } } throw error; } finally { heartbeat.stop(); }
}

export type CleanupLiveSessionResult = {
  cancellationState: "cancelled" | "reconciled_inactive" | "cancellation_unconfirmed";
  zeroConfirmations: number;
  watchdogDisarmed: boolean;
  localOrderStateCleared: boolean;
  cleanupConfirmed: boolean;
  cleanupErrors: string[];
};

export type CleanupLiveSessionDeps = {
  cancelOrder?: (orderId: string) => Promise<void>;
  readOrders?: () => Promise<CloreOrderSummary[]>;
  sleep?: (milliseconds: number) => Promise<void>;
  readActive?: () => ActiveCloreOrder | null;
  clearActive?: (orderId: string) => void;
  disarmWatchdog?: (order: Pick<LiveSessionOrder, "serverId" | "startingBalanceUsd">) => void;
};

/** Cleanup is only confirmed after two independent zero-active snapshots. */
export async function cleanupLiveSession(order: Pick<LiveSessionOrder, "orderId" | "serverId" | "startingBalanceUsd">, deps: CleanupLiveSessionDeps = {}): Promise<CleanupLiveSessionResult> {
  const config = fixedConfig();
  const errors: string[] = [];
  const cancelOrder = deps.cancelOrder ?? (async (orderId: string) => {
    await cloreRequest(config, "/cancel_order", { method: "POST", body: JSON.stringify({ id: orderId, issue: "image_session_complete_or_failed" }) });
  });
  const readOrders = deps.readOrders ?? (async () => await readLiveOrdersSummary(config, { forceRefresh: true }));
  const sleepImpl = deps.sleep ?? sleep;
  const readActive = deps.readActive ?? readActiveOrder;
  const clearActive = deps.clearActive ?? clearActiveOrder;
  const disarmWatchdog = deps.disarmWatchdog ?? ((owned: Pick<LiveSessionOrder, "serverId" | "startingBalanceUsd">) => {
    writeLocalWatchdogArmState({
      schemaVersion: 1,
      armed: false,
      sessionNonce: createSessionNonce(),
      serverId: owned.serverId,
      orderType: "on-demand",
      currency: config.rentalCurrency,
      startingBalanceUsd: owned.startingBalanceUsd,
      armedAt: new Date().toISOString(),
      drainingAt: new Date().toISOString(),
      hardDeadlineAt: new Date().toISOString(),
      hardBudgetUsd: MAX_TOTAL,
      budgetSafetyUsd: .05,
      emergencyStop: false,
    });
  });

  let cancelSucceeded = false;
  try {
    await cancelOrder(order.orderId);
    cancelSucceeded = true;
  } catch (error) {
    errors.push(compact(error));
  }

  let zeroConfirmations = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const active = await readOrders();
      if (!active.some((item) => item.active)) zeroConfirmations += 1;
      else errors.push("active_order_remains_after_cleanup");
    } catch (error) {
      errors.push(compact(error));
    }
    if (attempt === 0) await sleepImpl(1_200);
  }

  let localOrderStateCleared = false;
  if (zeroConfirmations === 2) {
    try {
      const active = readActive();
      if (!active) {
        localOrderStateCleared = true;
      } else if (active.order_id === order.orderId) {
        clearActive(order.orderId);
        localOrderStateCleared = true;
      } else {
        errors.push("local_active_order_mismatch_during_cleanup");
      }
    } catch (error) {
      errors.push(compact(error));
    }
  }

  let watchdogDisarmed = false;
  if (zeroConfirmations === 2 && localOrderStateCleared) {
    try {
      disarmWatchdog(order);
      watchdogDisarmed = true;
    } catch (error) {
      errors.push(compact(error));
    }
  } else {
    errors.push("watchdog_retained_until_cleanup_is_confirmed");
  }

  const cleanupConfirmed = zeroConfirmations === 2 && localOrderStateCleared && watchdogDisarmed;
  const cancellationState = cleanupConfirmed
    ? (cancelSucceeded ? "cancelled" : "reconciled_inactive")
    : "cancellation_unconfirmed";
  return { cancellationState, zeroConfirmations, watchdogDisarmed, localOrderStateCleared, cleanupConfirmed, cleanupErrors: errors };
}
