import { runImage4090Batch } from "../image-4090-runner";
import { assertRtx4090GoldenDeploymentProfile, rtx4090GoldenDeploymentFingerprint } from "../image-executor/rtx4090-golden-deployment-profile";
import { atomic, clean, cleanupReceiptOwnedOrder, readReceipt, root, sessionReceiptPath, terminalizeWorkerSnapshot, workerPath, type WorkerState } from "./image-session-supervision";

const arg = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const taskIds = (arg("--task-ids") ?? "").split(",").filter(Boolean);
const sessionId = arg("--session-id") ?? "";
const deploymentProfileFingerprint = arg("--deployment-profile-fingerprint") ?? "";
const immutableCommit = arg("--immutable-commit") ?? "";
const agentSourceSha256 = arg("--agent-source-sha256") ?? "";
const agentSha256 = arg("--agent-sha256") ?? "";
const controllerSha256 = arg("--controller-sha256") ?? "";
const workflowSha256 = arg("--workflow-sha256") ?? "";
const worker: WorkerState = { schemaVersion: 1, sessionId, pid: process.pid, state: "starting", taskIds, deploymentProfileFingerprint, immutableCommit, agentSourceSha256, agentSha256, controllerSha256, workflowSha256, startedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), completedAt: null, exitCode: null, sanitizedError: null, sessionReceiptPath, logPath: `${root(sessionId)}/worker.log` };
let timer: NodeJS.Timeout | null = null;
let terminal = false;
let finishing = false;

function save(patch: Partial<WorkerState> = {}) { Object.assign(worker, patch); atomic(workerPath(sessionId), worker); }
async function finish(error: string | null, exitCode: number) {
  if (terminal || finishing) return;
  finishing = true;
  if (timer) clearInterval(timer);
  const now = new Date().toISOString();
  let cleanedReceipt = readReceipt();
  try {
    cleanedReceipt = (await cleanupReceiptOwnedOrder(cleanedReceipt, { now: () => now })).receipt;
  } catch (cleanupError) {
    const receipt = cleanedReceipt ? structuredClone(cleanedReceipt) : null;
    if (receipt) {
      receipt.sessionState = "ambiguous";
      receipt.cancellationState = "cancellation_unconfirmed";
      receipt.cleanupErrors = [...(Array.isArray(receipt.cleanupErrors) ? receipt.cleanupErrors : []), clean(cleanupError)];
      receipt.firstError = receipt.firstError ?? "order_cleanup_unconfirmed_after_worker_failure";
      cleanedReceipt = receipt;
    }
  }
  const final = terminalizeWorkerSnapshot(worker, cleanedReceipt, { error: error ?? "worker_completed", exitCode, now });
  if (final.receipt) atomic(sessionReceiptPath, final.receipt);
  Object.assign(worker, final.worker, { sanitizedError: error ? clean(error) : final.worker.sanitizedError });
  atomic(workerPath(sessionId), worker);
  terminal = true;
  finishing = false;
}
async function fatal(kind: string, error: unknown) { await finish(`${kind}:${clean(error)}`, 1); process.exitCode = 1; }

process.on("uncaughtException", (error) => { void fatal("uncaught_exception", error); });
process.on("unhandledRejection", (reason) => { void fatal("unhandled_rejection", reason); });
process.on("exit", (code) => {
  if (!terminal && !finishing) {
    const now = new Date().toISOString();
    const final = terminalizeWorkerSnapshot(worker, readReceipt(), { error: "worker_process_exited_without_terminal_state", exitCode: code || 1, now });
    if (final.receipt) atomic(sessionReceiptPath, final.receipt);
    atomic(workerPath(sessionId), final.worker);
  }
});

async function main() {
  if (!sessionId || taskIds.length < 1 || taskIds.length > 8 || new Set(taskIds).size !== taskIds.length || !deploymentProfileFingerprint || !immutableCommit || !agentSourceSha256 || !agentSha256 || !controllerSha256 || !workflowSha256 || !process.argv.includes("--execute")) {
    await fatal("worker_arguments_invalid", "image_session_worker_arguments_invalid");
    return;
  }
  const profile = assertRtx4090GoldenDeploymentProfile();
  if (
    deploymentProfileFingerprint !== rtx4090GoldenDeploymentFingerprint(profile) ||
    immutableCommit !== profile.immutable.commit ||
    agentSourceSha256 !== profile.immutable.agentSourceSha256 ||
    agentSha256 !== profile.immutable.agentSha256 ||
    controllerSha256 !== profile.immutable.controllerSha256 ||
    workflowSha256 !== profile.immutable.workflowSha256
  ) {
    await fatal("worker_arguments_invalid", "image_session_worker_immutable_profile_mismatch");
    return;
  }
  save({ state: "running" });
  timer = setInterval(() => {
    if (!terminal && !finishing) save({ lastHeartbeatAt: new Date().toISOString() });
  }, 15_000);
  try {
    await runImage4090Batch(undefined, { sessionId, taskIds });
    await finish(null, 0);
  } catch (error) {
    await fatal("run_live_image_session", error);
  }
}

void main();
