import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_FILE_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 10_000;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

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
  "scripts/clore/image-workflow-contract-tests.ts",
  "scripts/image-lora-registry-tests.ts",
  "scripts/image-executor/immutable-source-resolver-tests.ts",
  "scripts/clore/image-5090-executor-tests.ts",
  "scripts/clore/run-image-e2e-tests.ts",
  "scripts/clore/image-e2e-coordinator-tests.ts",
  "scripts/clore/image-session-tests.ts",
  "scripts/image-session-canonical-task-order-tests.ts",
  "scripts/clore/image-session-terminalization-tests.ts",
  "scripts/clore/local-image-task-store-tests.ts",
  "scripts/clore/image-live-safety-tests.ts",
  "scripts/clore/image-e2e-ui-tests.ts",
  "scripts/clore/local-image-artifact-route-tests.ts",
  "scripts/image-create-order-race-tests.ts",
  "scripts/image-order-state-reconcile-tests.ts",
  "scripts/image-runner-status-projection-tests.ts",
  "scripts/image-task-unconfirmation-tests.ts",
  "scripts/image-result-groups-tests.ts",
  "scripts/image-executor-focused-tests.ts",
  "scripts/clore/watchdog-tests.ts",
] as const;

type TestFile = (typeof testFiles)[number];
type CheckDefinition = { name: string; files: readonly TestFile[] };
type TestFileResult = {
  passed: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
  timedOut: boolean;
};

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
  { name: "multi_lora_negative_workflow_contract", files: ["scripts/clore/image-workflow-contract-tests.ts", "scripts/image-lora-registry-tests.ts"] },
  { name: "canonical_single_task_planning", files: ["scripts/clore/image-session-tests.ts", "scripts/image-session-canonical-task-order-tests.ts"] },
  { name: "exactly_one_inference_post", files: ["scripts/clore/image-e2e-coordinator-tests.ts", "scripts/clore/image-session-tests.ts"] },
  { name: "accepted_inference_never_retried", files: ["scripts/clore/image-e2e-coordinator-tests.ts", "scripts/clore/agent-get-transport-tests.ts", "scripts/clore/image-session-terminalization-tests.ts", "scripts/clore/local-image-task-store-tests.ts", "scripts/image-result-groups-tests.ts"] },
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
const fileResults = new Map<TestFile, TestFileResult>();
const focusedTestEnv = { ...process.env, AI_IMAGE_TASK_STORE_PATH: "", CLORE_PROVIDER_MUTATIONS_DISABLED: "true" };
for (const key of ["CLORE_API_KEY", "VAST_API_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) delete focusedTestEnv[key];

function terminateProcessTree(pid: number) {
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: TERMINATION_GRACE_MS,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The child already exited between the timeout and cleanup.
    }
  }
}

async function runTestFile(file: TestFile, isolatedTaskStore: string): Promise<{ result: TestFileResult; output: string }> {
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", file], {
      cwd: process.cwd(),
      env: { ...focusedTestEnv, AI_IMAGE_TASK_STORE_PATH: isolatedTaskStore },
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const captured: Buffer[] = [];
    let capturedBytes = 0;
    let spawnError: string | null = null;
    let failure: string | null = null;
    let timedOut = false;
    let settled = false;
    let terminationTimer: NodeJS.Timeout | null = null;

    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const error = failure ?? spawnError;
      resolve({
        result: {
          passed: status === 0 && error === null,
          status,
          error,
          durationMs: Date.now() - startedAt,
          timedOut,
        },
        output: Buffer.concat(captured).toString("utf8"),
      });
    };

    const terminate = (reason: string, isTimeout: boolean) => {
      if (settled || failure !== null) return;
      failure = reason;
      timedOut = isTimeout;
      if (child.pid) terminateProcessTree(child.pid);
      else child.kill("SIGKILL");
      terminationTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(null);
      }, TERMINATION_GRACE_MS);
      terminationTimer.unref();
    };

    const capture = (stream: NodeJS.WriteStream, chunk: Buffer) => {
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      if (remaining > 0) {
        const bounded = chunk.subarray(0, remaining);
        captured.push(bounded);
        capturedBytes += bounded.byteLength;
        stream.write(bounded);
      }
      if (chunk.byteLength > remaining) {
        terminate(`output exceeded ${MAX_CAPTURE_BYTES} bytes`, false);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => capture(process.stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(process.stderr, chunk));
    child.once("error", (error) => {
      spawnError = error.message;
    });
    child.once("close", (status) => finish(status));

    const timeoutTimer = setTimeout(() => {
      terminate(`timed out after ${TEST_FILE_TIMEOUT_MS} ms`, true);
    }, TEST_FILE_TIMEOUT_MS);
  });
}

async function main() {
  try {
    for (const check of requiredChecks) {
      console.info(`focused-check: ${check.name} START`);
    }
    for (const [index, file] of testFiles.entries()) {
      console.info(`focused-acceptance-file: ${file} START timeout_ms=${TEST_FILE_TIMEOUT_MS}`);
      const isolatedState = path.join(isolationRoot, String(index));
      mkdirSync(isolatedState, { recursive: true });
      const isolatedTaskStore = path.join(isolatedState, "tasks.json");
      writeFileSync(isolatedTaskStore, "[]\n", "utf8");
      const { result, output } = await runTestFile(file, isolatedTaskStore);
      const mutationMatches = [...output.matchAll(/(?:providerMutationCount|provider_mutation_count)\s*["']?\s*:\s*(\d+)/gi)];
      providerMutationCount += mutationMatches.reduce((sum, match) => sum + Number(match[1]), 0);
      providerMutationEvidenceCount += mutationMatches.length;
      fileResults.set(file, result);
      console.info(
        `focused-acceptance-file: ${file} ${result.passed ? "PASS" : "FAIL"} duration_ms=${result.durationMs}`
        + (result.timedOut ? " classification=timeout" : ""),
      );
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
    .map(([file, result]) => ({
      file,
      status: result.status,
      error: result.error,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    }));
  const passed = checkResults.filter((check) => check.passed).length;
  const failed = checkResults.length - passed;
  const total = checkResults.length;
  const ok = failedFiles.length === 0 && failed === 0;
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
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
