import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { type LocalArtifactReference, verifyPublishedLocalImageArtifact } from "./local-image-artifacts";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_WAIT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export type LocalImageTask = Record<string, unknown> & {
  id: string;
  status: "pending_confirmation" | "waiting_for_gpu" | "generating" | "completed" | "failed";
  updatedAt: string;
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
};

export type LocalTaskStoreOptions = { taskPath?: string; artifactRoot?: string; lockWaitMs?: number; staleLockMs?: number; now?: () => Date };

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
    if (!task || task.status !== "waiting_for_gpu" || task.localClaim || task.result) throw new Error("image_task_not_claimable");
    const token = randomBytes(32).toString("base64url"); const claimedAt = now(options); const leaseExpiresAt = new Date(Date.parse(claimedAt) + leaseMs).toISOString();
    task.status = "generating"; task.updatedAt = claimedAt; task.localClaim = { workerId, claimedAt, leaseExpiresAt, claimTokenHash: tokenHash(token) };
    return { tasks, value: { task: structuredClone(task), claimToken: token } };
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
    if (task.status !== "completed") { task.status = "completed"; task.updatedAt = now(options); delete task.localClaim; delete task.error; }
    return { tasks, value: structuredClone(task) };
  }, options);
}

export function failImageTask(taskId: string, claimToken: string, error: string, options: LocalTaskStoreOptions = {}) {
  const id = assertTaskId(taskId);
  return mutateImageTasks((tasks) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task || !owned(task, claimToken, Date.now())) throw new Error("local_task_claim_not_owned");
    task.status = "failed"; task.updatedAt = now(options); task.error = { message: String(error).slice(0, 2000), at: now(options), retryable: true }; delete task.localClaim;
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
    task.status = "waiting_for_gpu"; task.updatedAt = now(options); task.error = { message: "local_claim_expired_recovered", at: now(options), retryable: true }; delete task.localClaim;
    return { tasks, value: structuredClone(task) };
  }, options);
}
