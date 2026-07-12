import { buildFirstGpuSessionPlan } from "./first-gpu-session";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main() {
  const plan = buildFirstGpuSessionPlan({ host: "203.0.113.10", port: 2222, user: "root" });
  assert(plan.dry_run, "first GPU session test must be dry-run.");
  assert(!plan.real_ssh_connected, "test must not connect SSH.");
  assert(!plan.real_model_downloaded, "test must not download Wan2.2.");
  assert(plan.max_auto_jobs_before_pause === 1, "first session must pause after one synthetic job.");
  assert(plan.steps.some((step) => step.includes("official Hugging Face")), "model source must be official Hugging Face.");
  assert(plan.mock_model_manifest_valid, "mock manifest should be valid.");
  assert(plan.deployment.forbidden_uploads.includes(".secrets/clore.env"), "deployment must not upload Clore API key.");
  console.log("First GPU session tests passed.");
}

void main();
