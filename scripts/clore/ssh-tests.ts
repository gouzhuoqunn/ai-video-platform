import { buildWorkerDeploymentPlan, assertUploadAllowed } from "./deploy-worker";
import {
  buildSshArgs,
  classifySshReadinessFailure,
  CLORE_KNOWN_HOSTS_PATH,
  shouldStopSshReadinessEarly,
  SSH_EARLY_RESET_FAILURES,
  SSH_READINESS_TIMEOUT_MS,
} from "./ssh-client";

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
  assert(SSH_READINESS_TIMEOUT_MS === 8 * 60 * 1000, "SSH readiness must be capped at 8 minutes.");
  assert(classifySshReadinessFailure("kex_exchange_identification: read: Connection reset") === "connection_reset", "connection reset must count as SSH failure.");
  assert(classifySshReadinessFailure("Connection timed out during banner exchange") === "banner_timeout", "banner timeout must count as SSH failure.");
  assert(
    shouldStopSshReadinessEarly(Array.from({ length: SSH_EARLY_RESET_FAILURES }, () => "connection_reset")),
    "consecutive obvious resets may stop readiness early.",
  );
  assert(!shouldStopSshReadinessEarly(["connection_reset", "banner_timeout", "connection_reset"]), "mixed short failures should keep retrying within the cap.");

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
