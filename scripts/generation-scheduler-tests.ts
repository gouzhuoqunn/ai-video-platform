import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyMarketObservation, armGenerationPool, createGenerationTask, marketplacePollDelayMs, upsertGenerationTasks } from "../src/lib/generation/task-pool";
import { PRODUCTION_IMAGE_MODEL } from "../src/lib/generation/production-models";

const root = mkdtempSync(path.join(tmpdir(), "stage3n-scheduler-"));
const statePath = path.join(root, "pool.json");
upsertGenerationTasks([createGenerationTask({ id: "immediate-image", generationType: "image", prompt: "restart", modelProfile: PRODUCTION_IMAGE_MODEL, priority: "immediate", status: "armed" })], statePath);
const first = armGenerationPool(statePath);
const second = armGenerationPool(statePath);
assert.equal(first.armed, true);
assert.equal(second.reusedPersistedBatch, true);
assert.equal(second.state.scheduler.selectedBatchId, first.state.scheduler.selectedBatchId);
assert.equal(JSON.parse(readFileSync(statePath, "utf8")).scheduler.orderCreationAttempted, false);

const observed = applyMarketObservation([{ serverId: "host-1", gpu: "RTX 4090", vramGb: 24, ramGb: 64, diskGb: 500, onDemand: true, reliability: 0.999, rating: 5, projectedCostUsd: 1.2, hourlyUsd: 0.3 }], statePath, Date.parse("2026-07-16T00:00:00.000Z"));
assert.equal(observed.orderWouldBeCreated, false);
assert.match(String(observed.reason), /部署暂停/);
const throttled = applyMarketObservation([], statePath, Date.parse("2026-07-16T00:00:30.000Z"));
assert.match(String(throttled.reason), /轮询尚未到期/);
assert.equal(marketplacePollDelayMs("2026-07-16T00:00:00.000Z", Date.parse("2026-07-16T00:31:00.000Z")), 120_000);
console.log("Scheduler restart, idempotency, hold, and market-watch throttling tests passed.");
