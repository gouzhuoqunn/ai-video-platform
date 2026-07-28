import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { publishLocalImageArtifact } from "../../src/lib/image-generation/local-image-artifacts";
import { mutateImageTasks, readImageTask, recoverCompletedImageTaskFromVerifiedArtifact } from "../../src/lib/image-generation/local-image-task-store";
import { freshRunRequiresManualRecovery } from "./run-image-e2e";
import { ambiguousReceiptTaskEvidence, archiveSafePrior, hasUnfinishedLocalExecution, isSafePreOrderReceipt, isSafeTerminalReceipt, terminalizeReceipt, terminalizeWorkerSnapshot, workerPath, workerTerminalState, type WorkerState } from "./image-session-supervision";

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
assert.equal(isSafeTerminalReceipt({ orderId: "order", currentTaskId: null, sessionState: "completed", cancellationState: "cancelled", cleanupEvidence: { zeroActiveOrderConfirmations: 2, watchdogDisarmed: true, localOrderStateCleared: true }, tasks: { [taskA]: { terminal: "not_started", inferenceState: "not_started" } } }), true);
assert.equal(isSafeTerminalReceipt({ orderId: "order", currentTaskId: null, sessionState: "completed", cancellationState: "cancelled", cleanupEvidence: { zeroActiveOrderConfirmations: 1, watchdogDisarmed: true, localOrderStateCleared: true }, tasks: { [taskA]: { terminal: "not_started", inferenceState: "not_started" } } }), false);
assert.equal(isSafeTerminalReceipt({ orderId: "order", currentTaskId: null, sessionState: "completed", cancellationState: "cancelled", cleanupEvidence: { zeroActiveOrderConfirmations: 2, watchdogDisarmed: true, localOrderStateCleared: true }, tasks: { [taskA]: "corrupt" } }), false);
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
  const deadWorkerSession = "923e4567-e89b-42d3-a456-426614174000";
  mkdirSync(path.dirname(workerPath(deadWorkerSession)), { recursive: true });
  writeFileSync(workerPath(deadWorkerSession), JSON.stringify({
    sessionId: deadWorkerSession,
    pid: 2_147_483_647,
    state: "running",
  }), "utf8");
  assert.equal(
    hasUnfinishedLocalExecution({ allowedRunnerAttemptId: "current-attempt", allowedRunnerPid: process.pid }),
    false,
    "a dead stale Worker label cannot permanently block a new session",
  );
  assert.equal(hasUnfinishedLocalExecution({ allowedRunnerAttemptId: "wrong-attempt", allowedRunnerPid: process.pid }), true, "a different attempt cannot reuse the start-lock exception");
  rmSync(path.join(".secrets", "image-studio", "runner-start.lock"), { force: true });
  writeFileSync(path.join(".secrets", "image-studio", "runner-session.json"), JSON.stringify({ state: "idle", pid: null }), "utf8");
  writeFileSync(workerPath(deadWorkerSession), JSON.stringify({ sessionId: deadWorkerSession, pid: 12345, state: "failed" }), "utf8");
  assert.equal(hasUnfinishedLocalExecution({ processStatus: () => "dead" }), false, "a terminal Worker with a provably dead PID is finished");
  assert.equal(hasUnfinishedLocalExecution({ processStatus: () => "unknown" }), true, "permission-ambiguous PID state must fail closed");
  writeFileSync(path.join(".secrets", "image-studio", "runner-session.json"), "{truncated", "utf8");
  assert.equal(hasUnfinishedLocalExecution(), true, "an existing unreadable Runner record must fail closed");
} finally {
  process.chdir(projectRoot);
  rmSync(localStateRoot, { recursive: true, force: true });
}
const supervisorSource = readFileSync("scripts/clore/image-session-supervisor.ts", "utf8");
assert.match(supervisorSource, /terminalizeDeadWorker\b/);
assert.doesNotMatch(supervisorSource, /terminalizeDeadWorkerWithCleanup/);
assert.match(supervisorSource, /rawReceipt\?\.sessionId===id\?rawReceipt:null/, "status output is bound to the exact worker session");
const supervisionSource = readFileSync("scripts/clore/image-session-supervision.ts", "utf8");
assert.match(supervisionSource, /receipt\?\.sessionId === id \? receipt : null/, "dead-worker terminalization cannot consume another session's receipt");
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

