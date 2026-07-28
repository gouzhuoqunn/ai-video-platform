import { spawnSync } from "node:child_process";

const command = process.platform === "win32" ? "py" : "python3";
const args = process.platform === "win32"
  ? ["-3", "comfy-runtime/image-workflow-tests.py"]
  : ["comfy-runtime/image-workflow-tests.py"];
const result = spawnSync(command, args, {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
  killSignal: "SIGTERM",
});
if (result.error?.code === "ETIMEDOUT" || result.signal) {
  throw new Error("image_workflow_contract_child_timeout");
}
if (result.status !== 0) {
  throw new Error(`image_workflow_contract_failed:${String(result.stderr || result.stdout).slice(-1_000)}`);
}
console.log(String(result.stdout).trim());
console.log(JSON.stringify({ imageWorkflowContractPassed: true, providerMutationCount: 0 }));
