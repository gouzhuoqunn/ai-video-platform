/** Local-only coordinator primitives for the restricted Clore image run.
 * Provider mutation remains deliberately absent until the full preflight path
 * invokes these exact-task primitives after runtime/model success.
 */
import { claimImageTask, finalizeImageTask, readImageTask, renewImageTaskLease, type LocalImageTask, type LocalTaskStoreOptions } from "../../src/lib/image-generation/local-image-task-store";
import { publishLocalImageArtifact, type LocalArtifactReference } from "../../src/lib/image-generation/local-image-artifacts";

export type EligibleImageTask = LocalImageTask & { prompt: string; mode: "text_generation"; referenceImage: null; width: number; height: number; steps: number; cfg: number; loraStrength: number; seed: number; sampler: "Euler" | "FlowMatch" };

export function resolveExactEligibleImageTask(taskId: string, options: LocalTaskStoreOptions = {}): EligibleImageTask {
  const task = readImageTask(taskId, options);
  if (!task || task.status !== "waiting_for_gpu" || task.mode !== "text_generation" || task.referenceImage || !Number.isInteger(task.width) || !Number.isInteger(task.height) || task.width > 1280 || task.height > 1280) {
    throw new Error("image_task_not_eligible_for_restricted_4090_run");
  }
  return task as EligibleImageTask;
}

export function startImageTaskLeaseHeartbeat(input: { taskId: string; claimToken: string; leaseMs: number; options?: LocalTaskStoreOptions }) {
  const intervalMs = Math.max(5_000, Math.floor(input.leaseMs / 3));
  let stopped = false; let lastError: Error | null = null;
  const timer = setInterval(() => {
    if (stopped) return;
    try { renewImageTaskLease(input.taskId, input.claimToken, input.leaseMs, input.options); }
    catch (error) { lastError = error instanceof Error ? error : new Error("local_task_lease_renewal_failed"); }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); }, assertHealthy: () => { if (lastError) throw lastError; } };
}

export async function persistAndFinalizeExactLocalTask(input: {
  task: EligibleImageTask;
  claimToken: string;
  png: Buffer;
  remote: { generationDurationSeconds: number; orderId: string; gpuModel: string; controllerPromptId: string | null };
  options?: LocalTaskStoreOptions;
  maxFinalizeAttempts?: number;
}): Promise<{ artifact: LocalArtifactReference; completed: LocalImageTask }> {
  const artifact = await publishLocalImageArtifact({ task: input.task, png: input.png, remote: input.remote, root: input.options?.artifactRoot });
  const attempts = input.maxFinalizeAttempts ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const completed = await finalizeImageTask(input.task.id, input.claimToken, artifact, input.options);
      return { artifact, completed };
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error("image_task_finalization_failed");
}

function argument(name: string) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }

function main() {
  const taskId = argument("--task-id");
  if (!taskId) throw new Error("--task-id is required; the coordinator never selects another task");
  const task = resolveExactEligibleImageTask(taskId);
  // This is a zero-provider-mutation plan mode. A later authenticated runner
  // calls claimImageTask only after health, runtime, and model preflight pass.
  console.log(JSON.stringify({ ready_for_remote_preflight: true, creates_order: false, task: { id: task.id, status: task.status, width: task.width, height: task.height }, next: "verify_public_agent_and_model_manifest" }, null, 2));
}

if (process.argv[1]?.endsWith("run-image-e2e.ts")) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "image_e2e_failed"); process.exitCode = 1; }
}
