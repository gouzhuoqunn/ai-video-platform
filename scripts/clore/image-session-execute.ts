import { runLiveImageSession } from "./image-session-live";

function value(flag: string) { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; }
const taskIds = (value("--task-ids") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const execute = process.argv.includes("--execute");
const commit = value("--immutable-commit"); const agentSha256 = value("--agent-sha256"); const controllerSha256 = value("--controller-sha256"); const workflowSha256 = value("--workflow-sha256");
if (execute && (!commit || !agentSha256 || !controllerSha256 || !workflowSha256)) throw new Error("immutable_commit_and_runtime_hashes_required");
void runLiveImageSession({ taskIds, execute, immutable: { commit: commit ?? "", agentSha256: agentSha256 ?? "", controllerSha256: controllerSha256 ?? "", workflowSha256: workflowSha256 ?? "" } }).then((value) => console.log(JSON.stringify(value, null, 2))).catch((error) => { console.error(error instanceof Error ? error.message : "image_session_failed"); process.exitCode = 1; });
