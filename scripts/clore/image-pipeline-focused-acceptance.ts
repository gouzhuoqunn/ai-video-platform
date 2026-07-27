import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const testFiles = [
  "scripts/clore/marketplace-ingestion-tests.ts",
  "scripts/clore/live-market-selection-tests.ts",
  "scripts/clore/deployment-host-blacklist-tests.ts",
  "scripts/clore/image-candidate-race-tests.ts",
  "scripts/clore/resilient-create-tests.ts",
  "scripts/clore/request-scheduler-tests.ts",
  "scripts/rtx4090-golden-deployment-profile-tests.ts",
  "scripts/clore/diagnostic-agent-tests.ts",
  "scripts/clore/pinned-agent-http-contract-tests.ts",
  "scripts/clore/agent-stage-acceptance-contract-tests.ts",
  "scripts/clore/agent-get-transport-tests.ts",
  "scripts/clore/image-model-preflight-tests.ts",
  "scripts/clore/image-model-agent-manifest-tests.ts",
  "scripts/image-executor/immutable-source-resolver-tests.ts",
  "scripts/clore/image-5090-executor-tests.ts",
  "scripts/clore/run-image-e2e-tests.ts",
  "scripts/clore/image-e2e-coordinator-tests.ts",
  "scripts/clore/image-session-tests.ts",
  "scripts/image-session-canonical-task-order-tests.ts",
  "scripts/clore/image-session-terminalization-tests.ts",
  "scripts/clore/image-live-safety-tests.ts",
  "scripts/clore/image-e2e-ui-tests.ts",
  "scripts/clore/local-image-artifact-route-tests.ts",
  "scripts/image-create-order-race-tests.ts",
  "scripts/image-order-state-reconcile-tests.ts",
  "scripts/image-runner-status-projection-tests.ts",
  "scripts/image-task-unconfirmation-tests.ts",
  "scripts/image-executor-focused-tests.ts",
  "scripts/clore/watchdog-tests.ts",
] as const;

type TestFile = (typeof testFiles)[number];
type CheckDefinition = { name: string; files: readonly TestFile[] };

const requiredChecks: CheckDefinition[] = [
  { name: "marketplace_ingestion_classifications", files: ["scripts/clore/marketplace-ingestion-tests.ts"] },
  { name: "valid_nonempty_and_valid_empty_responses", files: ["scripts/clore/marketplace-ingestion-tests.ts"] },
  { name: "rate_limit_and_transport_never_empty_success", files: ["scripts/clore/marketplace-ingestion-tests.ts"] },
  { name: "live_cheapest_candidate_ranking", files: ["scripts/clore/live-market-selection-tests.ts", "scripts/clore/deployment-host-blacklist-tests.ts"] },
  { name: "code6_forced_fresh_market_rescan", files: ["scripts/clore/image-candidate-race-tests.ts", "scripts/clore/live-market-selection-tests.ts"] },
  { name: "rejected_candidate_never_retried", files: ["scripts/clore/image-candidate-race-tests.ts", "scripts/clore/live-market-selection-tests.ts"] },
  { name: "five_candidate_cap", files: ["scripts/clore/image-candidate-race-tests.ts"] },
  { name: "one_create_request_in_flight", files: ["scripts/clore/image-candidate-race-tests.ts", "scripts/clore/request-scheduler-tests.ts", "scripts/image-create-order-race-tests.ts"] },
  { name: "uncertain_create_reconciliation_before_retry", files: ["scripts/clore/resilient-create-tests.ts", "scripts/clore/request-scheduler-tests.ts", "scripts/clore/run-image-e2e-tests.ts", "scripts/image-create-order-race-tests.ts", "scripts/image-order-state-reconcile-tests.ts"] },
  { name: "golden_rtx4090_deployment_profile", files: ["scripts/rtx4090-golden-deployment-profile-tests.ts", "scripts/clore/deployment-host-blacklist-tests.ts", "scripts/image-executor-focused-tests.ts", "scripts/image-executor/immutable-source-resolver-tests.ts", "scripts/clore/image-5090-executor-tests.ts", "scripts/clore/diagnostic-agent-tests.ts"] },
  { name: "pinned_agent_stage_acceptance_v2", files: ["scripts/clore/diagnostic-agent-tests.ts", "scripts/clore/pinned-agent-http-contract-tests.ts", "scripts/clore/agent-stage-acceptance-contract-tests.ts"] },
  { name: "exact_stage_run_id_correlation", files: ["scripts/clore/pinned-agent-http-contract-tests.ts", "scripts/clore/agent-stage-acceptance-contract-tests.ts", "scripts/clore/agent-get-transport-tests.ts"] },
  { name: "model_source_manifest_validation", files: ["scripts/clore/image-model-preflight-tests.ts", "scripts/clore/image-model-agent-manifest-tests.ts", "scripts/image-executor-focused-tests.ts"] },
  { name: "canonical_single_task_planning", files: ["scripts/clore/image-session-tests.ts", "scripts/image-session-canonical-task-order-tests.ts"] },
  { name: "exactly_one_inference_post", files: ["scripts/clore/image-e2e-coordinator-tests.ts", "scripts/clore/image-session-tests.ts"] },
  { name: "accepted_inference_never_retried", files: ["scripts/clore/image-e2e-coordinator-tests.ts", "scripts/clore/agent-get-transport-tests.ts", "scripts/clore/image-session-terminalization-tests.ts"] },
  { name: "artifact_finalization_cannot_be_downgraded", files: ["scripts/clore/run-image-e2e-tests.ts", "scripts/clore/image-e2e-coordinator-tests.ts", "scripts/clore/image-session-terminalization-tests.ts", "scripts/clore/local-image-artifact-route-tests.ts"] },
  { name: "post_finalization_ui_error_cannot_fail_completed_task", files: ["scripts/clore/image-e2e-coordinator-tests.ts", "scripts/clore/image-live-safety-tests.ts", "scripts/clore/image-e2e-ui-tests.ts"] },
  { name: "immediate_owned_order_persistence_after_create", files: ["scripts/clore/image-live-safety-tests.ts", "scripts/image-create-order-race-tests.ts"] },
  { name: "cleanup_requires_two_zero_confirmations", files: ["scripts/clore/image-live-safety-tests.ts", "scripts/clore/image-session-tests.ts"] },
  { name: "watchdog_armed_when_billing_ambiguous", files: ["scripts/clore/image-live-safety-tests.ts", "scripts/clore/watchdog-tests.ts"] },
  { name: "status_polling_zero_provider_mutation", files: ["scripts/clore/image-live-safety-tests.ts", "scripts/clore/image-session-terminalization-tests.ts"] },
  { name: "historical_errors_nonblocking_after_cleanup", files: ["scripts/image-runner-status-projection-tests.ts"] },
  { name: "candidate_and_rented_host_labels_distinct", files: ["scripts/image-runner-status-projection-tests.ts", "scripts/clore/image-live-safety-tests.ts"] },
  { name: "task_unconfirmation_behavior", files: ["scripts/image-task-unconfirmation-tests.ts"] },
];

