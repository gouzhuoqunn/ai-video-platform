import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { publishLocalImageArtifact } from "../../src/lib/image-generation/local-image-artifacts";
import { mutateImageTasks, readImageTask, recoverCompletedImageTaskFromVerifiedArtifact } from "../../src/lib/image-generation/local-image-task-store";
import { freshRunRequiresManualRecovery } from "./run-image-e2e";
import { hasUnfinishedLocalExecution, isSafePreOrderReceipt, isSafeTerminalReceipt, terminalizeReceipt, terminalizeWorkerSnapshot, workerTerminalState, type WorkerState } from "./image-session-supervision";

const sessionId = "8520171f-1be2-4f8a-8e36-4d8a8c02d032";
const taskA = "66d42c71-61e3-49f4-a867-2b2745bc0102";
const taskB = "1c77684f-5632-4aec-9d86-3f3ee0380101";
const now = "2026-07-26T11:07:22.000Z";
const worker: WorkerState = {
  schemaVersion: 1,
  sessionId,
  pid: 1,
  state: "running",
  taskIds: [taskA, taskB],
  deploymentProfileFingerprint: "b".repeat(64),
  immutableCommit: "a".repeat(40),
  agentSourceSha256: "c".repeat(64),
  agentSha256: "d".repeat(64),
  controllerSha256: "e".repeat(64),
  workflowSha256: "f".repeat(64),
  startedAt: now,
  lastHeartbeatAt: now,
  completedAt: null,
  exitCode: null,
  sanitizedError: null,
  sessionReceiptPath: "receipt.json",
  logPath: "worker.log",
};
const receipt = { sessionId, sessionState: "running", currentTaskId: taskA, cleanupEvidence: { zeroActiveOrderConfirmations: 2, watchdogDisarmed: true }, tasks: { [taskA]: { terminal: "not_started", inferenceState: "accepted" }, [taskB]: { terminal: "not_started", inferenceState: "not_started" } }, timestamps: {} };