async function testAmbiguousReceiptQuarantineAndArchive() {
  const temp = mkdtempSync(path.join(os.tmpdir(), "image-session-ambiguous-recovery-"));
  const ambiguousTaskId = "423e4567-e89b-42d3-a456-426614174000";
  const targetTaskId = "523e4567-e89b-42d3-a456-426614174000";
  const completedTaskId = "623e4567-e89b-42d3-a456-426614174000";
  const stageRunId = "723e4567-e89b-42d3-a456-426614174000";
  const taskPath = path.join(temp, "tasks.json");
  const artifactRoot = path.join(temp, "artifacts");
  const receiptPath = path.join(temp, "receipt.json");
  const archiveRoot = path.join(temp, "archive");
  const completedPng = await sharp({ create: { width: 768, height: 768, channels: 3, background: "#224466" } }).png().toBuffer();
  const completedArtifact = await publishLocalImageArtifact({
    task: { id: completedTaskId, prompt: "completed fixture", mode: "text_generation", width: 768, height: 768, steps: 25, cfg: 4, loraStrength: .8, seed: 1, sampler: "Euler" },
    png: completedPng,
    remote: { generationDurationSeconds: 1, orderId: "sanitized", gpuModel: "RTX 4090", controllerPromptId: null },
    root: artifactRoot,
  });
  const completedTask = {
    id: completedTaskId,
    status: "completed",
    updatedAt: now,
    result: completedArtifact,
    finalizedClaimTokenHash: "a".repeat(64),
    attempts: 1,
  };
  const initialTasks = [
    { id: ambiguousTaskId, status: "failed", updatedAt: now, error: { message: "terminated", at: now, retryable: true }, attempts: 0 },
    { id: targetTaskId, status: "waiting_for_gpu", updatedAt: now, attempts: 0 },
    completedTask,
  ];
  const cleanReceipt = {
    sessionId,
    sessionState: "ambiguous",
    orderId: "1986571",
    serverId: "97978",
    currentTaskId: null,
    cancellationState: "cancelled",
    cleanupEvidence: { zeroActiveOrderConfirmations: 2, watchdogDisarmed: true, localOrderStateCleared: true },
    tasks: {
      [ambiguousTaskId]: { terminal: "ambiguous", inferenceState: "accepted", stageRunId },
      [completedTaskId]: { terminal: "ambiguous", inferenceState: "accepted", stageRunId: "823e4567-e89b-42d3-a456-426614174000" },
    },
  };
  try {
    writeFileSync(taskPath, `${JSON.stringify(initialTasks, null, 2)}\n`, "utf8");
    const receiptBytes = `${JSON.stringify(cleanReceipt, null, 2)}\n`;
    writeFileSync(receiptPath, receiptBytes, "utf8");
    assert.equal(ambiguousReceiptTaskEvidence(cleanReceipt)?.length, 2);
    const events: string[] = [];
    const archived = await archiveSafePrior([targetTaskId], {
      receiptPath,
      archiveRoot,
      taskStoreOptions: { taskPath, artifactRoot, now: () => new Date(now) },
      hasUnfinishedExecution: () => false,
      readLocalActiveOrder: () => null,
      immutableSourcePreflight: async () => { events.push("source"); },
      readActiveOrders: async () => { events.push("orders"); return []; },
    });
    assert.deepEqual(events, ["source", "orders"], "source verification remains before the read-only provider snapshot");
    assert.ok(archived);
    assert.equal(existsSync(receiptPath), false);
    assert.equal(readFileSync(archived!, "utf8"), receiptBytes, "the archived receipt remains byte-for-byte evidence");
    const recoveredTasks = JSON.parse(readFileSync(taskPath, "utf8")) as Array<Record<string, unknown>>;
    const quarantined = recoveredTasks.find((task) => task.id === ambiguousTaskId) as Record<string, unknown>;
    assert.equal(quarantined.status, "failed");
    assert.equal((quarantined.error as { retryable?: unknown }).retryable, false);
    assert.equal((quarantined.inferenceRetryBlock as { sessionId?: unknown }).sessionId, sessionId);
    assert.deepEqual(recoveredTasks.find((task) => task.id === completedTaskId), completedTask, "completed task and artifact evidence are untouched");
    assert.equal(recoveredTasks.find((task) => task.id === targetTaskId)?.status, "waiting_for_gpu");

    writeFileSync(receiptPath, receiptBytes, "utf8");
    const idempotentArchive = await archiveSafePrior([targetTaskId], {
      receiptPath,
      archiveRoot,
      taskStoreOptions: { taskPath, artifactRoot, now: () => new Date(now) },
      hasUnfinishedExecution: () => false,
      readLocalActiveOrder: () => null,
      immutableSourcePreflight: async () => undefined,
      readActiveOrders: async () => [],
    });
    assert.equal(idempotentArchive, archived);
    assert.equal(existsSync(receiptPath), false, "an identical existing archive permits idempotent source removal");

    const conflictingReceipt = {
      sessionId,
      sessionState: "starting",
      orderId: null,
      currentTaskId: null,
      cancellationState: "not_started",
      tasks: { [targetTaskId]: { terminal: "not_started", inferenceState: "not_started", stageRunId: null } },
    };
    writeFileSync(receiptPath, `${JSON.stringify(conflictingReceipt, null, 2)}\n`, "utf8");
    await assert.rejects(() => archiveSafePrior([targetTaskId], {
      receiptPath,
      archiveRoot,
      taskStoreOptions: { taskPath, artifactRoot, now: () => new Date(now) },
      hasUnfinishedExecution: () => false,
      readLocalActiveOrder: () => null,
      immutableSourcePreflight: async () => undefined,
      readActiveOrders: async () => [],
    }), /prior_session_archive_conflict/);
    assert.equal(existsSync(receiptPath), true, "a conflicting archive never removes the source receipt");

    const malformedReceiptPath = path.join(temp, "malformed-receipt.json");
    writeFileSync(malformedReceiptPath, "{truncated", "utf8");
    let malformedSourceCalls = 0;
    let malformedOrderReads = 0;
    const tasksBeforeMalformedReceipt = readFileSync(taskPath, "utf8");
    await assert.rejects(() => archiveSafePrior([targetTaskId], {
      receiptPath: malformedReceiptPath,
      archiveRoot,
      taskStoreOptions: { taskPath, artifactRoot, now: () => new Date(now) },
      hasUnfinishedExecution: () => false,
      readLocalActiveOrder: () => null,
      immutableSourcePreflight: async () => { malformedSourceCalls += 1; },
      readActiveOrders: async () => { malformedOrderReads += 1; return []; },
    }), /prior_session_receipt_unreadable/);
    assert.equal(malformedSourceCalls, 0);
    assert.equal(malformedOrderReads, 0);
    assert.equal(readFileSync(taskPath, "utf8"), tasksBeforeMalformedReceipt);

    const succeededReceiptPath = path.join(temp, "succeeded-receipt.json");
    writeFileSync(succeededReceiptPath, `${JSON.stringify({
      sessionId: "9520171f-1be2-4f8a-8e36-4d8a8c02d032",
      sessionState: "completed",
      orderId: "1986572",
      currentTaskId: null,
      cancellationState: "cancelled",
      cleanupEvidence: { zeroActiveOrderConfirmations: 2, watchdogDisarmed: true, localOrderStateCleared: true },
      tasks: { [targetTaskId]: { terminal: "completed", inferenceState: "succeeded", stageRunId } },
    }, null, 2)}\n`, "utf8");
    let succeededSourceCalls = 0;
    let succeededOrderReads = 0;
    await assert.rejects(() => archiveSafePrior([targetTaskId], {
      receiptPath: succeededReceiptPath,
      archiveRoot,
      taskStoreOptions: { taskPath, artifactRoot, now: () => new Date(now) },
      hasUnfinishedExecution: () => false,
      readLocalActiveOrder: () => null,
      immutableSourcePreflight: async () => { succeededSourceCalls += 1; },
      readActiveOrders: async () => { succeededOrderReads += 1; return []; },
    }), /prior_session_manual_recovery_required/);
    assert.equal(succeededSourceCalls, 0, "lost succeeded artifact blocks before source/network preflight");
    assert.equal(succeededOrderReads, 0);
    assert.equal(readImageTask(targetTaskId, { taskPath })?.status, "waiting_for_gpu");

    const localOrderReceiptPath = path.join(temp, "local-order-receipt.json");
    writeFileSync(localOrderReceiptPath, `${JSON.stringify({
      ...conflictingReceipt,
      sessionId: "a520171f-1be2-4f8a-8e36-4d8a8c02d032",
    }, null, 2)}\n`, "utf8");
    let localOrderSourceCalls = 0;
    await assert.rejects(() => archiveSafePrior([targetTaskId], {
      receiptPath: localOrderReceiptPath,
      archiveRoot,
      taskStoreOptions: { taskPath, artifactRoot, now: () => new Date(now) },
      hasUnfinishedExecution: () => false,
      readLocalActiveOrder: () => ({ order_id: "owned-order" }),
      immutableSourcePreflight: async () => { localOrderSourceCalls += 1; },
      readActiveOrders: async () => [],
    }), /prior_session_local_active_order_exists/);
    assert.equal(localOrderSourceCalls, 0);

    const unsafeReceiptPath = path.join(temp, "unsafe-receipt.json");
    const unsafeTaskPath = path.join(temp, "unsafe-tasks.json");
    const unsafeReceipt = {
      ...cleanReceipt,
      cleanupEvidence: { ...cleanReceipt.cleanupEvidence, zeroActiveOrderConfirmations: 1 },
    };
    const unsafeTasksBytes = `${JSON.stringify(initialTasks, null, 2)}\n`;
    writeFileSync(unsafeReceiptPath, `${JSON.stringify(unsafeReceipt, null, 2)}\n`, "utf8");
    writeFileSync(unsafeTaskPath, unsafeTasksBytes, "utf8");
    let sourceCalls = 0;
    let orderReads = 0;
    await assert.rejects(() => archiveSafePrior([targetTaskId], {
      receiptPath: unsafeReceiptPath,
      archiveRoot,
      taskStoreOptions: { taskPath: unsafeTaskPath, artifactRoot, now: () => new Date(now) },
      hasUnfinishedExecution: () => false,
      readLocalActiveOrder: () => null,
      immutableSourcePreflight: async () => { sourceCalls += 1; },
      readActiveOrders: async () => { orderReads += 1; return []; },
    }), /prior_session_manual_recovery_required/);
    assert.equal(sourceCalls, 0);
    assert.equal(orderReads, 0);
    assert.equal(readFileSync(unsafeTaskPath, "utf8"), unsafeTasksBytes, "incomplete cleanup proof causes zero task-store mutation");
    assert.equal(existsSync(unsafeReceiptPath), true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

void testVerifiedArtifactRecovery()
  .then(testAmbiguousReceiptQuarantineAndArchive)
  .then(() => console.log(JSON.stringify({ ok: true, localOnlyStatus: true, exactSupervisorStartLockHandoff: true, deadWorkerCannotPermanentlyBlock: true, malformedRunnerFailsClosed: true, unknownProcessStateFailsClosed: true, staleWorkerGuard: true, verifiedArtifactRecovery: true, succeededReceiptRequiresVerifiedArtifact: true, postFinalizationCrashPreservesCompletedTask: true, ambiguousAcceptedTaskQuarantined: true, cleanReceiptArchivedByteForByte: true, archiveNoClobber: true, malformedReceiptFailsClosed: true, localActiveOrderFailsClosed: true, incompleteCleanupZeroMutation: true, providerMutationCount: 0 })));
