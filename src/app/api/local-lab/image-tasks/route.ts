import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { FLUX_IMAGE_STACK, IMAGE_RESOLUTION_5090_MAX, IMAGE_RESOLUTION_MIN, IMAGE_RESOLUTION_STEP, classifyImageGpu, type ImageGpuClass, type ImageTaskSettings } from "@/lib/image-generation/flux-stack";
import { finiteNumber } from "@/lib/image-generation/formatters";
import {
  assertImageTaskLoraSelections,
  normalizeNegativePrompt,
  type ImageTaskLora,
} from "@/lib/image-generation/image-loras";
import { confirmImageTaskGroup, deletePendingImageTaskGroup, retryFailedImageTaskGroup, unconfirmImageTaskGroup } from "@/lib/image-generation/image-task-groups";
import { AMBIGUOUS_INFERENCE_RETRY_CLASSIFICATION, AMBIGUOUS_INFERENCE_RETRY_MESSAGE, requiresManualInferenceRecovery } from "@/lib/image-generation/image-task-retry-policy";
import { activeOrderMatchesRunner, projectLiveReceiptStage, projectRentalTiming } from "@/lib/image-generation/live-runner-display";
import { imageLibraryRoot } from "@/lib/image-generation/local-image-artifacts";
import { listImageTasks, mutateImageTasks, type LocalImageTask } from "@/lib/image-generation/local-image-task-store";
import {
  resolveAndSnapshotTaskLoras,
  snapshotTaskLoraSelections,
} from "@/lib/image-generation/local-lora-registry";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import { COMFY_RUNTIME_IMAGE, loadCloreConfig } from "../../../../../scripts/clore/config";
import { loadCloreExecutionConfig } from "../../../../../scripts/clore/execution-config";
import { cleanupLiveSession, type CleanupLiveSessionResult } from "../../../../../scripts/clore/image-live-runtime";
import {
  atomic as atomicSessionReceipt,
  cleanupReceiptOwnedOrder,
  readReceipt as readSessionReceipt,
  sessionReceiptPath,
  terminalizeReceipt,
  workerTerminalState,
} from "../../../../../scripts/clore/image-session-supervision";
import { readLiveOrdersSummary, type CloreOrderSummary } from "../../../../../scripts/clore/live";
import { ACTIVE_ORDER_PATH, LEGACY_ORDER_CREATE_LOCK_PATH, ORDER_CREATE_LOCK_PATH, clearActiveOrder, clearOrderCreateLocks, readActiveOrder } from "../../../../../scripts/clore/order-state";
import { finalSanitizedLogLines, imageExecutorReadinessForGpuClass, processExists, sanitizeRunnerLog, STALE_RUNNER_NO_ORDER_MESSAGE } from "../../../../../scripts/image-executor/readiness";
import { assertRtx4090GoldenDeploymentProfile, rtx4090GoldenDeploymentFingerprint } from "../../../../../scripts/image-executor/rtx4090-golden-deployment-profile";
import { planExecutableImageBatch, planImageSession } from "../../../../../scripts/clore/image-session";
import { readLocalWatchdogArmState } from "../../../../../scripts/clore/watchdog-io";
import { projectRunnerStatus } from "@/lib/image-generation/runner-status-projection";

export const dynamic = "force-dynamic";

type PersistedImageResult = {
  imagePath: string;
  thumbnailPath: string;
  sha256: string;
  width: number;
  height: number;
  metadataPath: string;
  persistedAt: string;
};

type ImageTask = LocalImageTask & ImageTaskSettings & {
  seed: number;
  mode: "text_generation" | "kontext_edit";
  referenceImage: string | null;
  gpuClass: ImageGpuClass;
  badge: "低" | "高";
  modelStack: typeof FLUX_IMAGE_STACK;
  createdAt: string;
  attempts: number;
  result?: LocalImageTask["result"] & Partial<PersistedImageResult>;
};

export type ImageRunnerSession = {
  state: "idle" | "running" | "failed" | "completed" | "cancelling";
  stage: string;
  frozenTaskIds: string[];
  gpuClass: ImageGpuClass | null;
  maxHourlyPrice: number;
  currentTaskIndex: number | null;
  currentModel: string | null;
  promptSummary: string | null;
  startedAt: string | null;
  updatedAt: string;
  host: {
    gpu: string | null;
    priceHourly: number | null;
    serverId: string | null;
    orderId: string | null;
    vram: string | null;
    cpu: string | null;
    ram: string | null;
    disk: string | null;
    network: string | null;
    location: string | null;
    runtimeDigest: string | null;
    httpState: string | null;
    sshDiagnostic: string | null;
    orderStatus?: string | null;
    deploymentState?: string | null;
    clorePorts?: string[] | null;
    cloreHttpUrls?: string[] | null;
    controllerUrl?: string | null;
    selectedControllerUrl?: string | null;
    healthUrl?: string | null;
    endpointSource?: string | null;
    rawHttpPub?: string | null;
    httpExternalPort?: number | null;
    lastHealthStatus?: number | null;
    lastHealthError?: string | null;
    readinessElapsedSeconds?: number | null;
    lastPollAt?: string | null;
    message?: string | null;
    lastCreateOrderError?: string | null;
    lastCreateOrderTechnicalCause?: string | null;
    createOrderAttempts?: Record<string, unknown>[] | null;
    candidateRole?: "candidate" | "rented_host" | null;
    market?: { phase: string; scannedAt: string | null; nextScanAt: string | null; totalServerCount: number | null; compliantCandidateCount: number | null; rejectedServerIds: string[]; attemptedServerIds: string[]; selectedServerId: string | null; selectedHourlyUsd: number | null; filterCounts?: Record<string, unknown> | null; marketplaceRead?: Record<string, unknown> | null } | null;
    marketplaceRefreshedAt?: string | null;
    candidateAttempts?: Array<{ serverId?: string; hourlyUsd?: number | null; event?: string; classification?: string | null; requestAttempts?: number; marketplaceRefreshedAt?: string | null }> | null;
  } | null;
  error: {
    stage: string;
    message: string;
    at: string;
    cancellationError?: string;
    billingRisk?: string;
    operation?: string;
    method?: string;
    targetHost?: string;
    targetPath?: string;
    classification?: string;
    technicalCause?: string;
  } | null;
  blocker: string | null;
  pid?: number | null;
  logPath?: string | null;
  createAttempt?: { id: string; startedAt: string; phase: string; requestAttempts: number } | null;
  lastCancellation?: { at: string; orderId: string | null; message: string };
};

