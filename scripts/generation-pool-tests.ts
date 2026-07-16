import assert from "node:assert/strict";
import { createGenerationTask, defaultGenerationPoolState, selectCloreCandidate, selectNextSession } from "../src/lib/generation/task-pool";

const state = defaultGenerationPoolState();
state.tasks = [
  ...[1, 2, 3].map((number) => createGenerationTask({ id: `image-${number}`, generationType: "image", prompt: `image ${number}`, modelProfile: "flux2-klein-4b", status: "waiting_for_batch", createdAt: new Date(number * 1000).toISOString() })),
  ...[1, 2].map((number) => createGenerationTask({ id: `video-${number}`, generationType: "video", prompt: `video ${number}`, modelProfile: "wan22-ti2v-5b", status: "waiting_for_batch", createdAt: new Date((10 + number) * 1000).toISOString() })),
];
const selected = selectNextSession(state);
assert.equal(selected.ready, true);
assert.deepEqual(selected.batches.map((batch) => batch.generationType), ["image", "video"]);
assert.deepEqual(selected.acceptableGpuClasses, ["rtx4090", "rtx5090"]);

const candidate = selectCloreCandidate([
  { serverId: "cheap-unreliable", gpu: "RTX 4090", vramGb: 24, reliability: 0.95, rating: 5, projectedCostUsd: 1, hourlyUsd: 0.2 },
  { serverId: "reliable", gpu: "RTX 5090", vramGb: 32, reliability: 0.999, rating: 4.9, projectedCostUsd: 1.5, hourlyUsd: 0.35 },
], state);
assert.equal(candidate.candidate?.serverId, "reliable");

const immediate = defaultGenerationPoolState();
immediate.tasks = [createGenerationTask({ id: "urgent-video", generationType: "video", prompt: "urgent", modelProfile: "wan22-ti2v-5b", status: "armed", priority: "immediate" })];
assert.equal(selectNextSession(immediate).ready, true);

const belowThreshold = defaultGenerationPoolState();
belowThreshold.tasks = [createGenerationTask({ generationType: "video", prompt: "one normal", modelProfile: "wan22-ti2v-5b", status: "waiting_for_batch" })];
assert.equal(selectNextSession(belowThreshold).ready, false);
console.log("Generation task pool selection, threshold, immediate, and GPU policy tests passed.");
