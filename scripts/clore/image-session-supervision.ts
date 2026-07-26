import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import { listImageTasks } from "../../src/lib/image-generation/local-image-task-store";
import { loadCloreConfig } from "./config";
import { readLiveOrdersSummary } from "./live";

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
export async function archiveSafePrior(taskIds: string[]) { const receipt = readReceipt(); if (!receipt) return null; const unsafe = (receipt.sessionState !== "completed" && receipt.sessionState !== "failed") || receipt.currentTaskId !== null || !["cancelled", "reconciled_inactive"].includes(String(receipt.cancellationState)) || receiptHasAcceptedInference(receipt); if (unsafe) throw new Error("prior_session_receipt_unsafe"); const active = await readLiveOrdersSummary(loadCloreConfig(), { forceRefresh: true }); if (active.some((order) => order.active)) throw new Error("prior_session_active_order_exists"); const tasks = listImageTasks(); for (const id of taskIds) { const task = tasks.find((item) => item.id === id); if (!task || task.status !== "waiting_for_gpu" || task.result || task.localClaim) throw new Error("prior_session_target_task_changed"); } const archive = path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions", "archive", `${receipt.sessionId}.json`); mkdirSync(path.dirname(archive), { recursive: true }); renameSync(sessionReceiptPath, archive); return archive; }