const ambiguous = terminalizeWorkerSnapshot(worker, receipt, { error: "unhandled_rejection:simulated", exitCode: 1, now });
assert.equal(ambiguous.worker.state, "ambiguous");
assert.equal(ambiguous.worker.sanitizedError, "unhandled_rejection:simulated");
assert.equal(ambiguous.receipt?.sessionState, "ambiguous");
assert.equal(ambiguous.receipt?.tasks[taskA].terminal, "ambiguous");
assert.equal(ambiguous.receipt?.tasks[taskB].terminal, "not_started");
assert.deepEqual(ambiguous.receipt?.cleanupEvidence, receipt.cleanupEvidence);
assert.equal(workerTerminalState({ sessionState: "completed" }, "failed"), "succeeded");
const failed = terminalizeReceipt({ sessionId, sessionState: "running", currentTaskId: taskA, tasks: { [taskA]: { terminal: "not_started", inferenceState: "not_started" } }, timestamps: {} }, { sessionId, state: "failed", error: "worker_process_exited_without_terminal_state", now });
assert.equal(failed?.sessionState, "failed");
assert.equal(failed?.currentTaskId, null);
assert.equal(freshRunRequiresManualRecovery({ taskId: taskA, inferenceState: "accepted" }, taskA, "waiting_for_gpu"), true);
assert.equal(freshRunRequiresManualRecovery({ taskId: taskA, inferenceState: "not_started" }, taskA, "waiting_for_gpu"), false);
assert.equal(isSafePreOrderReceipt({ orderId: null, currentTaskId: null, sessionState: "starting", tasks: { [taskA]: { terminal: "not_started", inferenceState: "not_started" } }}), true);
assert.equal(isSafePreOrderReceipt({ orderId: null, currentTaskId: null, sessionState: "starting", tasks: {} }), false);
assert.equal(isSafePreOrderReceipt({ orderId: null, currentTaskId: taskA, sessionState: "starting", tasks: { [taskA]: { terminal: "not_started", inferenceState: "not_started" } }}), false);
assert.equal(isSafePreOrderReceipt({ orderId: null, currentTaskId: null, sessionState: "starting", tasks: { [taskA]: { terminal: "ambiguous", inferenceState: "accepted" } }}), false);
assert.equal(isSafeTerminalReceipt({ orderId: "order", currentTaskId: null, sessionState: "completed", cancellationState: "cancelled", cleanupEvidence: { zeroActiveOrderConfirmations: 2, watchdogDisarmed: true, localOrderStateCleared: true }, tasks: {} }), true);
assert.equal(isSafeTerminalReceipt({ orderId: "order", currentTaskId: null, sessionState: "completed", cancellationState: "cancelled", cleanupEvidence: { zeroActiveOrderConfirmations: 1, watchdogDisarmed: true, localOrderStateCleared: true }, tasks: {} }), false);
const localStateRoot = mkdtempSync(path.join(os.tmpdir(), "image-session-local-state-"));
const projectRoot = process.cwd();
try {
  process.chdir(localStateRoot);
  assert.equal(hasUnfinishedLocalExecution(), false);
  mkdirSync(path.join(".secrets", "image-studio"), { recursive: true });
  writeFileSync(path.join(".secrets", "image-studio", "runner-session.json"), JSON.stringify({
    state: "running",
    pid: null,
    createAttempt: { id: "current-attempt" },
  }), "utf8");
  writeFileSync(path.join(".secrets", "image-studio", "runner-start.lock"), JSON.stringify({
    attemptId: "current-attempt",
  }), "utf8");
  assert.equal(hasUnfinishedLocalExecution(), true, "ordinary callers must treat the start handshake as unfinished");
  assert.equal(hasUnfinishedLocalExecution({ allowedRunnerAttemptId: "current-attempt", allowedRunnerPid: process.pid }), false, "the exact current supervisor handoff may inspect the prior receipt");
  assert.equal(hasUnfinishedLocalExecution({ allowedRunnerAttemptId: "wrong-attempt", allowedRunnerPid: process.pid }), true, "a different attempt cannot reuse the start-lock exception");
} finally {
  process.chdir(projectRoot);
  rmSync(localStateRoot, { recursive: true, force: true });
}
const supervisorSource = readFileSync("scripts/clore/image-session-supervisor.ts", "utf8");
assert.match(supervisorSource, /terminalizeDeadWorker\b/);
assert.doesNotMatch(supervisorSource, /terminalizeDeadWorkerWithCleanup/);
const workerSource = readFileSync("scripts/clore/image-session-worker.ts", "utf8");
assert.match(workerSource, /if \(!terminal && !finishing\) save\(\{ lastHeartbeatAt:/, "a queued heartbeat cannot overwrite terminal worker state");

async function testVerifiedArtifactRecovery() {
const temp = mkdtempSync(path.join(os.tmpdir(), "image-session-terminalization-"));
try {
  const store = path.join(temp, "tasks.json"); const artifacts = path.join(temp, "artifacts");
  const png = await sharp({ create: { width: 768, height: 768, channels: 3, background: "#335577" } }).png().toBuffer();
  const artifact = await publishLocalImageArtifact({ task: { id: taskA, prompt: "test", mode: "text_generation", width: 768, height: 768, steps: 25, cfg: 4, loraStrength: .8, seed: 1, sampler: "euler" }, png, remote: { generationDurationSeconds: 1, orderId: "sanitized", gpuModel: "RTX 4090", controllerPromptId: null }, root: artifacts });
  mutateImageTasks(() => ({ tasks: [{ id: taskA, status: "pending_confirmation", updatedAt: now, result: artifact, finalizedClaimTokenHash: "f".repeat(64), attempts: 1 }, { id: taskB, status: "pending_confirmation", updatedAt: now, attempts: 1 }], value: null }), { taskPath: store, artifactRoot: artifacts });
  const recovered = await recoverCompletedImageTaskFromVerifiedArtifact(taskA, { taskPath: store, artifactRoot: artifacts, now: () => new Date(now) });
  assert.equal(recovered.status, "completed"); assert.equal(recovered.result?.pngSha256, artifact.pngSha256); assert.equal((recovered as Record<string, unknown>).attempts, 1);
  assert.equal(readImageTask(taskB, { taskPath: store })?.status, "pending_confirmation");
  await assert.rejects(() => recoverCompletedImageTaskFromVerifiedArtifact(taskB, { taskPath: store, artifactRoot: artifacts }), /local_task_recovery_requires_finalized_artifact/);
} finally { rmSync(temp, { recursive: true, force: true }); }
}

void testVerifiedArtifactRecovery().then(() => console.log(JSON.stringify({ ok: true, localOnlyStatus: true, exactSupervisorStartLockHandoff: true, staleWorkerGuard: true, verifiedArtifactRecovery: true, providerMutationCount: 0 })));
