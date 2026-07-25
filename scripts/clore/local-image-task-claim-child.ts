import { claimImageTask } from "../../src/lib/image-generation/local-image-task-store";

const [taskPath, taskId, workerId] = process.argv.slice(2);
try {
  const claim = claimImageTask(taskId ?? "", workerId ?? "", 60_000, { taskPath });
  console.log(JSON.stringify({ ok: true, workerId, taskId: claim.task.id }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "claim_failed" }));
  process.exitCode = 1;
}
