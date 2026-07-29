import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CREATE_RATE_LIMIT_CLASSIFICATION,
  CURRENT_CREATE_RATE_LIMIT_MESSAGE,
  CURRENT_MODEL_DOWNLOAD_MESSAGE,
  HISTORICAL_AGENT_STAGE_MESSAGE,
  HISTORICAL_CREATE_RATE_LIMIT_MESSAGE,
  HISTORICAL_MODEL_DOWNLOAD_MESSAGE,
  HISTORICAL_RENTED_CANDIDATE_MESSAGE,
  HISTORICAL_RUNNER_GENERIC_MESSAGE,
  MODEL_DOWNLOAD_FAILURE_CLASSIFICATION,
  PRIOR_SESSION_AUTO_RECOVERY_MESSAGE,
  PRIOR_SESSION_MANUAL_RECOVERY_CLASSIFICATION,
  PRIOR_SESSION_MANUAL_RECOVERY_MESSAGE,
  PRIOR_SESSION_RECOVERY_CLASSIFICATION,
  projectRunnerStatus,
} from "../src/lib/image-generation/runner-status-projection";

const historicalCode6 = { state: "failed", pid: 27900, host: { orderId: null }, blocker: "Clore API failed", error: { stage: "preflight", at: "2026-07-26T18:26:08.488Z", message: "Clore API failed: {\"httpStatus\":200,\"code\":6,\"error\":\"server-already-rented\",\"classification\":\"unknown_code6\"}" } };
const rawCreateRateLimit = {
  state: "running",
  pid: 30124,
  host: { orderId: null },
  blocker: "create_order_rate_limit_persisted: {\"http_status\":429,\"clore_code\":5,\"attempt\":2}",
  error: {
    stage: "create_order_failed",
    at: "2026-07-28T17:44:31.000Z",
    operation: "clore.create_order",
    classification: "rate_limited",
    message: "create_order_rate_limit_persisted: {\"httpStatus\":429,\"code\":5,\"error\":\"rate_limited\"}",
  },
};
const RAW_RATE_LIMIT_TOKENS = /create_order_rate_limit_persisted|httpStatus|http_status|clore_code|["']code["']\s*:|\b429\b|slow down/;

function main() {
  const historical = projectRunnerStatus(historicalCode6, { pidAlive: false, activeOrder: false, createLock: false });
  assert.equal(historical.error?.displayMessage, HISTORICAL_RENTED_CANDIDATE_MESSAGE);
  assert.equal(historical.error?.isBlocking, false);
  assert.equal(historical.error?.historical, true);
  assert.doesNotMatch(JSON.stringify(historical), /unknown_code6|httpStatus|server-already-rented/);
  assert.equal(historical.blocker, null);
  const classificationOnly = projectRunnerStatus({ ...historicalCode6, error: { ...historicalCode6.error, message: "provider failure", classification: "unknown_code6" } }, { pidAlive: false, activeOrder: false, createLock: false });
  assert.equal(classificationOnly.error?.displayMessage, HISTORICAL_RENTED_CANDIDATE_MESSAGE);
  assert.equal(classificationOnly.error?.isBlocking, false);

  const unknown = projectRunnerStatus({ ...historicalCode6, error: { ...historicalCode6.error, message: "Clore API failed: {\"code\":9,\"error\":\"other\"}" } }, { pidAlive: false, activeOrder: false, createLock: false });
  assert.equal(unknown.error?.displayMessage, HISTORICAL_RUNNER_GENERIC_MESSAGE);
  const marketMessages = new Set<string>();
  for (const classification of ["rate_limited", "authentication_failed", "transport_failed", "invalid_json", "schema_incompatible"]) {
    const market = projectRunnerStatus({ ...historicalCode6, error: { ...historicalCode6.error, message: "<sanitized>", classification } }, { pidAlive: false, activeOrder: false, createLock: false });
    assert.equal(market.error?.classification, classification);
    assert.equal(market.error?.isBlocking, false);
    assert.doesNotMatch(market.error?.displayMessage ?? "", /unknown_code6|\{.*\}|https?:\/\//);
    marketMessages.add(market.error?.displayMessage ?? "");
  }
  assert.equal(marketMessages.size, 5, "market failure projections must remain distinct");

  const historicalAgent = projectRunnerStatus({ ...historicalCode6, host: { orderId: "1983946" }, error: { ...historicalCode6.error, message: "agent_stage_acceptance_invalid:environment" } }, { pidAlive: false, activeOrder: false, createLock: false });
  assert.equal(historicalAgent.error?.displayMessage, HISTORICAL_AGENT_STAGE_MESSAGE);
  assert.equal(historicalAgent.error?.historical, true);
  assert.equal(historicalAgent.error?.isBlocking, false);
  assert.equal(JSON.stringify(historicalAgent).includes("agent_stage_acceptance_invalid"), false);

  const rawModelFailure = {
    ...historicalCode6,
    blocker: "model_download_incomplete_after_retries:custom-lora.safetensors",
    error: {
      ...historicalCode6.error,
      stage: "models",
      message: "model_sha256_mismatch:custom-lora.safetensors expected_sha256=secret actual_sha256=other",
    },
  };
  const historicalModelFailure = projectRunnerStatus(
    rawModelFailure,
    { pidAlive: false, activeOrder: false, createLock: false },
  );
  assert.equal(historicalModelFailure.error?.displayMessage, HISTORICAL_MODEL_DOWNLOAD_MESSAGE);
  assert.equal(historicalModelFailure.error?.classification, MODEL_DOWNLOAD_FAILURE_CLASSIFICATION);
  assert.equal(historicalModelFailure.error?.isBlocking, false);
  assert.equal(historicalModelFailure.blocker, null);
  assert.doesNotMatch(JSON.stringify(historicalModelFailure), /custom-lora|expected_sha256|actual_sha256/);

  const currentModelFailure = projectRunnerStatus(
    { ...rawModelFailure, state: "running" },
    { pidAlive: true, activeOrder: true, createLock: false },
  );
  assert.equal(currentModelFailure.error?.displayMessage, CURRENT_MODEL_DOWNLOAD_MESSAGE);
  assert.equal(currentModelFailure.error?.classification, MODEL_DOWNLOAD_FAILURE_CLASSIFICATION);
  assert.equal(currentModelFailure.error?.isBlocking, true);
  assert.equal(currentModelFailure.blocker, CURRENT_MODEL_DOWNLOAD_MESSAGE);
  assert.doesNotMatch(JSON.stringify(currentModelFailure), /custom-lora|expected_sha256|actual_sha256/);

  const active = projectRunnerStatus({ ...historicalCode6, state: "running" }, { pidAlive: true, activeOrder: false, createLock: false });
  assert.equal(active.error?.isBlocking, true);
  assert.equal(active.error?.historical, false);
  assert.doesNotMatch(JSON.stringify(active), /unknown_code6|httpStatus|server-already-rented/);
  const activeClassification = projectRunnerStatus({ ...historicalCode6, state: "running", error: { ...historicalCode6.error, message: "provider failure", classification: "server-already-rented" } }, { pidAlive: true, activeOrder: false, createLock: false });
  assert.equal(activeClassification.error?.classification, "candidate_already_rented");
  assert.doesNotMatch(JSON.stringify(activeClassification), /unknown_code6|server-already-rented/);

  const currentCreateRateLimit = projectRunnerStatus(rawCreateRateLimit, { pidAlive: true, activeOrder: false, createLock: false });
  assert.equal(currentCreateRateLimit.error?.displayMessage, CURRENT_CREATE_RATE_LIMIT_MESSAGE);
  assert.equal(currentCreateRateLimit.error?.classification, CREATE_RATE_LIMIT_CLASSIFICATION);
  assert.equal(currentCreateRateLimit.error?.isBlocking, true);
  assert.equal(currentCreateRateLimit.error?.historical, false);
  assert.equal(currentCreateRateLimit.blocker, CURRENT_CREATE_RATE_LIMIT_MESSAGE);
  assert.doesNotMatch(JSON.stringify(currentCreateRateLimit), RAW_RATE_LIMIT_TOKENS);

  const historicalCreateRateLimit = projectRunnerStatus(
    { ...rawCreateRateLimit, state: "failed" },
    { pidAlive: false, activeOrder: false, createLock: false },
  );
  assert.equal(historicalCreateRateLimit.error?.displayMessage, HISTORICAL_CREATE_RATE_LIMIT_MESSAGE);
  assert.equal(historicalCreateRateLimit.error?.classification, CREATE_RATE_LIMIT_CLASSIFICATION);
  assert.equal(historicalCreateRateLimit.error?.isBlocking, false);
  assert.equal(historicalCreateRateLimit.error?.historical, true);
  assert.equal(historicalCreateRateLimit.blocker, null);
  assert.notEqual(historicalCreateRateLimit.error?.displayMessage, currentCreateRateLimit.error?.displayMessage);
  assert.doesNotMatch(JSON.stringify(historicalCreateRateLimit), RAW_RATE_LIMIT_TOKENS);

  const raw429Only = projectRunnerStatus(
    {
      ...rawCreateRateLimit,
      blocker: null,
      error: { ...rawCreateRateLimit.error, classification: undefined, message: "{\"httpStatus\":429,\"code\":5,\"message\":\"slow down\"}" },
    },
    { pidAlive: true, activeOrder: false, createLock: false },
  );
  assert.equal(raw429Only.error?.classification, CREATE_RATE_LIMIT_CLASSIFICATION);
  assert.equal(raw429Only.error?.displayMessage, CURRENT_CREATE_RATE_LIMIT_MESSAGE);
  assert.doesNotMatch(JSON.stringify(raw429Only), RAW_RATE_LIMIT_TOKENS);

  const creatingStageRaw429 = projectRunnerStatus(
    {
      ...rawCreateRateLimit,
      blocker: null,
      error: { ...rawCreateRateLimit.error, stage: "creating_order", classification: undefined, message: "{\"status\":429,\"code\":5}" },
    },
    { pidAlive: true, activeOrder: false, createLock: true },
  );
  assert.equal(creatingStageRaw429.error?.classification, CREATE_RATE_LIMIT_CLASSIFICATION);
  assert.equal(creatingStageRaw429.error?.displayMessage, CURRENT_CREATE_RATE_LIMIT_MESSAGE);
  assert.doesNotMatch(JSON.stringify(creatingStageRaw429), RAW_RATE_LIMIT_TOKENS);

  const blockerOnly = projectRunnerStatus(
    { state: "running", pid: 30124, blocker: rawCreateRateLimit.blocker, error: null },
    { pidAlive: true, activeOrder: false, createLock: true },
  );
  assert.equal(blockerOnly.error, null);
  assert.equal(blockerOnly.blocker, CURRENT_CREATE_RATE_LIMIT_MESSAGE);
  assert.doesNotMatch(JSON.stringify(blockerOnly), RAW_RATE_LIMIT_TOKENS);

  const legacyAmbiguous = projectRunnerStatus(
    {
      state: "failed",
      pid: null,
      host: null,
      blocker: "image_session_worker_start_failed",
      error: {
        stage: "runner_exited",
        at: "2026-07-28T09:09:15.777Z",
        message: "image session supervisor exited\nprior_session_receipt_unsafe",
      },
    },
    { pidAlive: false, activeOrder: false, createLock: false },
  );
  assert.equal(legacyAmbiguous.error?.displayMessage, PRIOR_SESSION_AUTO_RECOVERY_MESSAGE);
  assert.equal(legacyAmbiguous.error?.classification, PRIOR_SESSION_RECOVERY_CLASSIFICATION);
  assert.equal(legacyAmbiguous.error?.isBlocking, false);
  assert.equal(legacyAmbiguous.blocker, null);
  assert.doesNotMatch(JSON.stringify(legacyAmbiguous), /prior_session_receipt_unsafe/);

  const manualRecovery = projectRunnerStatus(
    {
      state: "failed",
      pid: null,
      host: null,
      blocker: "image_session_worker_start_failed",
      error: {
        stage: "runner_exited",
        at: "2026-07-28T09:10:00.000Z",
        message: "supervisor failed: prior_session_manual_recovery_required",
      },
    },
    { pidAlive: false, activeOrder: false, createLock: false },
  );
  assert.equal(manualRecovery.error?.displayMessage, PRIOR_SESSION_MANUAL_RECOVERY_MESSAGE);
  assert.equal(manualRecovery.error?.classification, PRIOR_SESSION_MANUAL_RECOVERY_CLASSIFICATION);
  assert.equal(manualRecovery.error?.isBlocking, true);
  assert.equal(manualRecovery.blocker, PRIOR_SESSION_MANUAL_RECOVERY_MESSAGE);
  assert.doesNotMatch(JSON.stringify(manualRecovery), /prior_session_manual_recovery_required/);
  for (const token of [
    "prior_session_receipt_unreadable",
    "prior_session_local_execution_state_present",
    "prior_session_local_active_order_exists",
    "prior_session_active_order_exists",
    "prior_session_target_task_changed",
    "prior_session_id_invalid",
    "prior_session_archive_conflict",
    "prior_session_archive_verification_failed",
  ]) {
    const projected = projectRunnerStatus(
      { state: "failed", pid: null, host: null, blocker: "image_session_worker_start_failed", error: { stage: "runner_exited", at: "2026-07-28T09:10:00.000Z", message: `supervisor failed: ${token}` } },
      { pidAlive: false, activeOrder: false, createLock: false },
    );
    assert.equal(projected.error?.displayMessage, PRIOR_SESSION_MANUAL_RECOVERY_MESSAGE);
    assert.equal(projected.error?.isBlocking, true);
    assert.equal(projected.blocker, PRIOR_SESSION_MANUAL_RECOVERY_MESSAGE);
    assert.doesNotMatch(JSON.stringify(projected), new RegExp(token));
  }

  const route = readFileSync("src/app/api/local-lab/image-tasks/route.ts", "utf8");
  assert.match(route, /host: display\.error\?\.historical \? null : runner\.host/);
  assert.match(route, /progress: blocker[\s\S]*?isBlocking: true/);
  const studio = readFileSync("src/components/ImageCreationStudio.tsx", "utf8");
  assert.match(studio, /candidateRole/);
  assert.match(studio, /candidateRole === "rented_host"/);
  assert.match(studio, /当前候选显卡/);
  assert.match(studio, /已租用主机/);
  assert.match(studio, /const safetyBlocked = runner\?\.error\?\.isBlocking === true \|\| Boolean\(runner\?\.blocker\)/);
  assert.match(studio, /running \|\| safetyBlocked \|\| busy/);
  assert.match(studio, /fetchJsonWithTimeout/);
  assert.match(studio, /await refresh\(\)\.catch/);
  assert.doesNotMatch(studio, /ImageCreationStudioLegacy|ActiveImageTaskRail|function GpuPanel/);
  console.log(JSON.stringify({ ok: true, historicalCode6Mapped: true, currentErrorBlocking: true, priorAcceptedInferenceRecoveryMapped: true, createRateLimitCurrentAndHistoricalMapped: true, providerMutationCount: 0 }));
}

main();