const isolationRoot = mkdtempSync(path.join(os.tmpdir(), "image-pipeline-focused-acceptance-"));
let providerMutationCount = 0;
let providerMutationEvidenceCount = 0;
const fileResults = new Map<TestFile, { passed: boolean; status: number | null; error: string | null }>();
const focusedTestEnv = { ...process.env, AI_IMAGE_TASK_STORE_PATH: "", CLORE_PROVIDER_MUTATIONS_DISABLED: "true" };
for (const key of ["CLORE_API_KEY", "VAST_API_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) delete focusedTestEnv[key];

try {
  for (const [index, file] of testFiles.entries()) {
    console.info(`focused-acceptance-file: ${file}`);
    const isolatedState = path.join(isolationRoot, String(index));
    mkdirSync(isolatedState, { recursive: true });
    const isolatedTaskStore = path.join(isolatedState, "tasks.json");
    writeFileSync(isolatedTaskStore, "[]\n", "utf8");
    const result = spawnSync(process.execPath, ["--import", "tsx", file], {
      cwd: process.cwd(),
      env: { ...focusedTestEnv, AI_IMAGE_TASK_STORE_PATH: isolatedTaskStore },
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const mutationMatches = [...output.matchAll(/(?:providerMutationCount|provider_mutation_count)\s*["']?\s*:\s*(\d+)/gi)];
    providerMutationCount += mutationMatches.reduce((sum, match) => sum + Number(match[1]), 0);
    providerMutationEvidenceCount += mutationMatches.length;
    const error = result.error instanceof Error ? result.error.message : null;
    fileResults.set(file, { passed: result.status === 0 && error === null, status: result.status, error });
  }
} finally {
  rmSync(isolationRoot, { recursive: true, force: true });
}

const checkResults = requiredChecks.map((check) => ({
  name: check.name,
  passed: check.files.every((file) => fileResults.get(file)?.passed === true),
  files: [...check.files],
}));
checkResults.push({
  name: "provider_mutation_count_zero",
  passed: providerMutationEvidenceCount > 0 && providerMutationCount === 0,
  files: [],
});

for (const check of checkResults) {
  console.info(`focused-check: ${check.name} ${check.passed ? "PASS" : "FAIL"}`);
}

const failedFiles = [...fileResults.entries()]
  .filter(([, result]) => !result.passed)
  .map(([file, result]) => ({ file, status: result.status, error: result.error }));
const passed = checkResults.filter((check) => check.passed).length;
const failed = checkResults.length - passed;
const total = checkResults.length;
const ok = failedFiles.length === 0 && failed === 0 && total === 26;
console.info(`focused-summary: passed=${passed} failed=${failed} total=${total}`);
console.log(JSON.stringify({
  ok,
  passed,
  failed,
  total,
  testFilesPassed: testFiles.length - failedFiles.length,
  testFilesFailed: failedFiles.length,
  providerMutationCount,
  providerMutationEvidenceCount,
  checks: checkResults.map(({ name, passed: checkPassed }) => ({ name, result: checkPassed ? "pass" : "fail" })),
  failedFiles,
}));
if (!ok) process.exitCode = 1;
