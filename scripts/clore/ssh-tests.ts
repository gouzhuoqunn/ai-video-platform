import { buildWorkerDeploymentPlan, assertUploadAllowed } from "./deploy-worker";
import { buildSshArgs, CLORE_KNOWN_HOSTS_PATH } from "./ssh-client";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main() {
  const target = { host: "203.0.113.10", port: 2222, user: "root" };
  const args = buildSshArgs(target, "echo safe", { requirePrivateKey: false });
  assert(args.includes("PasswordAuthentication=no"), "SSH must disable password login.");
  assert(args.includes("StrictHostKeyChecking=accept-new"), "SSH must handle host keys without disabling checks.");
  assert(args.some((arg) => arg.includes(CLORE_KNOWN_HOSTS_PATH)), "SSH must use project known_hosts file.");
  assert(!args.join(" ").includes("StrictHostKeyChecking=no"), "SSH must not disable host key checking.");

  const plan = buildWorkerDeploymentPlan(target);
  assert(plan.allowed_uploads.includes(".secrets/gpu-worker.env"), "limited worker env should be in upload whitelist.");
  assert(plan.forbidden_uploads.includes(".env.local"), ".env.local must be forbidden.");
  assert(plan.forbidden_uploads.includes(".secrets/clore.env"), "clore.env must be forbidden.");

  assertUploadAllowed("gpu-worker/worker.py");
  try {
    assertUploadAllowed(".env.local");
    throw new Error("uploading .env.local should fail.");
  } catch (error) {
    assert(String(error).includes("Refusing"), "non-whitelisted upload should be refused.");
  }

  console.log("Clore SSH tests passed.");
}

void main();
