import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { type LocalArtifactReference, verifyPublishedLocalImageArtifact } from "./local-image-artifacts";
import type { ImageTaskLora } from "./image-loras";
import {
  AMBIGUOUS_INFERENCE_RETRY_CLASSIFICATION,
  AMBIGUOUS_INFERENCE_RETRY_MESSAGE,
  type InferenceRetryBlock,
  parseInferenceRetryBlock,
  requiresManualInferenceRecovery,
} from "./image-task-retry-policy";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_WAIT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export type LocalImageTask = Record<string, unknown> & {
  id: string;
  status: "pending_confirmation" | "waiting_for_gpu" | "generating" | "completed" | "failed";
  updatedAt: string;
  negativePrompt?: string;
  loras?: ImageTaskLora[];
  result?: LocalArtifactReference;
  /** Optional grouping metadata. Legacy tasks intentionally omit these fields. */
  groupId?: string;
  groupIndex?: number;
  groupRequestedCount?: number;
  groupCreatedAt?: string;
  groupTitle?: string;
  sourceGroupId?: string;
  localClaim?: { workerId: string; claimedAt: string; leaseExpiresAt: string; claimTokenHash: string };
  finalizedClaimTokenHash?: string;
  inferenceRetryBlock?: InferenceRetryBlock;
  error?: Record<string, unknown> & { message?: string; at?: string; retryable?: boolean; classification?: string };
};

export type LocalTaskStoreOptions = { taskPath?: string; artifactRoot?: string; lockWaitMs?: number; staleLockMs?: number; now?: () => Date };
export type AmbiguousInferenceEvidence = Pick<InferenceRetryBlock, "sessionId" | "stageRunId" | "inferenceState">;

function taskPath(options: LocalTaskStoreOptions) {
  return options.taskPath ?? process.env.AI_IMAGE_TASK_STORE_PATH ?? path.join(process.cwd(), ".secrets", "image-studio", "tasks.json");
}

function assertTaskId(value: string) {
  if (!TASK_ID.test(value)) throw new Error("invalid_image_task_id");
  return value.toLowerCase();
}

function sleep(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readTasksLocked(file: string): LocalImageTask[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is LocalImageTask => Boolean(item) && typeof item === "object" && TASK_ID.test(String((item as LocalImageTask).id))) : [];
  } catch {
    // Historical Studio data contained an unterminated badge string. Recover
    // only that known non-semantic display field; all task settings remain raw.
    const repaired = raw.replace(/("badge"\s*:\s*)"[^\r\n]*(?=,\s*"modelStack")/g, '$1"legacy"');
    try {
      const parsed = JSON.parse(repaired);
      if (Array.isArray(parsed)) return parsed.filter((item): item is LocalImageTask => Boolean(item) && typeof item === "object" && TASK_ID.test(String((item as LocalImageTask).id)));
    } catch { /* fail closed below */ }
    throw new Error("local_image_task_store_invalid_json");
  }
}

