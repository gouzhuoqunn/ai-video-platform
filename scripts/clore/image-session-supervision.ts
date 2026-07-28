import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import {
  listImageTasks,
  reconcileStoppedImageTasksWithAmbiguousInference,
  recoverCompletedImageTaskFromVerifiedArtifact,
  type AmbiguousInferenceEvidence,
  type LocalImageTask,
  type LocalTaskStoreOptions,
} from "../../src/lib/image-generation/local-image-task-store";
import { inferenceRetryBlockMatches, requiresManualInferenceRecovery } from "../../src/lib/image-generation/image-task-retry-policy";
import { loadCloreConfig } from "./config";
import { readLiveOrdersSummary } from "./live";
import { readActiveOrder } from "./order-state";
import { readLocalWatchdogArmState } from "./watchdog-io";
import { cleanupLiveSession, type CleanupLiveSessionResult } from "./image-live-runtime";

type ReceiptRecord = Record<string, unknown>;
type ReceiptTask = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type WorkerTerminalState = "succeeded" | "failed" | "ambiguous";
export type WorkerState = {
  schemaVersion: 1;
  sessionId: string;
  pid: number | null;
  state: "starting" | "running" | WorkerTerminalState;
  taskIds: string[];
  deploymentProfileFingerprint: string;
  immutableCommit: string;
  agentSourceSha256: string;
  agentSha256: string;
  controllerSha256: string;
  workflowSha256: string;
  startedAt: string;
  lastHeartbeatAt: string;
  completedAt: string | null;
  exitCode: number | null;
  sanitizedError: string | null;
  sessionReceiptPath: string;
  logPath: string;
};
export const root = (id: string) => path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions", id);
export const workerPath = (id: string) => path.join(root(id), "worker-state.json");
export const sessionReceiptPath = path.join(process.cwd(), ".secrets", "clore-image-session-receipt.json");
export const clean = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/(bearer\s+)[^\s]+/gi, "$1<redacted>").replace(/https?:\/\/[^\s]+/gi, "<redacted-url>").replace(/(token|credential|authorization|prompt)\s*[:=]\s*\S+/gi, "$1=<redacted>").slice(0, 700);
export function atomic(file: string, value: unknown) { mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; const descriptor = openSync(temporary, "w", 0o600); try { writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); } renameSync(temporary, file); }
export function readWorker(id: string) { try { return JSON.parse(readFileSync(workerPath(id), "utf8")) as WorkerState; } catch { return null; } }
export function readReceipt(file = sessionReceiptPath) { try { return JSON.parse(readFileSync(file, "utf8")) as ReceiptRecord; } catch { return null; } }
function record(value: unknown): ReceiptTask | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ReceiptTask : null; }
function taskRecords(receipt: ReceiptRecord | null) { const tasks = record(receipt?.tasks); return tasks ? Object.values(tasks).flatMap((task) => { const value = record(task); return value ? [value] : []; }) : []; }
type StrictReceiptTaskEntry = {
  taskId: string;
  task: ReceiptTask;
  terminal: "not_started" | "completed" | "failed" | "ambiguous";
  inferenceState: "not_started" | "submitting" | "accepted" | "succeeded" | "failed";
  stageRunId: string | null;
};
function strictReceiptTaskEntries(receipt: ReceiptRecord | null): StrictReceiptTaskEntry[] | null {
  const tasks = record(receipt?.tasks);
  if (!tasks) return null;
  const entries: StrictReceiptTaskEntry[] = [];
  for (const [rawTaskId, rawTask] of Object.entries(tasks)) {
    const task = record(rawTask);
    const terminal = task?.terminal;
    const inferenceState = task?.inferenceState;
    const rawStageRunId = task?.stageRunId;
    if (
      !UUID.test(rawTaskId)
      || !task
      || !["not_started", "completed", "failed", "ambiguous"].includes(String(terminal))
      || !["not_started", "submitting", "accepted", "succeeded", "failed"].includes(String(inferenceState))
      || !(rawStageRunId === null || rawStageRunId === undefined || (typeof rawStageRunId === "string" && UUID.test(rawStageRunId)))
    ) return null;
    const terminalState = terminal as StrictReceiptTaskEntry["terminal"];
    const inference = inferenceState as StrictReceiptTaskEntry["inferenceState"];
    const stageRunId = typeof rawStageRunId === "string" ? rawStageRunId.toLowerCase() : null;
    const validPair =
      (terminalState === "not_started" && ["not_started", "submitting", "accepted"].includes(inference))
      || (terminalState === "ambiguous" && ["submitting", "accepted"].includes(inference))
      || (terminalState === "completed" && inference === "succeeded")
      || (terminalState === "failed" && ["not_started", "failed"].includes(inference));
    if (!validPair || (["submitting", "accepted", "succeeded"].includes(inference) && stageRunId === null)) return null;
    entries.push({ taskId: rawTaskId.toLowerCase(), task, terminal: terminalState, inferenceState: inference, stageRunId });
  }
  return entries;
}
export function receiptHasAcceptedInference(receipt: ReceiptRecord | null) {
  const entries = strictReceiptTaskEntries(receipt);
  return receipt !== null && (
    entries === null
    || entries.some((entry) => ["submitting", "accepted"].includes(entry.inferenceState) || entry.terminal === "ambiguous")
  );
}
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
  if (worker.sessionId !== id || processStatus(worker.pid) !== "dead") return worker;
  const receipt = readReceipt();
  const matchingReceipt = receipt?.sessionId === id ? receipt : null;
  const terminal = terminalizeWorkerSnapshot(worker, matchingReceipt, { error: "worker_process_exited_without_terminal_state", exitCode: worker.exitCode ?? 1, now });
  if (terminal.receipt) atomic(sessionReceiptPath, terminal.receipt);
  atomic(workerPath(id), terminal.worker); return terminal.worker;
}

