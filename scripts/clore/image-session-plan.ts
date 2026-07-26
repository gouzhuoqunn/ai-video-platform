import { listImageTasks } from "../../src/lib/image-generation/local-image-task-store";
import { formatImageSessionCostPlanChinese, planImageSession } from "./image-session";

const plan = planImageSession(listImageTasks(), { activeOrderCount: 0 });
console.log(formatImageSessionCostPlanChinese(plan));
console.log(JSON.stringify({ dryRun: true, providerMutationCount: 0, selectedTaskIds: plan.selectedTaskIds, projectedProviderCostCeilingUsd: plan.projectedProviderCostCeilingUsd }));
