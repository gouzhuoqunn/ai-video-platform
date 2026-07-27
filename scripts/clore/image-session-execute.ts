import { listImageTasks } from "../../src/lib/image-generation/local-image-task-store";
import { planImageSession } from "./image-session";

function value(flag: string) { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; }
const taskIds = (value("--task-ids") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const execute = process.argv.includes("--execute");
if (execute) throw new Error("direct_image_session_execute_disabled_use_image_session_supervisor");
const plan = planImageSession(listImageTasks(), {
  requestedTaskIds: taskIds.length ? taskIds : undefined,
  maxBatchSize: taskIds.length || undefined,
  activeOrderCount: 0,
});
console.log(JSON.stringify({
  dryRun: true,
  providerMutationCount: 0,
  selectedTaskIds: plan.selectedTaskIds,
  executionEligible: plan.executionEligible,
  paidCommand: "npm run image:session:supervisor:start -- --execute ...",
}, null, 2));