function atomicWriteTasks(file: string, tasks: LocalImageTask[]) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  const descriptor = openSync(temporary, "w");
  try {
    writeSync(descriptor, `${JSON.stringify(tasks, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
}

function lockDirectory(file: string) { return `${file}.lock`; }

function withLock<T>(options: LocalTaskStoreOptions, operation: (tasks: LocalImageTask[], write: (next: LocalImageTask[]) => void) => T): T {
  const file = taskPath(options); const lock = lockDirectory(file); const waitMs = options.lockWaitMs ?? LOCK_WAIT_MS; const staleMs = options.staleLockMs ?? STALE_LOCK_MS;
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) rmSync(lock, { recursive: true, force: true });
      } catch { /* another process resolved it */ }
      if (Date.now() >= deadline) throw new Error("local_image_task_lock_timeout");
      sleep(25);
    }
  }
  try {
    const tasks = readTasksLocked(file);
    return operation(tasks, (next) => atomicWriteTasks(file, next));
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function now(options: LocalTaskStoreOptions) { return (options.now?.() ?? new Date()).toISOString(); }
function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
function owned(task: LocalImageTask, token: string, at: number) {
  const claim = task.localClaim;
  return task.status === "generating" && Boolean(claim) && claim!.leaseExpiresAt > new Date(at).toISOString() && tokenHash(token) === claim!.claimTokenHash;
}
function normalizeInferenceEvidence(evidence: AmbiguousInferenceEvidence, recordedAt: string): InferenceRetryBlock {
  const parsed = parseInferenceRetryBlock({
    schemaVersion: 1,
    reason: "inference_submission_may_have_been_accepted",
    sessionId: evidence.sessionId,
    stageRunId: evidence.stageRunId,
    inferenceState: evidence.inferenceState,
    recordedAt,
  });
  if (!parsed) throw new Error("invalid_ambiguous_inference_evidence");
  return parsed;
}
function mergeInferenceRetryBlock(existingValue: unknown, incoming: InferenceRetryBlock) {
  if (existingValue === undefined || existingValue === null) return incoming;
  const existing = parseInferenceRetryBlock(existingValue);
  if (!existing) throw new Error("invalid_existing_inference_retry_block");
  if (existing.sessionId !== incoming.sessionId) throw new Error("inference_retry_block_session_conflict");
  if (existing.stageRunId && incoming.stageRunId && existing.stageRunId !== incoming.stageRunId) {
    throw new Error("inference_retry_block_stage_conflict");
  }
  const rank: Record<InferenceRetryBlock["inferenceState"], number> = { submitting: 0, accepted: 1, ambiguous: 2 };
  return {
    ...existing,
    stageRunId: existing.stageRunId ?? incoming.stageRunId,
    inferenceState: rank[incoming.inferenceState] > rank[existing.inferenceState]
      ? incoming.inferenceState
      : existing.inferenceState,
  } satisfies InferenceRetryBlock;
}
function ambiguousFailure(at: string): LocalImageTask["error"] {
  return {
    message: AMBIGUOUS_INFERENCE_RETRY_MESSAGE,
    at,
    retryable: false,
    classification: AMBIGUOUS_INFERENCE_RETRY_CLASSIFICATION,
  };
}

export function listImageTasks(options: LocalTaskStoreOptions = {}) { return withLock(options, (tasks) => structuredClone(tasks)); }
export function readImageTask(taskId: string, options: LocalTaskStoreOptions = {}) {
  const id = assertTaskId(taskId);
  return withLock(options, (tasks) => { const task = tasks.find((candidate) => candidate.id === id); return task ? structuredClone(task) : null; });
}
export function mutateImageTasks<T>(mutator: (tasks: LocalImageTask[]) => { tasks: LocalImageTask[]; value: T }, options: LocalTaskStoreOptions = {}) {
  return withLock(options, (tasks, write) => { const result = mutator(structuredClone(tasks)); write(result.tasks); return result.value; });
}

export function claimImageTask(taskId: string, workerId: string, leaseMs: number, options: LocalTaskStoreOptions = {}) {
  const id = assertTaskId(taskId);
  if (!workerId.trim() || leaseMs < 10_000 || leaseMs > 6 * 60 * 60 * 1000) throw new Error("invalid_local_task_claim");
  return mutateImageTasks((tasks) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task && requiresManualInferenceRecovery(task)) throw new Error("image_task_inference_requires_manual_recovery");
    if (!task || task.status !== "waiting_for_gpu" || task.localClaim || task.result) throw new Error("image_task_not_claimable");
    const token = randomBytes(32).toString("base64url"); const claimedAt = now(options); const leaseExpiresAt = new Date(Date.parse(claimedAt) + leaseMs).toISOString();
    task.status = "generating"; task.updatedAt = claimedAt; task.localClaim = { workerId, claimedAt, leaseExpiresAt, claimTokenHash: tokenHash(token) };
    return { tasks, value: { task: structuredClone(task), claimToken: token } };
  }, options);
}

/**
 * Persisted synchronously from the canonical inference boundary before the
 * network POST. The exact live claim is required so an unrelated process
 * cannot attach retry evidence to a task it does not own.
 */
export function markImageTaskInferenceRetryBlocked(
  taskId: string,
  claimToken: string,
  evidence: AmbiguousInferenceEvidence,
  options: LocalTaskStoreOptions = {},
) {
  const id = assertTaskId(taskId);
  const recordedAt = now(options);
  const incoming = normalizeInferenceEvidence(evidence, recordedAt);
  return mutateImageTasks((tasks) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task || !owned(task, claimToken, Date.now())) throw new Error("local_task_claim_not_owned");
    task.inferenceRetryBlock = mergeInferenceRetryBlock(task.inferenceRetryBlock, incoming);
    task.updatedAt = recordedAt;
    return { tasks, value: structuredClone(task) };
  }, options);
}

/**
 * Legacy/crash reconciliation. The caller must first prove that no local
 * worker can still own the task. All evidence is validated before any task is
 * changed, then the task-store lock publishes the complete quarantine at once.
 */
export function reconcileStoppedImageTasksWithAmbiguousInference(
  evidence: Array<{ taskId: string } & AmbiguousInferenceEvidence>,
  options: LocalTaskStoreOptions = {},
) {
  if (!evidence.length || new Set(evidence.map((item) => assertTaskId(item.taskId))).size !== evidence.length) {
    throw new Error("invalid_ambiguous_inference_task_set");
  }
  const recordedAt = now(options);
  const normalized = evidence.map((item) => ({
    taskId: assertTaskId(item.taskId),
    block: normalizeInferenceEvidence(item, recordedAt),
  }));
  return mutateImageTasks((tasks) => {
    const prepared = normalized.map(({ taskId, block }) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`ambiguous_inference_task_missing:${taskId}`);
      if (task.status === "completed" || task.result || task.finalizedClaimTokenHash) {
        throw new Error(`ambiguous_inference_task_has_finalized_artifact:${taskId}`);
      }
      // Receipt recovery has no claim token and therefore must never revoke a
      // task claim on behalf of a possibly live worker. The caller may retry
      // reconciliation only after the normal claim owner/expiry path clears it.
      if (task.localClaim) throw new Error(`ambiguous_inference_task_still_claimed:${taskId}`);
      return { task, block: mergeInferenceRetryBlock(task.inferenceRetryBlock, block) };
    });
    for (const { task, block } of prepared) {
      task.inferenceRetryBlock = block;
      task.status = "failed";
      task.updatedAt = recordedAt;
      task.error = ambiguousFailure(recordedAt);
    }
    return { tasks, value: prepared.map(({ task }) => structuredClone(task)) };
  }, options);
}

export function renewImageTaskLease(taskId: string, claimToken: string, leaseMs: number, options: LocalTaskStoreOptions = {}) {
  const id = assertTaskId(taskId);
  if (leaseMs < 10_000 || leaseMs > 6 * 60 * 60 * 1000) throw new Error("invalid_local_task_lease");
  return mutateImageTasks((tasks) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task || !owned(task, claimToken, Date.now())) throw new Error("local_task_claim_not_owned");
    task.localClaim!.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString(); task.updatedAt = now(options);
    return { tasks, value: structuredClone(task) };
  }, options);
}

export async function finalizeImageTask(taskId: string, claimToken: string, artifact: LocalArtifactReference, options: LocalTaskStoreOptions = {}) {
  const id = assertTaskId(taskId);
  const verified = await verifyPublishedLocalImageArtifact({ taskId: id, artifact, root: options.artifactRoot });
  return mutateImageTasks((tasks) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error("image_task_not_found");
    if (task.status === "completed") {
      const existing = task.result;
      if (task.finalizedClaimTokenHash !== tokenHash(claimToken)) throw new Error("local_task_claim_not_owned");
      if (existing?.pngSha256 === verified.pngSha256 && existing.relativeDir === verified.relativeDir) return { tasks, value: structuredClone(task) };
      throw new Error("local_task_finalization_conflict");
    }
    if (!owned(task, claimToken, Date.now())) throw new Error("local_task_claim_not_owned");
    task.status = "completed"; task.result = verified; task.finalizedClaimTokenHash = tokenHash(claimToken); task.updatedAt = now(options); delete task.localClaim; delete task.error;
    return { tasks, value: structuredClone(task) };
  }, options);
}

/** Recover only a locally finalized task whose existing artifact still verifies byte-for-byte. */
export async function recoverCompletedImageTaskFromVerifiedArtifact(taskId: string, options: LocalTaskStoreOptions = {}) {
  const id = assertTaskId(taskId);
  const current = readImageTask(id, options);
  if (!current || !current.result || !current.finalizedClaimTokenHash) throw new Error("local_task_recovery_requires_finalized_artifact");
  const verified = await verifyPublishedLocalImageArtifact({ taskId: id, artifact: current.result, root: options.artifactRoot });
  return mutateImageTasks((tasks) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task || !task.result || !task.finalizedClaimTokenHash || task.result.pngSha256 !== verified.pngSha256 || task.result.relativeDir !== verified.relativeDir) throw new Error("local_task_recovery_state_changed");
    // This is reconciliation, not a new completion: preserve the original
    // completion/result timestamps while removing only contradictory state.
    if (task.status !== "completed") { task.status = "completed"; delete task.localClaim; delete task.error; }
    return { tasks, value: structuredClone(task) };
  }, options);
}

export function failImageTask(taskId: string, claimToken: string, error: string, options: LocalTaskStoreOptions = {}) {
  const id = assertTaskId(taskId);
  return mutateImageTasks((tasks) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task || !owned(task, claimToken, Date.now())) throw new Error("local_task_claim_not_owned");
    const failedAt = now(options);
    task.status = "failed";
    task.updatedAt = failedAt;
    task.error = requiresManualInferenceRecovery(task)
      ? ambiguousFailure(failedAt)
      : { message: String(error).slice(0, 2000), at: failedAt, retryable: true };
    delete task.localClaim;
    return { tasks, value: structuredClone(task) };
  }, options);
}

export function releaseOrRecoverExpiredClaim(taskId: string, options: LocalTaskStoreOptions = {}) {
  const id = assertTaskId(taskId);
  return mutateImageTasks((tasks) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error("image_task_not_found");
    if (!task.localClaim || task.status !== "generating") return { tasks, value: structuredClone(task) };
    if (Date.parse(task.localClaim.leaseExpiresAt) > Date.now()) throw new Error("local_task_claim_still_active");
    const recoveredAt = now(options);
    task.status = requiresManualInferenceRecovery(task) ? "failed" : "waiting_for_gpu";
    task.updatedAt = recoveredAt;
    task.error = requiresManualInferenceRecovery(task)
      ? ambiguousFailure(recoveredAt)
      : { message: "local_claim_expired_recovered", at: recoveredAt, retryable: true };
    delete task.localClaim;
    return { tasks, value: structuredClone(task) };
  }, options);
}
