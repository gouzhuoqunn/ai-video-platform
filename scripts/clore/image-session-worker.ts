import { runLiveImageSession } from "./image-session-live";
import { atomic, clean, readReceipt, root, sessionReceiptPath, terminalizeWorkerSnapshot, workerPath, type WorkerState } from "./image-session-supervision";

const arg = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const taskIds = (arg("--task-ids") ?? "").split(",").filter(Boolean);
const sessionId = arg("--session-id") ?? "";
const immutableCommit = arg("--immutable-commit") ?? "";
const worker: WorkerState = { schemaVersion: 1, sessionId, pid: process.pid, state: "starting", taskIds, immutableCommit, startedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), completedAt: null, exitCode: null, sanitizedError: null, sessionReceiptPath, logPath: `${root(sessionId)}/worker.log` };
let timer: NodeJS.Timeout | null = null;
let terminal = false;

function save(patch: Partial<WorkerState> = {}) { Object.assign(worker, patch); atomic(workerPath(sessionId), worker); }
function finish(error: string | null, exitCode: number) {
  if (terminal) return;
  terminal = true;
  if (timer) clearInterval(timer);
  const now = new Date().toISOString();
  const final = terminalizeWorkerSnapshot(worker, readReceipt(), { error: error ?? "worker_completed", exitCode, now });
  if (final.receipt) atomic(sessionReceiptPath, final.receipt);
  Object.assign(worker, final.worker, { sanitizedError: error ? clean(error) : final.worker.sanitizedError });
  atomic(workerPath(sessionId), worker);
}
function fatal(kind: string, error: unknown) { finish(`${kind}:${clean(error)}`, 1); process.exitCode = 1; }

process.on("uncaughtException", (error) => fatal("uncaught_exception", error));
process.on("unhandledRejection", (reason) => fatal("unhandled_rejection", reason));
process.on("exit", (code) => { if (!terminal) finish("worker_process_exited_without_terminal_state", code || 1); });

async function main() {
  if (!sessionId || taskIds.length !== 2 || !immutableCommit || !process.argv.includes("--execute")) {
    fatal("worker_arguments_invalid", "image_session_worker_arguments_invalid");
    return;
  }
  save({ state: "running" });
  timer = setInterval(() => save({ lastHeartbeatAt: new Date().toISOString() }), 15_000);
  try {
    await runLiveImageSession({ sessionId, taskIds, execute: true, immutable: { commit: immutableCommit, agentSha256: arg("--agent-sha256") ?? "", controllerSha256: arg("--controller-sha256") ?? "", workflowSha256: arg("--workflow-sha256") ?? "" } });
    finish(null, 0);
  } catch (error) {
    fatal("run_live_image_session", error);
  }
}

void main();
