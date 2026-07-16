import assert from "node:assert/strict";
import { loadModelAvailabilityRegistry, modelAvailabilityGate } from "../src/lib/generation/model-availability";

const registry = loadModelAvailabilityRegistry();
assert.equal(modelAvailabilityGate("flux2-klein-4b", registry).allowed, true);
assert.equal(modelAvailabilityGate("wan22-ti2v-5b", registry).allowed, true);
assert.equal(modelAvailabilityGate("missing-model", registry).allowed, false);
const blocked = { schemaVersion: 1 as const, models: [{ ...registry.models[0], cached: false, restoreReady: false, validatedFallback: false }] };
assert.match(modelAvailabilityGate("flux2-klein-4b", blocked).reason, /没有可恢复缓存/);
console.log("Model availability registry and Chinese blocking-reason tests passed.");
