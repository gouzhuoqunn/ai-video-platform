/** Local-only coordinator primitives for the restricted Clore image run.
 * Provider mutation remains deliberately absent until the full preflight path
 * invokes these exact-task primitives after runtime/model success.
 */
import { claimImageTask, finalizeImageTask, readImageTask, renewImageTaskLease, type LocalImageTask, type LocalTaskStoreOptions } from "../../src/lib/image-generation/local-image-task-store";
import { publishLocalImageArtifact, type LocalArtifactReference } from "../../src/lib/image-generation/local-image-artifacts";
import { sanitizeImageModelPreflight, verifyFiveImageModelSources } from "./image-model-preflight";

export type EligibleImageTask = LocalImageTask & { prompt: string; mode: "text_generation"; referenceImage: null; width: number; height: number; steps: number; cfg: number; loraStrength: number; seed: number; sampler: "Euler" | "FlowMatch" };

export function resolveExactEligibleImageTask(taskId: string, options: LocalTaskStoreOptions = {}): EligibleImageTask {
  const task = readImageTask(taskId, options);
  if (!task || task.status !== "waiting_for_gpu" || task.mode !== "text_generation" || task.referenceImage || !Number.isInteger(task.width) || !Number.isInteger(task.height) || task.width > 1280 || task.height > 1280) {
    throw new Error("image_task_not_eligible_for_restricted_4090_run");
  }
  return task as EligibleImageTask;
}

/** Pre-rental only: it deliberately does not claim a task or call Clore. */
export async function preflightExactLocalImageTask(taskId: string, options: LocalTaskStoreOptions = {}, verifyModels = verifyFiveImageModelSources) {
  const task = resolveExactEligibleImageTask(taskId, options);
  const modelPreflight = await verifyModels();
  const reread = readImageTask(taskId, options);
  if (!reread || reread.status !== "waiting_for_gpu") throw new Error("image_task_changed_during_prerental_preflight");
  return { task, modelPreflight: sanitizeImageModelPreflight(modelPreflight), createsOrder: false, claimsTask: false };
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

async function main() {
  const taskId = argument("--task-id");
  if (!taskId) throw new Error("--task-id is required; the coordinator never selects another task");
  const preflight = await preflightExactLocalImageTask(taskId);
  console.log(JSON.stringify({ ready_for_remote_preflight: true, creates_order: false, claims_task: false, task: { id: preflight.task.id, status: preflight.task.status, width: preflight.task.width, height: preflight.task.height }, model_preflight: preflight.modelPreflight, next: "immutable_agent_and_provider_cost_preflight" }, null, 2));
}

if (process.argv[1]?.endsWith("run-image-e2e.ts")) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : "image_e2e_failed"); process.exitCode = 1; });
}
