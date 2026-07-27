import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import { listImageTasks } from "../../src/lib/image-generation/local-image-task-store";
import { loadCloreConfig } from "./config";
import { readLiveOrdersSummary } from "./live";
import { readActiveOrder } from "./order-state";
import { readLocalWatchdogArmState } from "./watchdog-io";
import { cleanupLiveSession, type CleanupLiveSessionResult } from "./image-live-runtime";

type ReceiptRecord = Record<string, unknown>;
type ReceiptTask = Record<string, unknown>;
export type WorkerTerminalState = "succeeded" | "failed" | "ambiguous";
export type WorkerState = { schemaVersion: 1; sessionId: string; pid: number | null; state: "starting" | "running" | WorkerTerminalState; taskIds: string[]; immutableCommit: string; startedAt: string; lastHeartbeatAt: string; completedAt: string | null; exitCode: number | null; sanitizedError: string | null; sessionReceiptPath: string; logPath: string };
export const root = (id: string) => path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions", id);
export const workerPath = (id: string) => path.join(root(id), "worker-state.json");
export const sessionReceiptPath = path.join(process.cwd(), ".secrets", "clore-image-session-receipt.json");
export const clean = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/(bearer\s+)[^\s]+/gi, "$1<redacted>").replace(/https?:\/\/[^\s]+/gi, "<redacted-url>").replace(/(token|credential|authorization|prompt)\s*[:=]\s*\S+/gi, "$1=<redacted>").slice(0, 700);
export function atomic(file: string, value: unknown) { mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; const descriptor = openSync(temporary, "w", 0o600); try { writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); } renameSync(temporary, file); }
export function readWorker(id: string) { try { return JSON.parse(readFileSync(workerPath(id), "utf8")) as WorkerState; } catch { return null; } }
export function readReceipt() { try { return JSON.parse(readFileSync(sessionReceiptPath, "utf8")) as ReceiptRecord; } catch { return null; } }
function record(value: unknown): ReceiptTask | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ReceiptTask : null; }
function taskRecords(receipt: ReceiptRecord | null) { const tasks = record(receipt?.tasks); return tasks ? Object.values(tasks).flatMap((task) => { const value = record(task); return value ? [value] : []; }) : []; }
export function receiptHasAcceptedInference(receipt: ReceiptRecord | null) { return taskRecords(receipt).some((task) => ["submitting", "accepted"].includes(String(task.inferenceState)) || task.terminal === "ambiguous"); }
export function workerTerminalState(receipt: ReceiptRecord | null, fallback: WorkerTerminalState) : WorkerTerminalState { if (receipt?.sessionState === "completed") return "succeeded"; if (receipt?.sessionState === "ambiguous" || receiptHasAcceptedInference(receipt)) return "ambiguous"; return fallback; }
export function terminalizeReceipt(receipt: ReceiptRecord | null, input: { sessionId: string; state: WorkerTerminalState; error: string; now: string }) {
  if (!receipt || receipt.sessionId !== input.sessionId) return receipt;
  const next = structuredClone(receipt); next.currentTaskId = null;
  const timestamps = record(next.timestamps) ?? {}; timestamps.worker_terminalized = input.now; next.timestamps = timestamps;
  if (next.sessionState !== "completed") {
    if (input.state === "ambiguous") { next.sessionState = "ambiguous"; for (const task of taskRecords(next)) if (["submitting", "accepted"].includes(String(task.inferenceState))) task.terminal = "ambiguous"; }
    else if (next.sessionState !== "ambiguous") { next.sessionState = "failed"; if (!timestamps.failed) timestamps.failed = input.now; }
    if (!next.firstError) next.firstError = input.error;
  }
  return next;
}
export function terminalizeWorkerSnapshot(worker: WorkerState, receipt: ReceiptRecord | null, input: { error: string; exitCode: number; now: string }) {
  const state = workerTerminalState(receipt, "failed");
  return { state, receipt: terminalizeReceipt(receipt, { sessionId: worker.sessionId, state, error: input.error, now: input.now }), worker: { ...worker, state, lastHeartbeatAt: input.now, completedAt: input.now, exitCode: input.exitCode, sanitizedError: worker.sanitizedError ?? input.error } satisfies WorkerState };
}
export function terminalizeDeadWorker(id: string, now = new Date().toISOString()) {
  const worker = readWorker(id); if (!worker || ["succeeded", "failed", "ambiguous"].includes(worker.state)) return worker;
  const terminal = terminalizeWorkerSnapshot(worker, readReceipt(), { error: "worker_process_exited_without_terminal_state", exitCode: worker.exitCode ?? 1, now });
  if (terminal.receipt) atomic(sessionReceiptPath, terminal.receipt);
  atomic(workerPath(id), terminal.worker); return terminal.worker;
}