const DATA_DIR = path.join(process.cwd(), ".secrets", "image-studio");
const RUNNER_PATH = path.join(DATA_DIR, "runner-session.json");
const RUNNER_LOG_PATH = path.join(DATA_DIR, "image-runner.log");
const RUNNER_START_LOCK_PATH = path.join(DATA_DIR, "runner-start.lock");
const LIVE_SESSION_RECEIPT_PATH = path.join(process.cwd(), ".secrets", "clore-image-session-receipt.json");
const IMAGE_SESSION_DIAGNOSTICS_ROOT = path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions");
const CURRENT_LOG_SOURCE_MAX_BYTES = 192 * 1024;
const CURRENT_LOG_EXPORT_MAX_BYTES = 512 * 1024;
const CURRENT_LOG_EXPORT_MAX_LINES = 2_000;
const CURRENT_RECEIPT_MAX_BYTES = 1024 * 1024;
const RUNNER_LOG_MAX_BYTES = 2 * 1024 * 1024;
const RUNNER_LOG_RETAIN_BYTES = 512 * 1024;
const PREFERENCES_PATH = path.join(DATA_DIR, "preferences.json");
const RESTORE_MANIFEST_PATH = path.join(DATA_DIR, "fluxed-up-10.2-rtx4090-text.restore.json");
const SOURCE_MANIFEST_PATH = path.join(process.cwd(), "comfy-runtime", "image-source-artifacts.json");
const DEFAULT_MAX_HOURLY_PRICE = 0.6;
const KONTEXT_BLOCKER = "FLUX Kontext 执行器尚未完成";
const DUPLICATE_START_MESSAGE = "已有图像批次正在启动或执行，请先等待或退租。";
const CREATE_ORDER_STALE_MS = 3 * 60 * 1000;
const SUPERVISOR_HANDOFF_GRACE_MS = 60 * 1000;

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return existsSync(filePath) ? (JSON.parse(readFileSync(filePath, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readTasks() {
  return listImageTasks() as ImageTask[];
}

function updateTasks(transform: (tasks: ImageTask[]) => ImageTask[]) {
  return mutateImageTasks((tasks) => {
    const next = transform(tasks as ImageTask[]);
    const unique = next.filter((task, index, all) => task?.id && all.findIndex((candidate) => candidate.id === task.id) === index);
    return { tasks: unique as LocalImageTask[], value: unique };
  });
}

function readPrice() {
  const value = finiteNumber(readJson<{ maxHourlyPrice?: unknown }>(PREFERENCES_PATH, {}).maxHourlyPrice);
  return value !== null && value > 0 ? value : DEFAULT_MAX_HOURLY_PRICE;
}

function readinessForGpuClass(gpuClass: ImageGpuClass) {
  const readiness = imageExecutorReadinessForGpuClass(gpuClass, { restoreManifestPath: RESTORE_MANIFEST_PATH, sourceManifestPath: SOURCE_MANIFEST_PATH });
  if (!readiness.ready || gpuClass !== "rtx4090") return readiness;
  try {
    assertRtx4090GoldenDeploymentProfile();
    return readiness;
  } catch {
    return { ready: false as const, mode: "not_ready" as const, blocker: "RTX 4090 已验证部署配置不匹配，已阻止创建订单。", code: "rtx4090_golden_deployment_profile_drift" };
  }
}

function readinessBlocker(gpuClass: ImageGpuClass = "rtx4090") {
  const readiness = readinessForGpuClass(gpuClass);
  return readiness.ready ? null : readiness.blocker;
}

function defaultRunner(): ImageRunnerSession {
  return {
    state: "idle",
    stage: "当前未租用显卡",
    frozenTaskIds: [],
    gpuClass: null,
    maxHourlyPrice: readPrice(),
    currentTaskIndex: null,
    currentModel: null,
    promptSummary: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    host: null,
    error: null,
    blocker: readinessBlocker(),
    pid: null,
    logPath: null,
  };
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArrayOrNull(value: unknown) {
  if (!Array.isArray(value)) return null;
  const values = [...new Set(value.map(String).filter(Boolean))];
  return values.length ? values : null;
}

function recordArrayOrNull(value: unknown) {
  if (!Array.isArray(value)) return null;
  const values = value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
  return values.length ? values : null;
}

function normalizeError(value: unknown): ImageRunnerSession["error"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = value as Record<string, unknown>;
  const stage = stringOrNull(error.stage);
  const message = stringOrNull(error.message);
  const at = stringOrNull(error.at);
  if (!stage || !message || !at) return null;
  return {
    stage,
    message,
    at,
    cancellationError: stringOrNull(error.cancellationError) ?? undefined,
    billingRisk: stringOrNull(error.billingRisk) ?? undefined,
    operation: stringOrNull(error.operation) ?? undefined,
    method: stringOrNull(error.method) ?? undefined,
    targetHost: stringOrNull(error.targetHost) ?? undefined,
    targetPath: stringOrNull(error.targetPath) ?? undefined,
    classification: stringOrNull(error.classification) ?? undefined,
    technicalCause: stringOrNull(error.technicalCause) ?? undefined,
  };
}

function normalizeHost(value: unknown): ImageRunnerSession["host"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const host = value as Record<string, unknown>;
  return {
    gpu: stringOrNull(host.gpu),
    priceHourly: finiteNumber(host.priceHourly),
    serverId: stringOrNull(host.serverId),
    orderId: stringOrNull(host.orderId),
    vram: stringOrNull(host.vram),
    cpu: stringOrNull(host.cpu),
    ram: stringOrNull(host.ram),
    disk: stringOrNull(host.disk),
    network: stringOrNull(host.network),
    location: stringOrNull(host.location),
    runtimeDigest: stringOrNull(host.runtimeDigest),
    httpState: stringOrNull(host.httpState),
    sshDiagnostic: stringOrNull(host.sshDiagnostic),
    orderStatus: stringOrNull(host.orderStatus),
    deploymentState: stringOrNull(host.deploymentState),
    clorePorts: stringArrayOrNull(host.clorePorts),
    cloreHttpUrls: stringArrayOrNull(host.cloreHttpUrls),
    controllerUrl: stringOrNull(host.controllerUrl),
    selectedControllerUrl: stringOrNull(host.selectedControllerUrl),
    healthUrl: stringOrNull(host.healthUrl),
    endpointSource: stringOrNull(host.endpointSource),
    rawHttpPub: stringOrNull(host.rawHttpPub),
    httpExternalPort: finiteNumber(host.httpExternalPort),
    lastHealthStatus: finiteNumber(host.lastHealthStatus),
    lastHealthError: stringOrNull(host.lastHealthError),
    readinessElapsedSeconds: finiteNumber(host.readinessElapsedSeconds),
    lastPollAt: stringOrNull(host.lastPollAt),
    message: stringOrNull(host.message),
    lastCreateOrderError: stringOrNull(host.lastCreateOrderError),
    lastCreateOrderTechnicalCause: stringOrNull(host.lastCreateOrderTechnicalCause),
    createOrderAttempts: recordArrayOrNull(host.createOrderAttempts),
    candidateRole: host.candidateRole === "candidate" || host.candidateRole === "rented_host" ? host.candidateRole : null,
    marketplaceRefreshedAt: stringOrNull(host.marketplaceRefreshedAt),
    candidateAttempts: recordArrayOrNull(host.candidateAttempts)?.map((attempt) => ({ serverId: stringOrNull(attempt.serverId) ?? undefined, hourlyUsd: finiteNumber(attempt.hourlyUsd), event: stringOrNull(attempt.event) ?? undefined, classification: stringOrNull(attempt.classification), requestAttempts: Number.isSafeInteger(attempt.requestAttempts) ? Number(attempt.requestAttempts) : undefined, marketplaceRefreshedAt: stringOrNull(attempt.marketplaceRefreshedAt) })) ?? null,
    market: host.market && typeof host.market === "object" && !Array.isArray(host.market) ? {
      phase: stringOrNull((host.market as Record<string, unknown>).phase) ?? "unknown",
      scannedAt: stringOrNull((host.market as Record<string, unknown>).scannedAt),
      nextScanAt: stringOrNull((host.market as Record<string, unknown>).nextScanAt),
      totalServerCount: finiteNumber((host.market as Record<string, unknown>).totalServerCount),
      compliantCandidateCount: finiteNumber((host.market as Record<string, unknown>).compliantCandidateCount),
      rejectedServerIds: stringArrayOrNull((host.market as Record<string, unknown>).rejectedServerIds) ?? [],
      selectedServerId: stringOrNull((host.market as Record<string, unknown>).selectedServerId),
      selectedHourlyUsd: finiteNumber((host.market as Record<string, unknown>).selectedHourlyUsd),
      attemptedServerIds: stringArrayOrNull((host.market as Record<string, unknown>).attemptedServerIds) ?? [],
      filterCounts: (host.market as Record<string, unknown>).filterCounts && typeof (host.market as Record<string, unknown>).filterCounts === "object" && !Array.isArray((host.market as Record<string, unknown>).filterCounts) ? (host.market as Record<string, unknown>).filterCounts as Record<string, unknown> : null,
      marketplaceRead: (host.market as Record<string, unknown>).marketplaceRead && typeof (host.market as Record<string, unknown>).marketplaceRead === "object" && !Array.isArray((host.market as Record<string, unknown>).marketplaceRead) ? (host.market as Record<string, unknown>).marketplaceRead as Record<string, unknown> : null,
    } : null,
  };
}

function projectRunnerProgress(runner: ImageRunnerSession) {
  const host = runner.host;
  const market = host?.market ?? null;
  const candidate = host?.orderId ? null : host?.serverId ? { serverId: host.serverId, hourlyUsd: host.priceHourly, selectedAt: host.marketplaceRefreshedAt ?? null } : null;
  const order = host?.orderId ? { orderId: host.orderId, serverId: host.serverId, hourlyUsd: host.priceHourly, state: host.deploymentState ?? host.orderStatus ?? "created" } : null;
  return {
    phase: market?.phase ?? (order ? "order_created" : runner.state === "running" ? "preflight" : "idle"),
    displayMessage: host?.message ?? runner.stage,
    market: market ? { ...market, nextScanInSeconds: market.nextScanAt ? Math.max(0, Math.ceil((Date.parse(market.nextScanAt) - Date.now()) / 1000)) : null } : null,
    candidate,
    order,
    deployment: order ? { state: host?.deploymentState ?? host?.orderStatus ?? "unknown" } : null,
    generation: runner.currentTaskIndex === null ? null : { taskIndex: runner.currentTaskIndex, taskCount: runner.frozenTaskIds.length },
    canCancelWaiting: runner.state === "running" && market?.phase === "waiting_for_market" && !host?.orderId,
    canStopAndCancelOrder: Boolean(host?.orderId),
    isBlocking: Boolean(runner.blocker),
    timeline: (host?.candidateAttempts ?? []).slice(-8).map((attempt) => ({ at: String(attempt.marketplaceRefreshedAt ?? runner.updatedAt), phase: String(attempt.event ?? "candidate"), serverId: String(attempt.serverId ?? ""), hourlyUsd: finiteNumber(attempt.hourlyUsd) })),
  };
}

function normalizeRunner(input: Partial<ImageRunnerSession>): ImageRunnerSession {
  const fallback = defaultRunner();
  const state = ["idle", "running", "failed", "completed", "cancelling"].includes(String(input.state)) ? input.state! : fallback.state;
  const maxHourly = finiteNumber(input.maxHourlyPrice);
  return {
    ...fallback,
    ...input,
    state,
    stage: stringOrNull(input.stage) ?? fallback.stage,
    frozenTaskIds: [...new Set(Array.isArray(input.frozenTaskIds) ? input.frozenTaskIds.map(String).filter(Boolean) : [])],
    gpuClass: input.gpuClass === "rtx4090" || input.gpuClass === "rtx5090" ? input.gpuClass : null,
    maxHourlyPrice: maxHourly !== null && maxHourly > 0 ? maxHourly : readPrice(),
    currentTaskIndex: Number.isInteger(input.currentTaskIndex) ? input.currentTaskIndex! : null,
    currentModel: stringOrNull(input.currentModel),
    promptSummary: stringOrNull(input.promptSummary),
    startedAt: stringOrNull(input.startedAt),
    updatedAt: stringOrNull(input.updatedAt) ?? new Date().toISOString(),
    host: normalizeHost(input.host),
    error: normalizeError(input.error),
    blocker: input.blocker ?? null,
    pid: Number.isInteger(input.pid) ? input.pid : null,
    logPath: stringOrNull(input.logPath),
    createAttempt: input.createAttempt && typeof input.createAttempt === "object" && typeof input.createAttempt.id === "string" && typeof input.createAttempt.startedAt === "string" && typeof input.createAttempt.phase === "string"
      ? { id: input.createAttempt.id, startedAt: input.createAttempt.startedAt, phase: input.createAttempt.phase, requestAttempts: Number.isInteger(input.createAttempt.requestAttempts) ? input.createAttempt.requestAttempts : 0 }
      : null,
  };
}

function acquireRunnerStartLock(attemptId: string) {
  mkdirSync(DATA_DIR, { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(RUNNER_START_LOCK_PATH, "wx");
  } catch {
    throw new Error(DUPLICATE_START_MESSAGE);
  }
  writeFileSync(descriptor, JSON.stringify({ attemptId, acquiredAt: new Date().toISOString() }), "utf8");
  return () => {
    closeSync(descriptor);
    rmSync(RUNNER_START_LOCK_PATH, { force: true });
  };
}

function terminalRunnerState(state: ImageRunnerSession["state"]) {
  return state === "idle" || state === "failed" || state === "completed";
}

function readRunner() {
  const runner = normalizeRunner(readJson<Partial<ImageRunnerSession>>(RUNNER_PATH, {}));
  if (terminalRunnerState(runner.state)) return { ...runner, blocker: readinessBlocker() };
  return runner;
}

function saveRunner(runner: ImageRunnerSession) {
  writeJson(RUNNER_PATH, { ...normalizeRunner(runner), updatedAt: new Date().toISOString() });
}

function appendRunnerLog(kind: "stdout" | "stderr" | "event", text: string) {
  mkdirSync(DATA_DIR, { recursive: true });
  const lines = finalSanitizedLogLines(text, 50);
  if (!lines.length) return;
  const entry = lines.map((line) => JSON.stringify({ at: new Date().toISOString(), stream: kind, line })).join("\n") + "\n";
  try {
    const size = existsSync(RUNNER_LOG_PATH) ? statSync(RUNNER_LOG_PATH).size : 0;
    if (size + Buffer.byteLength(entry, "utf8") > RUNNER_LOG_MAX_BYTES) {
      const start = Math.max(0, size - RUNNER_LOG_RETAIN_BYTES);
      const buffer = Buffer.alloc(size - start);
      const descriptor = openSync(RUNNER_LOG_PATH, "r");
      try {
        if (buffer.length) readSync(descriptor, buffer, 0, buffer.length, start);
      } finally {
        closeSync(descriptor);
      }
      const tail = buffer.toString("utf8");
      const firstNewline = start > 0 ? tail.indexOf("\n") : -1;
      writeFileSync(RUNNER_LOG_PATH, firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail, "utf8");
    }
  } catch {
    // A rotation failure must not hide the current bounded diagnostic entry.
  }
  appendFileSync(RUNNER_LOG_PATH, entry, "utf8");
}

async function activeCloreOrders() {
  return (await readLiveOrdersSummary(loadCloreConfig(), { forceRefresh: true })).filter((order) => order.active);
}

async function assertNoActiveProviderOrderBeforeStart(runner: ImageRunnerSession) {
  const activeOrders = await activeCloreOrders();
  if (activeOrders.length === 0) {
    clearLocalActiveImageState();
    return;
  }
  const matching = matchingImageOrder(runner, activeOrders);
  if (matching?.orderId) throw new Error(`检测到真实活动订单：${matching.orderId}`);
  throw new Error(`已有其他活动订单：${activeOrders[0].orderId ?? "未知"}`);
}

function runnerTimestampMs(runner: ImageRunnerSession) {
  const updated = new Date(runner.updatedAt).getTime();
  const started = runner.startedAt ? new Date(runner.startedAt).getTime() : Number.NaN;
  const timestamp = Number.isFinite(updated) ? updated : started;
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function creatingOrderLooksStale(runner: ImageRunnerSession) {
  return runner.stage === "creating_order" && Date.now() - runnerTimestampMs(runner) > CREATE_ORDER_STALE_MS;
}

function clearStaleCreateLocks() {
  if (existsSync(ORDER_CREATE_LOCK_PATH) || existsSync(LEGACY_ORDER_CREATE_LOCK_PATH)) clearOrderCreateLocks();
}

function stopRunnerProcessTree(pid: number | null | undefined) {
  // Cancellation does not depend on the process signal; provider reconciliation
  // and local state cleanup still run even if this PID is stale or already dead.
  if (!Number.isInteger(pid) || !processExists(pid)) return false;
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      return result.status === 0;
    }
    process.kill(Number(pid), "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(Number(pid), "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

function returnFrozenTasksToWaiting(runner: ImageRunnerSession) {
  const ids = new Set(runner.frozenTaskIds);
  if (!ids.size) return;
  const now = new Date().toISOString();
  updateTasks((tasks) => tasks.map((task) => {
    if (!ids.has(task.id) || task.status !== "generating") return task;
    if (requiresManualInferenceRecovery(task)) {
      return {
        ...task,
        status: "failed",
        updatedAt: now,
        error: {
          message: AMBIGUOUS_INFERENCE_RETRY_MESSAGE,
          at: now,
          retryable: false,
          classification: AMBIGUOUS_INFERENCE_RETRY_CLASSIFICATION,
        },
      };
    }
    return { ...task, status: "waiting_for_gpu", updatedAt: now };
  }));
}

function clearLocalActiveImageState() {
  const activeState = activeStateLooksImageOrder();
  if (activeState && existsSync(ACTIVE_ORDER_PATH)) {
    try {
      clearActiveOrder(activeState.order_id);
    } catch {
      rmSync(ACTIVE_ORDER_PATH, { force: true });
    }
  }
  clearStaleCreateLocks();
}

function resetRunnerToIdleAfterLocalCleanup(runner: ImageRunnerSession, message: string) {
  returnFrozenTasksToWaiting(runner);
  const now = new Date().toISOString();
  saveRunner({
    ...defaultRunner(),
    state: "idle",
    stage: message,
    frozenTaskIds: [],
    gpuClass: null,
    currentTaskIndex: null,
    currentModel: null,
    promptSummary: null,
    startedAt: null,
    host: null,
    error: null,
    blocker: null,
    pid: null,
    logPath: null,
    lastCancellation: { at: now, orderId: null, message },
    updatedAt: now,
  });
}

async function reconcileStaleRunner(runner: ImageRunnerSession) {
  const localActive = activeStateLooksImageOrder();
  const pidLive = processExists(runner.pid);
  const staleCreatingOrder = creatingOrderLooksStale(runner);
  const launchStartedAt = runner.createAttempt?.startedAt ?? runner.startedAt;
  const launchAge = launchStartedAt ? Date.now() - Date.parse(launchStartedAt) : Number.POSITIVE_INFINITY;
  const launchPending =
    runner.state === "running" &&
    Boolean(runner.createAttempt?.id) &&
    !localActive &&
    !staleCreatingOrder &&
    launchAge >= 0 &&
    launchAge < SUPERVISOR_HANDOFF_GRACE_MS &&
    !pidLive;
  // The route publishes no authoritative PID until the detached supervisor
  // hands back the real worker PID. During that bounded handoff window a
  // second start must not release the task freeze while the worker can still
  // create an order.
  if (launchPending) return runner;
  const shouldReconcile = Boolean(localActive) || (!terminalRunnerState(runner.state) && !pidLive) || staleCreatingOrder;
  if (!shouldReconcile) return runner;
  const activeOrders = await activeCloreOrders().catch(() => null);
  if (activeOrders === null) return runner;
  const activeImageOrder = matchingImageOrder(runner, activeOrders);
  if (activeImageOrder?.orderId) {
    const adopted = {
      ...runner,
      state: "running" as const,
      stage: "order_created_waiting_http",
      pid: pidLive ? runner.pid : null,
      host: normalizeHost({
        ...(runner.host ?? {}),
        orderId: activeImageOrder.orderId,
        serverId: activeImageOrder.serverId ?? runner.host?.serverId ?? null,
        orderStatus: activeImageOrder.status,
        deploymentState: activeImageOrder.deploymentState ?? null,
        controllerUrl: activeImageOrder.controllerUrl ?? null,
        candidateRole: "rented_host",
        message: `检测到真实活动订单：${activeImageOrder.orderId}`,
      }),
      error: null,
      blocker: null,
    };
    saveRunner(adopted);
    return readRunner();
  }
  if (activeOrders.length > 0) {
    stopRunnerProcessTree(runner.pid);
    returnFrozenTasksToWaiting(runner);
    const order = activeOrders[0];
    const failedWithOtherOrder = {
      ...runner,
      state: "failed" as const,
      stage: "active_order_conflict",
      host: null,
      frozenTaskIds: [],
      gpuClass: null,
      currentTaskIndex: null,
      currentModel: null,
      promptSummary: null,
      pid: null,
      error: {
        stage: "active_order_conflict",
        message: `已有其他活动订单：${order.orderId ?? "未知"}`,
        at: new Date().toISOString(),
        billingRisk: "未自动取消非当前图像批次订单",
      },
      blocker: `已有其他活动订单：${order.orderId ?? "未知"}`,
    };
    saveRunner(failedWithOtherOrder);
    return readRunner();
  }
  stopRunnerProcessTree(runner.pid);
  const hadStaleLock = existsSync(ORDER_CREATE_LOCK_PATH) || existsSync(LEGACY_ORDER_CREATE_LOCK_PATH);
  const receipt = readSessionReceipt();
  const cleanup = await reconcileKnownInactiveLocalSession(
    runner,
    receiptBelongsToRunner(runner, receipt) ? receipt : null,
  );
  if (!cleanup.cleanupConfirmed) return runner;
  await persistOperatorCleanupReceipt(runner, receipt, cleanup);
  if (processExists(runner.pid)) return runner;
  const message = localActive || hadStaleLock
    ? "检测到本地残留订单状态，已完成两次清零核对并自动清理"
    : staleCreatingOrder
      ? "创建订单失败，未产生订单"
      : STALE_RUNNER_NO_ORDER_MESSAGE;
  resetRunnerToIdleAfterLocalCleanup(runner, message);
  return readRunner();
}

function runnerDisplayIdentity(runner: ImageRunnerSession) {
  return {
    state: runner.state,
    attemptId: runner.createAttempt?.id ?? null,
    orderId: runner.host?.orderId ?? null,
    serverId: runner.host?.serverId ?? null,
    candidateRole: runner.host?.candidateRole ?? null,
    frozenTaskIds: runner.frozenTaskIds,
  };
}

function activeOrderDisplayIdentity(activeOrder: NonNullable<ReturnType<typeof activeStateLooksImageOrder>>) {
  return {
    orderId: activeOrder.order_id,
    serverId: activeOrder.server_id,
    createdAt: activeOrder.created_at,
    createAttemptId: activeOrder.create_attempt_id ?? null,
  };
}

function projectConfirmedActiveOrder(
  runner: ImageRunnerSession,
  activeOrder: ReturnType<typeof activeStateLooksImageOrder>,
) {
  if (!activeOrder || !runner.host) return runner;
  if (!activeOrderMatchesRunner(runnerDisplayIdentity(runner), activeOrderDisplayIdentity(activeOrder))) return runner;
  return {
    ...runner,
    host: {
      ...runner.host,
      orderId: activeOrder.order_id,
      serverId: activeOrder.server_id,
      orderStatus: activeOrder.status,
      candidateRole: "rented_host" as const,
    },
  };
}

function projectLiveReceiptRunner(runner: ImageRunnerSession) {
  const projection = projectLiveReceiptStage(
    runnerDisplayIdentity(runner),
    readJson<unknown>(LIVE_SESSION_RECEIPT_PATH, null),
  );
  if (!projection || !runner.host) return runner;
  return {
    ...runner,
    stage: projection.stage,
    currentTaskIndex: projection.currentTaskIndex,
    host: { ...runner.host, message: projection.stage },
  };
}

function projectedRentalTiming(
  runner: ImageRunnerSession,
  activeOrder: ReturnType<typeof activeStateLooksImageOrder>,
) {
  if (!activeOrder) return null;
  let watchdog: ReturnType<typeof readLocalWatchdogArmState> = null;
  try {
    watchdog = readLocalWatchdogArmState();
  } catch {
    // Billing time remains visible from the exact active order, but an invalid
    // watchdog must never be presented as a trustworthy cancellation deadline.
  }
  return projectRentalTiming({
    runner: runnerDisplayIdentity(runner),
    activeOrder: activeOrderDisplayIdentity(activeOrder),
    watchdog: watchdog
      ? {
          armed: watchdog.armed,
          serverId: watchdog.serverId,
          drainingAt: watchdog.drainingAt,
          hardDeadlineAt: watchdog.hardDeadlineAt,
        }
      : null,
  });
}

type CurrentLogSource = {
  label: string;
  text: string;
  truncated: boolean;
};

function readBoundedSanitizedLog(filePath: string, label: string): CurrentLogSource | null {
  if (!existsSync(filePath)) return null;
  try {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    const size = statSync(filePath).size;
    const start = Math.max(0, size - CURRENT_LOG_SOURCE_MAX_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const descriptor = openSync(filePath, "r");
    try {
      if (length) readSync(descriptor, buffer, 0, length, start);
    } finally {
      closeSync(descriptor);
    }
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return { label, text: sanitizeRunnerLog(text).trim(), truncated: start > 0 };
  } catch {
    return null;
  }
}

function currentSessionLauncherLog(source: CurrentLogSource, startedAt: string | null) {
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(startedAtMs)) return null;
  const lines = source.text.split(/\r?\n/).filter((line) => {
    try {
      const entry = JSON.parse(line) as { at?: unknown };
      const atMs = typeof entry.at === "string" ? Date.parse(entry.at) : Number.NaN;
      return Number.isFinite(atMs) && atMs >= startedAtMs;
    } catch {
      return false;
    }
  });
  return { ...source, text: lines.join("\n") };
}

function logRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedReceiptEvidence(value: unknown, maxLength: number) {
  if (value === null || value === undefined) return null;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "<unserializable>";
  }
  const sanitized = sanitizeRunnerLog(text);
  return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}…<truncated>` : sanitized;
}

function currentReceiptLogSummary(runner: ImageRunnerSession, attemptId: string | null) {
  if (!attemptId) return null;
  if (!existsSync(LIVE_SESSION_RECEIPT_PATH)) return null;
  let receipt: Record<string, unknown> | null = null;
  try {
    const metadata = lstatSync(LIVE_SESSION_RECEIPT_PATH);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return { classification: "receipt_not_regular_file" };
    if (metadata.size > CURRENT_RECEIPT_MAX_BYTES) {
      return { classification: "receipt_oversized", byteLength: metadata.size, maximumBytes: CURRENT_RECEIPT_MAX_BYTES };
    }
    receipt = JSON.parse(readFileSync(LIVE_SESSION_RECEIPT_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return { classification: "receipt_unreadable" };
  }
  if (!receipt || receipt.sessionId !== attemptId) return null;
  if (runner.host?.orderId && receipt.orderId !== runner.host.orderId) return null;
  if (runner.host?.serverId && receipt.serverId !== runner.host.serverId) return null;
  const selectedTaskIds = Array.isArray(receipt.selectedTaskIds) ? receipt.selectedTaskIds : [];
  if (
    selectedTaskIds.length !== runner.frozenTaskIds.length
    || selectedTaskIds.some((taskId, index) => taskId !== runner.frozenTaskIds[index])
  ) return null;
  const receiptTasks = logRecord(receipt.tasks);
  const projectedTaskIds = runner.frozenTaskIds.slice(0, 16);
  const tasks = receiptTasks
    ? Object.fromEntries(projectedTaskIds.map((taskId) => {
        const value = receiptTasks[taskId];
        const task = logRecord(value);
        return [taskId, task
          ? {
              terminal: boundedReceiptEvidence(task.terminal, 128),
              inferenceState: boundedReceiptEvidence(task.inferenceState, 128),
              stageRunId: boundedReceiptEvidence(task.stageRunId, 128),
              acceptedHttpStatus: boundedReceiptEvidence(task.acceptedHttpStatus, 32),
              controllerPromptId: boundedReceiptEvidence(task.controllerPromptId, 128),
              terminalError: boundedReceiptEvidence(task.terminalError, 2_000),
            }
          : null];
      }))
    : null;
  const timestampRecord = logRecord(receipt.timestamps);
  const timestamps = timestampRecord
    ? Object.fromEntries(Object.entries(timestampRecord)
        .filter(([key, value]) => /^[A-Za-z0-9_.:-]{1,80}$/.test(key) && typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)))
        .slice(0, 100))
    : null;
  return {
    sessionId: boundedReceiptEvidence(receipt.sessionId, 128),
    sessionState: boundedReceiptEvidence(receipt.sessionState, 128),
    orderId: boundedReceiptEvidence(receipt.orderId, 128),
    serverId: boundedReceiptEvidence(receipt.serverId, 128),
    currentRemoteStage: boundedReceiptEvidence(receipt.currentRemoteStage, 128),
    currentStageRunId: boundedReceiptEvidence(receipt.currentStageRunId, 128),
    currentTaskId: boundedReceiptEvidence(receipt.currentTaskId, 128),
    modelStage: boundedReceiptEvidence(receipt.modelStage, 4_000),
    completedCount: boundedReceiptEvidence(receipt.completedCount, 32),
    failedCount: boundedReceiptEvidence(receipt.failedCount, 32),
    cancellationState: boundedReceiptEvidence(receipt.cancellationState, 1_000),
    cleanupEvidence: boundedReceiptEvidence(receipt.cleanupEvidence, 6_000),
    firstError: boundedReceiptEvidence(receipt.firstError, 3_000),
    agentAcceptanceFailure: boundedReceiptEvidence(receipt.agentAcceptanceFailure, 5_000),
    timestamps,
    receiptProjectionTruncated: runner.frozenTaskIds.length > projectedTaskIds.length,
    tasks,
  };
}

function capCurrentLogExport(value: string) {
  let truncated = false;
  let lines = value.split(/\r?\n/);
  if (lines.length > CURRENT_LOG_EXPORT_MAX_LINES) {
    lines = [
      ...lines.slice(0, 120),
      "[...中间日志已截断...]",
      ...lines.slice(-(CURRENT_LOG_EXPORT_MAX_LINES - 121)),
    ];
    truncated = true;
  }
  let text = lines.join("\n");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > CURRENT_LOG_EXPORT_MAX_BYTES) {
    const marker = Buffer.from("\n[...中间日志已截断...]\n", "utf8");
    const headBytes = 64 * 1024;
    const tailBytes = CURRENT_LOG_EXPORT_MAX_BYTES - headBytes - marker.length;
    let head = bytes.subarray(0, headBytes).toString("utf8");
    let tail = bytes.subarray(bytes.length - tailBytes).toString("utf8");
    const headLastNewline = head.lastIndexOf("\n");
    const tailFirstNewline = tail.indexOf("\n");
    if (headLastNewline >= 0) head = head.slice(0, headLastNewline);
    if (tailFirstNewline >= 0) tail = tail.slice(tailFirstNewline + 1);
    text = `${head}${marker.toString("utf8")}${tail}`;
    truncated = true;
  }
  return { text, truncated };
}

function currentStudioLogExport() {
  const runner = readRunner();
  const attemptId = runner.createAttempt?.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runner.createAttempt.id)
    ? runner.createAttempt.id
    : null;
  const sources: CurrentLogSource[] = [];
  const workerLog = attemptId
    ? readBoundedSanitizedLog(path.join(IMAGE_SESSION_DIAGNOSTICS_ROOT, attemptId, "worker.log"), "当前会话 Worker 日志")
    : null;
  if (workerLog) sources.push(workerLog);
  const launcherLog = readBoundedSanitizedLog(RUNNER_LOG_PATH, "Studio 启动器日志");
  const sessionLauncherLog = launcherLog ? currentSessionLauncherLog(launcherLog, runner.startedAt) : null;
  if (sessionLauncherLog) sources.push(sessionLauncherLog);
  const receipt = currentReceiptLogSummary(runner, attemptId);
  const statusProjection = projectRunnerStatus(runner, {
    pidAlive: processExists(runner.pid),
    activeOrder: Boolean(activeStateLooksImageOrder()),
    createLock: existsSync(ORDER_CREATE_LOCK_PATH) || existsSync(LEGACY_ORDER_CREATE_LOCK_PATH) || existsSync(RUNNER_START_LOCK_PATH),
  });
  const header = {
    generatedAt: new Date().toISOString(),
    sanitized: true,
    runner: {
      state: runner.state,
      stage: runner.stage,
      startedAt: runner.startedAt,
      updatedAt: runner.updatedAt,
      attemptId,
      pid: runner.pid ?? null,
      pidAlive: processExists(runner.pid),
      orderId: runner.host?.orderId ?? null,
      serverId: runner.host?.serverId ?? null,
      error: runner.error
        ? {
            stage: runner.error.stage,
            classification: statusProjection.error?.classification ?? runner.error.classification ?? null,
            message: statusProjection.error?.displayMessage ?? "运行失败，详细内部响应已脱敏。",
            at: runner.error.at,
          }
        : null,
    },
    receipt,
  };
  const sections = [
    "# Image Studio 当前会话诊断日志",
    "",
    "## 状态摘要",
    JSON.stringify(header, null, 2),
    ...sources.flatMap((source) => [
      "",
      `## ${source.label}${source.truncated ? "（已截取最后 192 KiB）" : ""}`,
      source.text || "(暂无日志内容)",
    ]),
  ];
  const capped = capCurrentLogExport(sanitizeRunnerLog(sections.join("\n")).trim());
  return {
    filename: `image-studio-${attemptId ?? "current"}.log`,
    generatedAt: header.generatedAt,
    text: capped.text,
    lineCount: capped.text ? capped.text.split(/\r?\n/).length : 0,
    truncated: capped.truncated || sources.some((source) => source.truncated),
    sanitized: true,
    sourceLabels: sources.map((source) => source.label),
  };
}

async function responsePayload(extra: Record<string, unknown> = {}) {
  const readiness = {
    rtx4090: readinessForGpuClass("rtx4090"),
    rtx5090: readinessForGpuClass("rtx5090"),
  };
  // Status projection is deliberately read-only. Stale-process/provider
  // reconciliation is performed only inside an explicit mutation such as a
  // guarded start or cancel request, never by GET polling.
  const activeOrder = activeStateLooksImageOrder();
  const runner = projectLiveReceiptRunner(projectConfirmedActiveOrder(readRunner(), activeOrder));
  const createLockPresent = existsSync(ORDER_CREATE_LOCK_PATH) || existsSync(LEGACY_ORDER_CREATE_LOCK_PATH) || existsSync(RUNNER_START_LOCK_PATH);
  const runnerPidAlive = processExists(runner.pid);
  const display = projectRunnerStatus(runner, {
    pidAlive: runnerPidAlive,
    // A terminal host/order field is retained as historical evidence.  Billing
    // state comes only from the active-order record reconciled against Clore.
    activeOrder: Boolean(activeOrder),
    createLock: createLockPresent,
  });
  const tasks = readTasks();
  const historicalTerminal = terminalRunnerState(runner.state)
    && !runnerPidAlive
    && !activeOrder
    && !createLockPresent;
  const progressRunner = historicalTerminal
    ? { ...runner, host: null, stage: display.error?.displayMessage ?? runner.stage }
    : runner;
  const blocker = terminalRunnerState(runner.state)
    ? (readiness.rtx4090.ready ? display.blocker : readiness.rtx4090.blocker)
    : display.blocker;
  const progress = projectRunnerProgress(progressRunner);
  return {
    tasks,
    executableBatches: {
      rtx4090: planExecutableImageBatch(tasks, "rtx4090"),
      rtx5090: planExecutableImageBatch(tasks, "rtx5090"),
    },
    runner: {
      ...runner,
      // A terminal receipt without PID/order/lock is historical evidence, not
      // a current rented host or a reusable marketplace selection.
      host: historicalTerminal ? null : runner.host,
      error: display.error,
      progress: blocker
        ? { ...progress, displayMessage: display.error?.displayMessage ?? blocker, isBlocking: true }
        : progress,
      rentalTiming: projectedRentalTiming(runner, activeOrder),
      blocker,
    },
    executionReady: readiness.rtx4090.ready,
    executionReadiness: {
      rtx4090: { ready: readiness.rtx4090.ready, blocker: readiness.rtx4090.ready ? null : readiness.rtx4090.blocker },
      rtx5090: { ready: readiness.rtx5090.ready, blocker: readiness.rtx5090.ready ? null : readiness.rtx5090.blocker },
    },
    maxHourlyPrice: readPrice(),
    localProgram: readLocalProgramStatus(),
    ...extra,
  };
}

function readLocalProgramStatus() {
  let taskStoreAvailable = true;
  try { readTasks(); } catch { taskStoreAvailable = false; }
  const memory = process.memoryUsage();
  return {
    service: "running" as const,
    port: 3000,
    cpuLogicalCores: os.cpus().length,
    totalRamBytes: os.totalmem(),
    availableRamBytes: os.freemem(),
    processMemoryBytes: memory.rss,
    taskStoreAvailable,
    imageLibraryAvailable: existsSync(imageLibraryRoot()),
    refreshedAt: new Date().toISOString(),
  };
}

function imageDimension(value: unknown) {
  const dimension = Number(value);
  return Number.isInteger(dimension) ? dimension : null;
}

function publicTaskCreationError(error: unknown) {
  const message = error instanceof Error ? error.message : "image_task_failed";
  const code = message.split(":")[0];
  const loraMessages: Record<string, string> = {
    direct_lora_source_identity_unavailable: "已注册的直接下载链接缺少可信大小和 SHA-256；请换成可解析的 Civitai 或 HuggingFace 模型地址后再生成。",
    civitai_lora_version_missing: "已注册的 Civitai 地址没有可解析的模型版本；请改用具体版本或带 fileId 的下载链接。",
    civitai_lora_file_ambiguous_or_missing: "该 Civitai 模型没有唯一可识别的 LoRA 文件；请改用带 fileId 的具体下载链接。",
    civitai_lora_flux1_version_missing: "该 Civitai 模型页没有适配当前 FLUX.1-D 图像模型的 LoRA 版本；任务卡已保留，请更换兼容版本链接。",
    civitai_lora_flux1_incompatible: "该 Civitai 具体版本不适配当前 FLUX.1-D 图像模型；任务卡已保留，请选择 FLUX.1 D 版本。",
    civitai_metadata_identity_mismatch: "Civitai 返回的模型或版本身份与所选链接不一致；任务卡已保留，未进入租卡。",
    civitai_lora_identity_incomplete: "Civitai 没有提供该 LoRA 的完整大小和 SHA-256，尚不能安全生成。",
    civitai_lora_size_mismatch: "Civitai LoRA 的实际大小与平台身份不一致；任务卡已保留，未进入租卡。",
    civitai_model_is_not_lora: "该 Civitai 地址指向的模型不是 LoRA，请更换链接。",
    civitai_lora_remote_delivery_requires_local_token: "该 Civitai LoRA 只能使用本机令牌下载，云端 Agent 无法安全获取；任务卡已保留，未进入租卡。",
    huggingface_lora_file_url_required: "该 HuggingFace 仓库包含多个文件；请改用具体的 .safetensors 文件链接。",
    huggingface_lora_file_ambiguous_or_missing: "该 HuggingFace 地址没有唯一可识别的 .safetensors 文件。",
    huggingface_lora_identity_incomplete: "HuggingFace 没有提供该 LoRA 的完整大小和 SHA-256，尚不能安全生成。",
    huggingface_lora_remote_delivery_requires_local_token: "该 HuggingFace LoRA 只能使用本机令牌下载，云端 Agent 无法安全获取；请改用公开文件地址。",
    lora_source_timeout: "LoRA 来源当前连接超时；任务卡已保留为待确认，没有租用显卡，请稍后重试确认。",
    "fetch failed": "LoRA 来源当前网络不可达；任务卡已保留为待确认，没有租用显卡，请稍后重试确认。",
  };
  if (/^lora_metadata_http_/.test(code)) {
    return `LoRA 平台元数据请求失败（${code.replace("lora_metadata_http_", "HTTP ")}）；任务卡已保留，未进入租卡。`;
  }
  return loraMessages[code] ?? message;
}

type TaskLoraSnapshot = Awaited<ReturnType<typeof resolveAndSnapshotTaskLoras>>;
type TaskLoraSelections = ReturnType<typeof snapshotTaskLoraSelections>;
type TaskBuildOptions = {
  loras?: TaskLoraSnapshot;
  loraSelections?: TaskLoraSelections;
};

function taskFrom(input: Record<string, unknown>, options?: TaskBuildOptions): ImageTask {
  const prompt = String(input.prompt ?? "").trim();
  const negativePrompt = normalizeNegativePrompt(input.negativePrompt);
  const loraSelections = options === undefined
    ? snapshotTaskLoraSelections(input.loras)
    : options.loraSelections === undefined
      ? undefined
      : structuredClone(options.loraSelections);
  const loras = options?.loras === undefined ? undefined : structuredClone(options.loras);
  const width = imageDimension(input.width);
  const height = imageDimension(input.height);
  const steps = Number(input.steps);
  const loraStrength = Number(input.loraStrength);
  const cfg = Number(input.cfg);
  const sampler = String(input.sampler);
  const seed = Number.isInteger(Number(input.seed)) ? Number(input.seed) : Math.floor(Math.random() * 2_147_483_647);
  if (!width || !height || width < IMAGE_RESOLUTION_MIN || height < IMAGE_RESOLUTION_MIN || width % IMAGE_RESOLUTION_STEP || height % IMAGE_RESOLUTION_STEP) {
    throw new Error("图像宽度和高度必须是 768 至 1536 之间的 256 像素整数倍");
  }
  if (width > IMAGE_RESOLUTION_5090_MAX || height > IMAGE_RESOLUTION_5090_MAX) {
    throw new Error("当前文本生图最高支持 1536 × 1536；请缩小分辨率后重试");
  }
  if (
    !prompt ||
    prompt.length > 4000 ||
    !Number.isInteger(steps) ||
    steps < 25 ||
    steps > 40 ||
    loraStrength < 0.6 ||
    loraStrength > 1.1 ||
    cfg < 3.5 ||
    cfg > 5 ||
    (sampler !== "Euler" && sampler !== "FlowMatch")
  ) {
    throw new Error("invalid_image_task");
  }
  const referenceImage = typeof input.referenceImage === "string" && input.referenceImage.startsWith("data:image/") && input.referenceImage.length <= 6_000_000 ? input.referenceImage : null;
  const gpuClass = classifyImageGpu(width, height);
  if (!gpuClass) throw new Error("不支持的图像分辨率");
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    seed,
    mode: referenceImage ? "kontext_edit" : "text_generation",
    prompt,
    negativePrompt,
    ...(loras === undefined ? {} : { loras }),
    ...(loraSelections === undefined ? {} : { loraSelections }),
    referenceImage,
    steps,
    loraStrength,
    cfg,
    sampler: sampler as ImageTaskSettings["sampler"],
    width,
    height,
    gpuClass,
    badge: gpuClass === "rtx4090" ? "低" : "高",
    modelStack: FLUX_IMAGE_STACK,
    status: "pending_confirmation",
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
}

function positiveSafeInteger(value: unknown) {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("invalid_requested_count");
  return count;
}

function groupTitle(prompt: string) {
  return Array.from(prompt).slice(0, 12).join("");
}

function createGroupChildren(input: Record<string, unknown>, requestedCount: number, groupId: string = randomUUID(), startIndex = 0, sharedCreatedAt = new Date().toISOString(), options?: TaskBuildOptions): ImageTask[] {
  const title = groupTitle(String(input.prompt ?? "").trim());
  return Array.from({ length: requestedCount }, (_, offset) => {
    const task = taskFrom(input, options);
    return {
      ...task,
      groupId,
      groupIndex: startIndex + offset + 1,
      groupRequestedCount: startIndex + requestedCount,
      groupCreatedAt: sharedCreatedAt,
      groupTitle: title,
      createdAt: sharedCreatedAt,
      updatedAt: sharedCreatedAt,
    };
  });
}

function groupIdentity(task: ImageTask) { return task.groupId || task.id; }

function assertUnconfirmIsSafe() {
  const runner = readRunner();
  // A terminal runner retains its host/order as historical evidence. It must
  // not make an unrelated waiting task look as though it has started.
  if (
    runner.state === "running"
    || runner.state === "cancelling"
    || processExists(runner.pid)
    || Boolean(activeStateLooksImageOrder())
  ) {
    throw new Error("任务已开始生成，请使用停止并退租。");
  }
  return runner;
}

function removeUnsubmittedFrozenGroupTasks(runner: ImageRunnerSession, groupId: string) {
  const ids = new Set(readTasks().filter((task) => groupIdentity(task) === groupId).map((task) => task.id));
  if (!ids.size || !runner.frozenTaskIds.some((id) => ids.has(id))) return;
  saveRunner({ ...runner, frozenTaskIds: runner.frozenTaskIds.filter((id) => !ids.has(id)), currentTaskIndex: null, currentModel: null, promptSummary: null, updatedAt: new Date().toISOString() });
}

function createGroupedTasks(input: Record<string, unknown>, loraSelections: TaskLoraSelections) {
  const requestedCount = positiveSafeInteger(input.requestedCount);
  const groupId = randomUUID();
  const children = createGroupChildren(input, requestedCount, groupId, 0, new Date().toISOString(), { loraSelections });
  const result = mutateImageTasks<ImageTask[]>((current) => ({ tasks: [...children, ...current], value: children }));
  return { groupId, createdTaskIds: result.map((task) => task.id), tasks: result };
}

function regenerateGroupedTasks(input: Record<string, unknown>) {
  const requestedCount = positiveSafeInteger(input.requestedCount);
  const requestedGroupId = String(input.groupId ?? "");
  if (!requestedGroupId) throw new Error("invalid_group_id");
  if (typeof input.prompt !== "string") throw new Error("invalid_image_task");
  return mutateImageTasks<{ groupId: string; createdTaskIds: string[]; tasks: ImageTask[] }>((current) => {
    const tasks = current as ImageTask[];
    const source = tasks.filter((task) => groupIdentity(task) === requestedGroupId);
    if (!source.length) throw new Error("image_group_not_found");
    const origin = source[0];
    const existingTotal = Math.max(source.length, ...source.map((task) => Math.max(Number.isSafeInteger(task.groupIndex) ? task.groupIndex! : 0, Number.isSafeInteger(task.groupRequestedCount) ? task.groupRequestedCount! : 0)));
    const total = existingTotal + requestedCount;
    const childInput: Record<string, unknown> = {
      prompt: input.prompt,
      negativePrompt: origin.negativePrompt ?? "",
      referenceImage: origin.referenceImage,
      width: origin.width,
      height: origin.height,
      steps: origin.steps,
      cfg: origin.cfg,
      loraStrength: origin.loraStrength,
      sampler: origin.sampler,
    };
    const children = createGroupChildren(
      childInput,
      requestedCount,
      requestedGroupId,
      existingTotal,
      new Date().toISOString(),
      {
        loras: origin.loras === undefined ? undefined : structuredClone(origin.loras),
        loraSelections: origin.loraSelections === undefined
          ? undefined
          : structuredClone(origin.loraSelections),
      },
    );
    const next = [...children.map((task) => ({ ...task, groupRequestedCount: total })), ...tasks];
    return { tasks: next, value: { groupId: requestedGroupId, createdTaskIds: children.map((task) => task.id), tasks: next } };
  });
}

type PendingGroupLoraResolution = {
  expectedUpdatedAt: string;
  loras: ImageTaskLora[];
};

/**
 * A pending card is created without network access. Confirmation is the
 * boundary that upgrades its server-owned registry selections to immutable
 * filename/size/SHA snapshots. A failed upgrade leaves the card pending.
 */
async function resolvePendingGroupLoras(groupId: string) {
  const pending = readTasks().filter((task) =>
    groupIdentity(task) === groupId
    && task.status === "pending_confirmation"
    && task.loras === undefined
    && task.loraSelections !== undefined);
  const cache = new Map<string, Promise<ImageTaskLora[]>>();
  const resolved = new Map<string, PendingGroupLoraResolution>();
  for (const task of pending) {
    const selections = assertImageTaskLoraSelections(task.loraSelections);
    const identity = JSON.stringify(selections);
    let resolution = cache.get(identity);
    if (!resolution) {
      resolution = resolveAndSnapshotTaskLoras(selections).then((loras) => {
        if (loras === undefined) throw new Error("invalid_image_task_lora_selections");
        return loras;
      });
      cache.set(identity, resolution);
    }
    resolved.set(task.id, {
      expectedUpdatedAt: task.updatedAt,
      loras: await resolution,
    });
  }
  return resolved;
}

async function resolvePendingTaskLora(taskId: string) {
  const task = readTasks().find((candidate) => candidate.id === taskId);
  if (
    !task
    || task.status !== "pending_confirmation"
    || task.loras !== undefined
    || task.loraSelections === undefined
  ) return null;
  const selections = assertImageTaskLoraSelections(task.loraSelections);
  const loras = await resolveAndSnapshotTaskLoras(selections);
  if (loras === undefined) throw new Error("invalid_image_task_lora_selections");
  return { expectedUpdatedAt: task.updatedAt, loras } satisfies PendingGroupLoraResolution;
}

function assertStartableBatch(batch: ImageTask[], maxHourlyPrice: number) {
  const classes = [...new Set(batch.map((task) => task.gpuClass))];
  if (!batch.length) throw new Error("no_confirmed_image_tasks_selected");
  if (batch.some((task) => task.loraSelections !== undefined && task.loras === undefined)) {
    throw new Error("image_task_lora_confirmation_incomplete");
  }
  if (classes.length !== 1) throw new Error("mixed_gpu_classes_are_not_allowed");
  if (!Number.isFinite(maxHourlyPrice) || maxHourlyPrice <= 0) throw new Error("invalid_max_hourly_price");
  const selectedGpuClass = classes[0];
  const blocker = readinessBlocker(selectedGpuClass);
  if (blocker) throw new Error(blocker);
  if (batch.some((task) => task.mode !== "text_generation" || task.referenceImage || classifyImageGpu(task.width, task.height) !== selectedGpuClass || !task.prompt.trim())) {
    throw new Error(KONTEXT_BLOCKER);
  }
}

function activeStateLooksImageOrder() {
  const active = readActiveOrder();
  if (!active) return null;
  const imageRuntime = active.bootstrap_image === COMFY_RUNTIME_IMAGE;
  const imagePort = Array.isArray(active.open_ports) && active.open_ports.map(String).includes("controller/http:8080");
  const imageGpu = active.gpu_profile === "rtx4090" || active.gpu_profile === "rtx5090" || /4090|5090/.test(active.gpu_type ?? "");
  return imageRuntime || imagePort || imageGpu ? active : null;
}

function matchingImageOrder(runner: ImageRunnerSession, orders: CloreOrderSummary[]) {
  const active = orders.filter((order) => order.active && order.orderId);
  const activeState = activeStateLooksImageOrder();
  const exactOwnedOrderIds = new Set<string>();
  if (activeState?.order_id) exactOwnedOrderIds.add(activeState.order_id);
  if (runner.host?.orderId) exactOwnedOrderIds.add(runner.host.orderId);
  const receipt = readSessionReceipt();
  if (
    typeof receipt?.orderId === "string"
    && receipt.orderId
    && (
      !runner.createAttempt?.id
      || receipt.sessionId === runner.createAttempt.id
    )
  ) {
    exactOwnedOrderIds.add(receipt.orderId);
  }
  const matches = active.filter((order) => exactOwnedOrderIds.has(order.orderId!));
  if (matches.length > 1) throw new Error("multiple_exact_owned_image_orders_detected");
  // Server IDs are deliberately not an ownership key: a later unrelated
  // order may reuse the same physical host.
  return matches[0] ?? null;
}

function resetRunnerAfterCancel(message: string, orderId: string | null) {
  returnFrozenTasksToWaiting(readRunner());
  const now = new Date().toISOString();
  saveRunner({
    ...defaultRunner(),
    state: "idle",
    stage: message,
    frozenTaskIds: [],
    gpuClass: null,
    currentTaskIndex: null,
    currentModel: null,
    promptSummary: null,
    startedAt: null,
    host: null,
    error: null,
    blocker: readinessBlocker(),
    pid: null,
    logPath: null,
    lastCancellation: { at: now, orderId, message },
    updatedAt: now,
  });
}

function receiptBelongsToRunner(
  runner: ImageRunnerSession,
  receipt: Record<string, unknown> | null,
) {
  if (!receipt || typeof receipt.sessionId !== "string") return false;
  if (runner.createAttempt?.id) return receipt.sessionId === runner.createAttempt.id;
  if (
    runner.host?.orderId
    && typeof receipt.orderId === "string"
    && receipt.orderId === runner.host.orderId
  ) return true;
  const selectedTaskIds = Array.isArray(receipt.selectedTaskIds)
    ? receipt.selectedTaskIds.map(String)
    : Object.keys(
        receipt.tasks && typeof receipt.tasks === "object" && !Array.isArray(receipt.tasks)
          ? receipt.tasks as Record<string, unknown>
          : {},
      );
  if (!runner.frozenTaskIds.length || selectedTaskIds.length !== runner.frozenTaskIds.length) return false;
  const selected = new Set(selectedTaskIds);
  return runner.frozenTaskIds.every((taskId) => selected.has(taskId));
}

async function reconcileKnownInactiveLocalSession(
  runner: ImageRunnerSession,
  receipt: Record<string, unknown> | null,
): Promise<CleanupLiveSessionResult> {
  const localActive = activeStateLooksImageOrder();
  const watchdog = (() => {
    try {
      return readLocalWatchdogArmState();
    } catch {
      return null;
    }
  })();
  const orderIds = new Set([
    localActive?.order_id,
    runner.host?.orderId,
    typeof receipt?.orderId === "string" ? receipt.orderId : null,
  ].filter((value): value is string => Boolean(value)));
  if (orderIds.size > 1) throw new Error("local_image_order_identity_mismatch");
  const serverIds = new Set([
    localActive?.server_id,
    runner.host?.serverId,
    typeof receipt?.serverId === "string" ? receipt.serverId : null,
    watchdog?.armed ? watchdog.serverId : null,
  ].filter((value): value is string => Boolean(value)));
  if (serverIds.size > 1) throw new Error("local_image_server_identity_mismatch");

  const orderId = [...orderIds][0] ?? `not-created-${runner.createAttempt?.id ?? "local"}`;
  const serverId = [...serverIds][0] ?? null;
  if (serverId && /^\d+$/.test(serverId)) {
    return await cleanupLiveSession({
      orderId,
      serverId,
      startingBalanceUsd: watchdog?.startingBalanceUsd ?? 0,
    }, {
      orderKnownInactive: true,
    });
  }
  if (watchdog?.armed) throw new Error("armed_watchdog_server_identity_missing");
  if (localActive) throw new Error("local_active_order_server_identity_missing");

  let zeroConfirmations = 0;
  for (let check = 0; check < 2; check += 1) {
    const active = await activeCloreOrders();
    if (active.length) throw new Error("active_order_appeared_during_inactive_reconciliation");
    zeroConfirmations += 1;
    if (check === 0) await new Promise((resolve) => setTimeout(resolve, 1_200));
  }
  clearLocalActiveImageState();
  return {
    cancellationState: "reconciled_inactive",
    zeroConfirmations,
    watchdogDisarmed: true,
    localOrderStateCleared: true,
    cleanupConfirmed: true,
    cleanupErrors: [],
  };
}

async function persistOperatorCleanupReceipt(
  runner: ImageRunnerSession,
  receipt: Record<string, unknown> | null,
  cleanup: CleanupLiveSessionResult,
) {
  if (!receiptBelongsToRunner(runner, receipt) || !receipt) return;
  let reconciled = receipt;
  if (typeof receipt.orderId === "string" && receipt.orderId) {
    reconciled = (await cleanupReceiptOwnedOrder(receipt, {
      cleanup: async () => cleanup,
    })).receipt ?? receipt;
  } else {
    reconciled = structuredClone(receipt);
    reconciled.cancellationState = "not_created";
    reconciled.cleanupErrors = cleanup.cleanupErrors;
    reconciled.cleanupEvidence = {
      zeroActiveOrderConfirmations: cleanup.zeroConfirmations,
      watchdogDisarmed: cleanup.watchdogDisarmed,
      localOrderStateCleared: cleanup.localOrderStateCleared,
    };
  }
  const sessionId = typeof reconciled.sessionId === "string" ? reconciled.sessionId : null;
  if (!sessionId) throw new Error("image_session_receipt_identity_missing_after_cleanup");
  const now = new Date().toISOString();
  const terminal = terminalizeReceipt(reconciled, {
    sessionId,
    state: workerTerminalState(reconciled, "failed"),
    error: "operator_cancelled_image_batch",
    now,
  });
  if (terminal) atomicSessionReceipt(sessionReceiptPath, terminal);
}

async function cancelCurrentImageBatch() {
  const release = acquireRunnerStartLock(`cancel:${randomUUID()}`);
  try {
    const runner = readRunner();
    saveRunner({ ...runner, state: "cancelling", stage: "正在停止任务并核对账单状态" });
    stopRunnerProcessTree(runner.pid);
    const receipt = readSessionReceipt();
    const orders = await activeCloreOrders();
    const order = matchingImageOrder(runner, orders);
    if (!order?.orderId) {
      if (orders.length) throw new Error("unrelated_or_unowned_active_order_detected");
      const cleanup = await reconcileKnownInactiveLocalSession(
        runner,
        receiptBelongsToRunner(runner, receipt) ? receipt : null,
      );
      if (!cleanup.cleanupConfirmed) {
        throw new Error(`账单清理状态未确认：${cleanup.cleanupErrors.join("；") || "unknown_cleanup_error"}`);
      }
      await persistOperatorCleanupReceipt(runner, receipt, cleanup);
      if (processExists(runner.pid)) throw new Error("paid_runner_process_remains_after_stop");
      const message = "当前没有活动订单；已完成两次清零核对并清理本地批次状态。";
      clearStaleCreateLocks();
      resetRunnerAfterCancel(message, null);
      return { orderId: null, cancelled: false, message };
    }
    const execution = loadCloreExecutionConfig();
    if (!execution.enabled) throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false，无法执行真实退租。");
    const watchdog = (() => {
      try {
        return readLocalWatchdogArmState();
      } catch {
        return null;
      }
    })();
    const serverId = order.serverId ?? runner.host?.serverId;
    if (!serverId || !/^\d+$/.test(serverId)) {
      throw new Error("owned_image_order_server_identity_missing");
    }
    const cleanup = await cleanupLiveSession({
      orderId: order.orderId,
      serverId,
      startingBalanceUsd: watchdog?.startingBalanceUsd ?? 0,
    });
    if (!cleanup.cleanupConfirmed) {
      throw new Error(`退租状态未确认：${cleanup.cleanupErrors.join("；") || "unknown_cleanup_error"}`);
    }
    await persistOperatorCleanupReceipt(runner, receipt, cleanup);
    if (processExists(runner.pid)) throw new Error("paid_runner_process_remains_after_stop");
    const message = `已退租图像订单 ${order.orderId}。`;
    clearStaleCreateLocks();
    resetRunnerAfterCancel(message, order.orderId);
    return { orderId: order.orderId, cancelled: true, message };
  } finally {
    release();
  }
}

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  const payload = request.nextUrl.searchParams.get("view") === "logs"
    ? { logs: currentStudioLogExport() }
    : await responsePayload();
  return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "create");
  let tasks = readTasks();
  try {
    if (action === "cancel_batch") {
      const cancellation = await cancelCurrentImageBatch();
      return NextResponse.json(await responsePayload({ cancellation }));
    }

    if (action === "create") {
      // Creating a pending card is deliberately network-free. Confirmation
      // resolves these server-validated registry selections before the task
      // can become eligible for paid execution.
      const loraSelections = snapshotTaskLoraSelections(body.loras);
      const task = taskFrom(body, { loraSelections });
      tasks = updateTasks((current) => [task, ...current.filter((candidate) => candidate.id !== task.id)]);
      return NextResponse.json({ task, ...(await responsePayload()) });
    }

    if (action === "create_group") {
      // All children share the same local-only selection snapshot. A later
      // confirmation performs one provider resolution for the whole group.
      const loraSelections = snapshotTaskLoraSelections(body.loras);
      const created = createGroupedTasks(body, loraSelections);
      return NextResponse.json({
        groupId: created.groupId,
        createdTaskIds: created.createdTaskIds,
        group: { id: created.groupId, requestedCount: created.tasks.length, title: created.tasks[0]?.groupTitle ?? "" },
        tasks: readTasks(),
      });
    }

    if (action === "regenerate_group") {
      const regenerated = regenerateGroupedTasks(body);
      return NextResponse.json({
        groupId: regenerated.groupId,
        createdTaskIds: regenerated.createdTaskIds,
        group: { id: regenerated.groupId, requestedCount: regenerated.tasks.filter((task) => groupIdentity(task) === regenerated.groupId).length },
        tasks: readTasks(),
      });
    }

    if (["confirm_group", "cancel_group", "retry_failed_group", "unconfirm_group"].includes(action)) {
      const groupId = String(body.groupId ?? "");
      if (!groupId) throw new Error("invalid_group_id");
      const updatedAt = new Date().toISOString();
      const runner = action === "unconfirm_group" ? assertUnconfirmIsSafe() : null;
      const pendingLoraResolutions = action === "confirm_group"
        ? await resolvePendingGroupLoras(groupId)
        : new Map<string, PendingGroupLoraResolution>();
      const outcome = mutateImageTasks<Record<string, unknown>>((current) => {
        const imageTasks = current as ImageTask[];
        if (action === "confirm_group") {
          for (const task of imageTasks) {
            if (
              groupIdentity(task) === groupId
              && task.status === "pending_confirmation"
              && task.loraSelections !== undefined
              && task.loras === undefined
              && !pendingLoraResolutions.has(task.id)
            ) {
              throw new Error("image_task_changed_during_lora_confirmation");
            }
            const resolution = pendingLoraResolutions.get(task.id);
            if (!resolution) continue;
            if (
              groupIdentity(task) !== groupId
              || task.status !== "pending_confirmation"
              || task.updatedAt !== resolution.expectedUpdatedAt
              || task.loras !== undefined
            ) {
              throw new Error("image_task_changed_during_lora_confirmation");
            }
            task.loras = structuredClone(resolution.loras);
          }
          const result = confirmImageTaskGroup(imageTasks, groupId, updatedAt);
          return { tasks: result.tasks as LocalImageTask[], value: { action, ...result } };
        }
        if (action === "cancel_group") {
          const result = deletePendingImageTaskGroup(imageTasks, groupId);
          return { tasks: result.tasks as LocalImageTask[], value: { action, ...result } };
        }
        if (action === "unconfirm_group") {
          const result = unconfirmImageTaskGroup(imageTasks, groupId, updatedAt);
          return { tasks: result.tasks as LocalImageTask[], value: { action, ...result } };
        }
        const result = retryFailedImageTaskGroup(imageTasks, groupId, updatedAt);
        return { tasks: result.tasks as LocalImageTask[], value: { action, ...result } };
      });
      if (action === "unconfirm_group" && runner) removeUnsubmittedFrozenGroupTasks(runner, groupId);
      return NextResponse.json(await responsePayload({ groupId, groupAction: outcome }));
    }

    if (action === "set_price") {
      const maxHourlyPrice = Number(body.maxHourlyPrice);
      if (!Number.isFinite(maxHourlyPrice) || maxHourlyPrice <= 0 || maxHourlyPrice > 100) throw new Error("invalid_max_hourly_price");
      writeJson(PREFERENCES_PATH, { maxHourlyPrice });
      const runner = readRunner();
      if (runner.state === "idle") saveRunner({ ...runner, maxHourlyPrice });
      return NextResponse.json(await responsePayload());
    }

    if (action === "start_batch") {
      const attemptId = randomUUID();
      const releaseStartLock = acquireRunnerStartLock(attemptId);
      try {
      const ids = [...new Set(Array.isArray(body.taskIds) ? body.taskIds.map(String).filter(Boolean) : [])];
      const maxHourlyPrice = Number(body.maxHourlyPrice);
      const previous = await reconcileStaleRunner(readRunner());
      if (previous.state === "running" || previous.state === "cancelling" || processExists(previous.pid)) throw new Error(DUPLICATE_START_MESSAGE);
      await assertNoActiveProviderOrderBeforeStart(previous);
      const batch = tasks.filter((task) => ids.includes(task.id) && task.status === "waiting_for_gpu");
      if (batch.length !== ids.length) {
        const changedTaskId = ids.find((id) => !batch.some((task) => task.id === id)) ?? "未知任务";
        throw new Error(`任务 ${changedTaskId} 在启动前发生变化，已取消本次启动，请刷新后重试。`);
      }
      assertStartableBatch(batch, maxHourlyPrice);
      const planned = planImageSession(batch, {
        requestedTaskIds: ids,
        gpuClass: batch[0]?.gpuClass,
        maxBatchSize: ids.length,
        activeOrderCount: 0,
        selectedHourlyUsd: maxHourlyPrice,
      });
      if (planned.selectedTaskIds.length !== ids.length || new Set(planned.selectedTaskIds).size !== ids.length) {
        const changedTaskId = ids.find((id) => !planned.selectedTaskIds.includes(id)) ?? "未知任务";
        throw new Error(`任务 ${changedTaskId} 在启动前发生变化，已取消本次启动，请刷新后重试。`);
      }
      const profile = assertRtx4090GoldenDeploymentProfile();
      const startedAt = new Date().toISOString();
      writeJson(PREFERENCES_PATH, { maxHourlyPrice });
      saveRunner({
        ...previous,
        state: "running",
        stage: "正在寻找显卡",
        frozenTaskIds: planned.selectedTaskIds,
        gpuClass: batch[0]?.gpuClass ?? null,
        maxHourlyPrice,
        currentTaskIndex: null,
        currentModel: null,
        promptSummary: null,
        startedAt,
        host: null,
        error: null,
        blocker: null,
        pid: null,
        logPath: RUNNER_LOG_PATH,
        createAttempt: { id: attemptId, startedAt, phase: "creating_order", requestAttempts: 0 },
        updatedAt: startedAt,
      });
      const child = spawn(process.execPath, [
        path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(process.cwd(), "scripts", "clore", "image-session-supervisor.ts"),
        "start",
        "--execute",
        "--session-id",
        attemptId,
        "--task-ids",
        planned.selectedTaskIds.join(","),
        "--deployment-profile-fingerprint",
        rtx4090GoldenDeploymentFingerprint(profile),
        "--immutable-commit",
        profile.immutable.commit,
        "--agent-source-sha256",
        profile.immutable.agentSourceSha256,
        "--agent-sha256",
        profile.immutable.agentSha256,
        "--controller-sha256",
        profile.immutable.controllerSha256,
        "--workflow-sha256",
        profile.immutable.workflowSha256,
      ], {
        cwd: process.cwd(),
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let supervisorStdoutBuffer = "";
      const publishWorkerStart = (line: string) => {
        if (!line.trim()) return;
        try {
          const started = JSON.parse(line) as { sessionId?: unknown; pid?: unknown };
          const workerPid = Number(started.pid);
          const current = readRunner();
          if (started.sessionId === attemptId && Number.isSafeInteger(workerPid) && workerPid > 0 && current.createAttempt?.id === attemptId) {
            saveRunner({
              ...current,
              pid: workerPid,
              logPath: path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions", attemptId, "worker.log"),
            });
          }
        } catch {
          // Only the supervisor's single JSON start receipt may publish the
          // detached worker PID; other output remains diagnostic log text.
        }
      };
      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        appendRunnerLog("stdout", text);
        supervisorStdoutBuffer += text;
        const lines = supervisorStdoutBuffer.split(/\r?\n/);
        supervisorStdoutBuffer = lines.pop() ?? "";
        for (const line of lines) publishWorkerStart(line);
      });
      child.stderr?.on("data", (chunk) => appendRunnerLog("stderr", String(chunk)));
      child.on("error", (error) => {
        appendRunnerLog("event", `child_error:${error.message}`);
        const current = readRunner();
        if (!terminalRunnerState(current.state) && current.createAttempt?.id === attemptId) {
          saveRunner({
            ...current,
            state: "failed",
            stage: "runner_exited",
            host: null,
            error: { stage: "runner_exited", message: `image session supervisor failed to start: ${error.message}`, at: new Date().toISOString() },
            blocker: "image_session_supervisor_start_failed",
          });
        }
      });
      child.on("close", (code, signal) => {
        publishWorkerStart(supervisorStdoutBuffer);
        supervisorStdoutBuffer = "";
        appendRunnerLog("event", `supervisor_close code=${code ?? "null"} signal=${signal ?? "null"}`);
        const current = readRunner();
        const supervisorDidNotPublishWorker =
          current.createAttempt?.id === attemptId &&
          (current.pid === null || current.pid === child.pid);
        if (!terminalRunnerState(current.state) && supervisorDidNotPublishWorker) {
          const boundedRunnerLog = readBoundedSanitizedLog(RUNNER_LOG_PATH, "Studio 启动器日志");
          const stderr = boundedRunnerLog ? finalSanitizedLogLines(boundedRunnerLog.text, 8).join("\n") : "";
          saveRunner({
            ...current,
            state: "failed",
            stage: "runner_exited",
            host: null,
            error: {
              stage: "runner_exited",
              message: `image session supervisor exited without publishing a worker: code=${code ?? "null"} signal=${signal ?? "null"}${stderr ? `\n${stderr}` : ""}`,
              at: new Date().toISOString(),
              classification: "preorder_supervisor_start_failed",
            },
            blocker: "image_session_worker_start_failed",
          });
        }
      });
      return NextResponse.json(await responsePayload());
      } finally {
        releaseStartLock();
      }
    }

    const id = String(body.id ?? "");
    if (!tasks.some((task) => task.id === id)) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
    if (!["delete", "confirm", "retry"].includes(action)) return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    const updatedAt = new Date().toISOString();
    const pendingLoraResolution = action === "confirm"
      ? await resolvePendingTaskLora(id)
      : null;
    tasks = mutateImageTasks<ImageTask[]>((current) => {
      const imageTasks = current as ImageTask[];
      const selectedTask = imageTasks.find((task) => task.id === id);
      if (!selectedTask) throw new Error("task_not_found");
      if (requiresManualInferenceRecovery(selectedTask)) {
        throw new Error("图片生成请求可能已经提交但结果未确认，为避免重复生成，已禁止确认、重试或删除该任务。");
      }
      if (action === "delete") {
        if (selectedTask.status !== "pending_confirmation" || selectedTask.localClaim || selectedTask.result) {
          throw new Error("任务状态已变化，只能删除尚未确认的任务。");
        }
        const next = imageTasks.filter((task) => task.id !== id);
        return { tasks: next, value: next };
      }
      if (action === "confirm") {
        if (selectedTask.status !== "pending_confirmation" || selectedTask.localClaim || selectedTask.result) {
          throw new Error("任务状态已变化，只能确认尚未确认的任务。");
        }
        if (
          selectedTask.loraSelections !== undefined
          && selectedTask.loras === undefined
          && !pendingLoraResolution
        ) {
          throw new Error("image_task_changed_during_lora_confirmation");
        }
        if (
          pendingLoraResolution
          && (
            selectedTask.updatedAt !== pendingLoraResolution.expectedUpdatedAt
            || selectedTask.loras !== undefined
          )
        ) {
          throw new Error("image_task_changed_during_lora_confirmation");
        }
        const next = imageTasks.map((task) => task.id === id
          ? {
            ...task,
            ...(pendingLoraResolution ? { loras: structuredClone(pendingLoraResolution.loras) } : {}),
            status: "waiting_for_gpu" as const,
            updatedAt,
          }
          : task);
        return { tasks: next, value: next };
      }
      if (selectedTask.status !== "failed" || selectedTask.localClaim || selectedTask.result || selectedTask.error?.retryable !== true) {
        throw new Error("任务状态已变化，只能重试明确标记为可重试的失败任务。");
      }
      const next = imageTasks.map((task) => task.id === id
        ? { ...task, status: "pending_confirmation" as const, attempts: Number(task.attempts ?? 0) + 1, updatedAt, error: undefined }
        : task);
      return { tasks: next, value: next };
    });
    return NextResponse.json(await responsePayload());
  } catch (error) {
    const message = publicTaskCreationError(error);
    if (["create", "create_group", "confirm_group", "cancel_group", "retry_failed_group", "unconfirm_group", "regenerate_group", "confirm", "retry", "delete"].includes(action)) {
      return NextResponse.json({ error: message, ...(await responsePayload()) }, { status: 400 });
    }
    const runner = readRunner();
    saveRunner({
      ...runner,
      state: "failed",
      stage: "执行失败",
      error: { stage: action === "cancel_batch" ? "退租" : "开始批次", message, at: new Date().toISOString() },
    });
    return NextResponse.json({ error: message, ...(await responsePayload()) }, { status: 400 });
  }
}
