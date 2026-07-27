import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CREATE_RATE_LIMIT_CLASSIFICATION,
  CURRENT_CREATE_RATE_LIMIT_MESSAGE,
  HISTORICAL_AGENT_STAGE_MESSAGE,
  HISTORICAL_CREATE_RATE_LIMIT_MESSAGE,
  HISTORICAL_RENTED_CANDIDATE_MESSAGE,
  HISTORICAL_RUNNER_GENERIC_MESSAGE,
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

  const route = readFileSync("src/app/api/local-lab/image-tasks/route.ts", "utf8");
  assert.match(route, /host: display\.error\?\.historical \? null : runner\.host/);
  const studio = readFileSync("src/components/ImageCreationStudio.tsx", "utf8");
  assert.match(studio, /candidateRole/);
  assert.match(studio, /candidateRole === "rented_host"/);
  assert.match(studio, /当前候选显卡/);
  assert.match(studio, /已租用主机/);
  assert.doesNotMatch(studio, /ImageCreationStudioLegacy|ActiveImageTaskRail|function GpuPanel/);
  console.log(JSON.stringify({ ok: true, historicalCode6Mapped: true, currentErrorBlocking: true, createRateLimitCurrentAndHistoricalMapped: true, providerMutationCount: 0 }));
}

main();
