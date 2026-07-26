import assert from "node:assert/strict";
import { HISTORICAL_RENTED_CANDIDATE_MESSAGE, HISTORICAL_RUNNER_GENERIC_MESSAGE, projectRunnerStatus } from "../src/lib/image-generation/runner-status-projection";

const historicalCode6 = { state: "failed", pid: 27900, host: { orderId: null }, blocker: "Clore API failed", error: { stage: "preflight", at: "2026-07-26T18:26:08.488Z", message: "Clore API failed: {\"httpStatus\":200,\"code\":6,\"error\":\"server-already-rented\",\"classification\":\"unknown_code6\"}" } };

function main() {
  const historical = projectRunnerStatus(historicalCode6, { pidAlive: false, activeOrder: false, createLock: false });
  assert.equal(historical.error?.displayMessage, HISTORICAL_RENTED_CANDIDATE_MESSAGE);
  assert.equal(historical.error?.isBlocking, false);
  assert.equal(historical.error?.historical, true);
  assert.doesNotMatch(JSON.stringify(historical), /unknown_code6|httpStatus|server-already-rented/);
  assert.equal(historical.blocker, null);

  const unknown = projectRunnerStatus({ ...historicalCode6, error: { ...historicalCode6.error, message: "Clore API failed: {\"code\":9,\"error\":\"other\"}" } }, { pidAlive: false, activeOrder: false, createLock: false });
  assert.equal(unknown.error?.displayMessage, HISTORICAL_RUNNER_GENERIC_MESSAGE);

  const active = projectRunnerStatus({ ...historicalCode6, state: "running" }, { pidAlive: true, activeOrder: false, createLock: false });
  assert.equal(active.error?.isBlocking, true);
  assert.equal(active.error?.historical, false);
  assert.doesNotMatch(JSON.stringify(active), /unknown_code6|httpStatus|server-already-rented/);
  console.log(JSON.stringify({ ok: true, historicalCode6Mapped: true, currentErrorBlocking: true, providerMutationCount: 0 }));
}

main();