type ProcessStatus = "alive" | "dead" | "unknown";
function processStatus(pid: unknown): ProcessStatus {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return "unknown";
  try {
    process.kill(Number(pid), 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
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
export function hasUnfinishedLocalExecution(options: { allowedRunnerAttemptId?: string; allowedRunnerPid?: number; processStatus?: (pid: unknown) => ProcessStatus } = {}) {
  const probeProcess = options.processStatus ?? processStatus;
  const providerCreateLocks = [
    path.join(process.cwd(), ".secrets", "clore-order-create.lock"),
    path.join(process.cwd(), ".secrets", "clore-create.lock"),
  ];
  if (providerCreateLocks.some((file) => existsSync(file))) return true;

  const runnerPath = path.join(process.cwd(), ".secrets", "image-studio", "runner-session.json");
  const runner = readJsonRecord(runnerPath);
  if (existsSync(runnerPath) && !runner) return true;
  let isCurrentSupervisorStart = false;
  if (runner) {
    const state = String(runner.state ?? "");
    const createAttempt = record(runner.createAttempt);
    isCurrentSupervisorStart =
      typeof options.allowedRunnerAttemptId === "string" &&
      options.allowedRunnerAttemptId.length > 0 &&
      createAttempt?.id === options.allowedRunnerAttemptId &&
      (runner.pid === null || runner.pid === undefined || Number(runner.pid) === options.allowedRunnerPid);
    if (!isCurrentSupervisorStart) {
      const runnerProcess = probeProcess(runner.pid);
      const activeState = ["starting", "running", "cancelling"].includes(state);
      const terminalState = ["idle", "failed", "completed"].includes(state);
      if (!activeState && !terminalState) return true;
      if (runnerProcess === "alive") return true;
      if (activeState && runnerProcess !== "dead") return true;
      if (terminalState && Number.isSafeInteger(runner.pid) && Number(runner.pid) > 0 && runnerProcess !== "dead") return true;
    }
  }
  const runnerStartLock = path.join(process.cwd(), ".secrets", "image-studio", "runner-start.lock");
  if (existsSync(runnerStartLock)) {
    const lock = readJsonRecord(runnerStartLock);
    if (!isCurrentSupervisorStart || lock?.attemptId !== options.allowedRunnerAttemptId) return true;
  }

  if (existsSync(path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions"))) {
    for (const sessionId of readdirSync(path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions"))) {
      const file = workerPath(sessionId);
      if (!existsSync(file)) continue;
      const worker = readJsonRecord(file);
      if (!worker) return true;
      const state = String(worker.state ?? "");
      const terminal = ["succeeded", "failed", "ambiguous"].includes(state);
      if (!terminal && !["starting", "running"].includes(state)) return true;
      if (terminal) {
        if (!Number.isSafeInteger(worker.pid) || Number(worker.pid) <= 0 || probeProcess(worker.pid) !== "dead") return true;
        continue;
      }
      if (worker.sessionId !== sessionId || !Number.isSafeInteger(worker.pid) || Number(worker.pid) <= 0) return true;
      // Only a structurally valid Worker whose exact PID is provably absent
      // can be ignored. Unreadable/invalid/permission-ambiguous state remains
      // fail-closed.
      if (probeProcess(worker.pid) !== "dead") return true;
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
  const tasks = strictReceiptTaskEntries(receipt);
  return Boolean(tasks && tasks.length > 0 && tasks.every((entry) => entry.inferenceState === "not_started" && entry.terminal === "not_started"));
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
  const tasks = strictReceiptTaskEntries(receipt);
  if (!receipt || !tasks?.length || !["completed", "failed"].includes(String(receipt.sessionState)) || receipt.currentTaskId !== null || receiptHasAcceptedInference(receipt)) return false;
  if (!["cancelled", "reconciled_inactive", "not_created"].includes(String(receipt.cancellationState))) return false;
  if (receipt.orderId === null) return true;
  const evidence = record(receipt.cleanupEvidence);
  return Number(evidence?.zeroActiveOrderConfirmations) === 2 && evidence?.watchdogDisarmed === true && evidence?.localOrderStateCleared === true;
}

export type AmbiguousReceiptTaskEvidence = { taskId: string } & AmbiguousInferenceEvidence;

/**
 * Only a billing-clean, stopped receipt can be converted into task-level
 * exactly-once tombstones. This never treats an ambiguous provider state as
 * clean and never changes completed tasks.
 */
export function ambiguousReceiptTaskEvidence(receipt: ReceiptRecord | null): AmbiguousReceiptTaskEvidence[] | null {
  if (
    !receipt
    || receipt.sessionState !== "ambiguous"
    || receipt.currentTaskId !== null
    || typeof receipt.sessionId !== "string"
    || !UUID.test(receipt.sessionId)
    || typeof receipt.orderId !== "string"
    || !receipt.orderId
    || !["cancelled", "reconciled_inactive"].includes(String(receipt.cancellationState))
  ) {
    return null;
  }
  const cleanup = record(receipt.cleanupEvidence);
  if (
    Number(cleanup?.zeroActiveOrderConfirmations) !== 2
    || cleanup?.watchdogDisarmed !== true
    || cleanup?.localOrderStateCleared !== true
  ) {
    return null;
  }
  const tasks = strictReceiptTaskEntries(receipt);
  if (!tasks) return null;
  const evidence: AmbiguousReceiptTaskEvidence[] = [];
  for (const task of tasks) {
    const inferenceState = task.inferenceState;
    const ambiguous = task.terminal === "ambiguous";
    if (!ambiguous && !["submitting", "accepted"].includes(inferenceState)) continue;
    evidence.push({
      taskId: task.taskId,
      sessionId: receipt.sessionId.toLowerCase(),
      stageRunId: task.stageRunId,
      inferenceState: ambiguous ? "ambiguous" : inferenceState as "submitting" | "accepted",
    });
  }
  return evidence.length ? evidence : null;
}

export function ambiguousReceiptTasksAreQuarantined(
  receipt: ReceiptRecord | null,
  tasks: readonly LocalImageTask[],
  verifiedCompletedTaskIds: ReadonlySet<string> = new Set(),
) {
  const evidence = ambiguousReceiptTaskEvidence(receipt);
  if (!evidence) return false;
  return evidence.every((item) => {
    const task = tasks.find((candidate) => candidate.id === item.taskId);
    return Boolean(
      task
      && (
        (
          verifiedCompletedTaskIds.has(item.taskId)
          && task.status === "completed"
          && Boolean(task.result)
          && !task.localClaim
        )
        || (
          task.status === "failed"
          && !task.result
          && !task.localClaim
          && requiresManualInferenceRecovery(task)
          && inferenceRetryBlockMatches(task, item)
        )
      ),
    );
  });
}

export async function archiveSafePrior(
  taskIds: string[],
  options: {
    allowedRunnerAttemptId?: string;
    allowedRunnerPid?: number;
    immutableSourcePreflight?: () => Promise<unknown>;
    receiptPath?: string;
    archiveRoot?: string;
    taskStoreOptions?: LocalTaskStoreOptions;
    hasUnfinishedExecution?: () => boolean;
    readActiveOrders?: () => Promise<Array<{ active: boolean }>>;
    readLocalActiveOrder?: () => unknown;
    processStatus?: (pid: unknown) => ProcessStatus;
  } = {},
) {
  const receiptPath = options.receiptPath ?? sessionReceiptPath;
  if (!existsSync(receiptPath)) return null;
  const receipt = readReceipt(receiptPath);
  if (!receipt) throw new Error("prior_session_receipt_unreadable");
  const receiptTasks = strictReceiptTaskEntries(receipt);
  if (!receiptTasks) throw new Error("prior_session_manual_recovery_required");
  const terminalAndClean = isSafeTerminalReceipt(receipt);
  const safePreOrder = isSafePreOrderReceipt(receipt);
  const ambiguousEvidence = ambiguousReceiptTaskEvidence(receipt);
  if (!terminalAndClean && !safePreOrder && !ambiguousEvidence) throw new Error("prior_session_manual_recovery_required");
  if ((options.hasUnfinishedExecution ?? (() => hasUnfinishedLocalExecution(options)))()) {
    throw new Error("prior_session_local_execution_state_present");
  }
  const localActiveOrder = options.readLocalActiveOrder ? options.readLocalActiveOrder() : readActiveOrder();
  if (localActiveOrder) throw new Error("prior_session_local_active_order_exists");
  const completedReceiptTaskIds = receiptTasks
    .filter((entry) => entry.terminal === "completed" && entry.inferenceState === "succeeded")
    .map((entry) => entry.taskId);
  for (const completedTaskId of completedReceiptTaskIds) {
    try {
      await recoverCompletedImageTaskFromVerifiedArtifact(completedTaskId, options.taskStoreOptions);
    } catch {
      throw new Error("prior_session_manual_recovery_required");
    }
  }
  if (ambiguousEvidence) {
    const before = listImageTasks(options.taskStoreOptions);
    const verifiedCompletedTaskIds = new Set<string>();
    const unresolvedEvidence: AmbiguousReceiptTaskEvidence[] = [];
    for (const item of ambiguousEvidence) {
      const task = before.find((candidate) => candidate.id === item.taskId);
      if (task?.result && task.finalizedClaimTokenHash) {
        await recoverCompletedImageTaskFromVerifiedArtifact(item.taskId, options.taskStoreOptions);
        verifiedCompletedTaskIds.add(item.taskId);
      } else {
        unresolvedEvidence.push(item);
      }
    }
    if (unresolvedEvidence.length) {
      reconcileStoppedImageTasksWithAmbiguousInference(unresolvedEvidence, options.taskStoreOptions);
    }
    if (!ambiguousReceiptTasksAreQuarantined(receipt, listImageTasks(options.taskStoreOptions), verifiedCompletedTaskIds)) {
      throw new Error("prior_session_manual_recovery_required");
    }
  }
  // A failed immutable-source gate must not be preceded by a provider read.
  // The supervisor performs this canonical, read-only source check before the
  // mandatory active-order reconciliation.
  await options.immutableSourcePreflight?.();
  const active = await (options.readActiveOrders
    ? options.readActiveOrders()
    : readLiveOrdersSummary(loadCloreConfig(), { forceRefresh: true }));
  if (active.some((order) => order.active)) throw new Error("prior_session_active_order_exists");
  const tasks = listImageTasks(options.taskStoreOptions);
  for (const id of taskIds) {
    const task = tasks.find((item) => item.id === id);
    if (!task || task.status !== "waiting_for_gpu" || task.result || task.localClaim || requiresManualInferenceRecovery(task)) {
      throw new Error("prior_session_target_task_changed");
    }
  }
  if (typeof receipt.sessionId !== "string" || !UUID.test(receipt.sessionId)) throw new Error("prior_session_id_invalid");
  const archive = path.join(
    options.archiveRoot ?? path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions", "archive"),
    `${receipt.sessionId.toLowerCase()}.json`,
  );
  mkdirSync(path.dirname(archive), { recursive: true });
  archiveReceiptNoClobber(receiptPath, archive);
  return archive;
}

function archiveReceiptNoClobber(source: string, archive: string) {
  const sourceBytes = readFileSync(source);
  let linked = false;
  if (existsSync(archive)) {
    if (!readFileSync(archive).equals(sourceBytes)) throw new Error("prior_session_archive_conflict");
  } else {
    try {
      // A same-volume hard link publishes either all receipt bytes or none.
      // Unlike writing the final path directly, a crash cannot leave a partial
      // archive that permanently conflicts with the intact source receipt.
      linkSync(source, archive);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!readFileSync(archive).equals(sourceBytes)) throw new Error("prior_session_archive_conflict");
    }
  }
  if (!readFileSync(archive).equals(sourceBytes)) {
    if (linked) unlinkSync(archive);
    throw new Error("prior_session_archive_verification_failed");
  }
  unlinkSync(source);
}