function processAlive(pid: unknown) {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function readJsonRecord(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * A new session may rotate a prior receipt only when no local execution owner
 * can still mutate billing or task state.  This is intentionally local-only;
 * the caller performs the single fresh provider reconciliation separately.
 */
export function hasUnfinishedLocalExecution(options: { allowedRunnerAttemptId?: string; allowedRunnerPid?: number } = {}) {
  const providerCreateLocks = [
    path.join(process.cwd(), ".secrets", "clore-order-create.lock"),
    path.join(process.cwd(), ".secrets", "clore-create.lock"),
  ];
  if (providerCreateLocks.some((file) => existsSync(file))) return true;

  const runner = readJsonRecord(path.join(process.cwd(), ".secrets", "image-studio", "runner-session.json"));
  let isCurrentSupervisorStart = false;
  if (runner) {
    const state = String(runner.state ?? "");
    const createAttempt = record(runner.createAttempt);
    isCurrentSupervisorStart =
      typeof options.allowedRunnerAttemptId === "string" &&
      options.allowedRunnerAttemptId.length > 0 &&
      createAttempt?.id === options.allowedRunnerAttemptId &&
      (runner.pid === null || runner.pid === undefined || Number(runner.pid) === options.allowedRunnerPid);
    if (!isCurrentSupervisorStart && (processAlive(runner.pid) || ["starting", "running", "cancelling"].includes(state))) return true;
  }
  const runnerStartLock = path.join(process.cwd(), ".secrets", "image-studio", "runner-start.lock");
  if (existsSync(runnerStartLock)) {
    const lock = readJsonRecord(runnerStartLock);
    if (!isCurrentSupervisorStart || lock?.attemptId !== options.allowedRunnerAttemptId) return true;
  }

  if (existsSync(path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions"))) {
    for (const sessionId of readdirSync(path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions"))) {
      const worker = readJsonRecord(workerPath(sessionId));
      if (!worker) continue;
      const state = String(worker.state ?? "");
      if (processAlive(worker.pid) || ["starting", "running"].includes(state)) return true;
    }
  }

  try {
    if (readLocalWatchdogArmState()?.armed === true) return true;
  } catch {
    return true;
  }
  return false;
}
export function isSafePreOrderReceipt(receipt: ReceiptRecord | null) {
  if (!receipt || receipt.orderId !== null || receipt.currentTaskId !== null || receiptHasAcceptedInference(receipt)) return false;
  const tasks = taskRecords(receipt);
  return tasks.length > 0 && tasks.every((task) => task.inferenceState === "not_started" && task.terminal === "not_started");
}

export async function cleanupReceiptOwnedOrder(
  receipt: ReceiptRecord | null,
  options: {
    cleanup?: (order: { orderId: string; serverId: string; startingBalanceUsd: number }) => Promise<CleanupLiveSessionResult>;
    now?: () => string;
  } = {},
) {
  if (!receipt || typeof receipt.orderId !== "string" || !receipt.orderId) return { receipt, cleanup: null };
  const priorEvidence = record(receipt.cleanupEvidence);
  if (Number(priorEvidence?.zeroActiveOrderConfirmations) === 2 && priorEvidence?.watchdogDisarmed === true && priorEvidence?.localOrderStateCleared === true) {
    return { receipt, cleanup: null };
  }
  const active = (() => {
    try { return readActiveOrder(); } catch { return null; }
  })();
  const watchdog = (() => {
    try { return readLocalWatchdogArmState(); } catch { return null; }
  })();
  const order = {
    orderId: receipt.orderId,
    serverId: typeof receipt.serverId === "string" && receipt.serverId ? receipt.serverId : active?.server_id ?? "unknown",
    startingBalanceUsd: typeof watchdog?.startingBalanceUsd === "number" ? watchdog.startingBalanceUsd : 0,
  };
  const cleanup = await (options.cleanup ?? (async (value) => await cleanupLiveSession(value)))(order);
  const next = structuredClone(receipt);
  next.cancellationState = cleanup.cancellationState;
  next.cleanupErrors = cleanup.cleanupErrors;
  next.cleanupEvidence = {
    zeroActiveOrderConfirmations: cleanup.zeroConfirmations,
    watchdogDisarmed: cleanup.watchdogDisarmed,
    localOrderStateCleared: cleanup.localOrderStateCleared,
  };
  const timestamps = record(next.timestamps) ?? {};
  timestamps.cleanup = options.now?.() ?? new Date().toISOString();
  next.timestamps = timestamps;
  if (!cleanup.cleanupConfirmed) {
    next.sessionState = "ambiguous";
    next.firstError = next.firstError ?? "order_cleanup_unconfirmed_after_worker_failure";
  }
  return { receipt: next, cleanup };
}

export function isSafeTerminalReceipt(receipt: ReceiptRecord | null) {
  if (!receipt || !["completed", "failed"].includes(String(receipt.sessionState)) || receipt.currentTaskId !== null || receiptHasAcceptedInference(receipt)) return false;
  if (!["cancelled", "reconciled_inactive", "not_created"].includes(String(receipt.cancellationState))) return false;
  if (receipt.orderId === null) return true;
  const evidence = record(receipt.cleanupEvidence);
  return Number(evidence?.zeroActiveOrderConfirmations) === 2 && evidence?.watchdogDisarmed === true && evidence?.localOrderStateCleared === true;
}

export async function archiveSafePrior(taskIds: string[], options: { allowedRunnerAttemptId?: string; allowedRunnerPid?: number } = {}) {
  const receipt = readReceipt();
  if (!receipt) return null;
  const terminalAndClean = isSafeTerminalReceipt(receipt);
  const safePreOrder = isSafePreOrderReceipt(receipt);
  if (!terminalAndClean && !safePreOrder) throw new Error("prior_session_receipt_unsafe");
  if (hasUnfinishedLocalExecution(options)) throw new Error("prior_session_local_execution_state_present");
  const active = await readLiveOrdersSummary(loadCloreConfig(), { forceRefresh: true });
  if (active.some((order) => order.active)) throw new Error("prior_session_active_order_exists");
  const tasks = listImageTasks();
  for (const id of taskIds) {
    const task = tasks.find((item) => item.id === id);
    if (!task || task.status !== "waiting_for_gpu" || task.result || task.localClaim) throw new Error("prior_session_target_task_changed");
  }
  const archive = path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions", "archive", `${receipt.sessionId}.json`);
  mkdirSync(path.dirname(archive), { recursive: true });
  // Renaming preserves the stale receipt byte-for-byte as historical evidence.
  renameSync(sessionReceiptPath, archive);
  return archive;
}
