import assert from "node:assert/strict";
import { createGenerationTask, defaultGenerationPoolState, selectCloreCandidate, selectNextSession } from "../src/lib/generation/task-pool";
import { PRODUCTION_IMAGE_MODEL, PRODUCTION_VIDEO_MODEL } from "../src/lib/generation/production-models";

const state = defaultGenerationPoolState();
state.tasks = [
  ...[1, 2, 3].map((number) => createGenerationTask({ id: `image-${number}`, generationType: "image", prompt: `image ${number}`, modelProfile: PRODUCTION_IMAGE_MODEL, status: "waiting_for_batch", createdAt: new Date(number * 1000).toISOString() })),
  ...[1, 2].map((number) => createGenerationTask({ id: `video-${number}`, generationType: "video", prompt: `video ${number}`, modelProfile: PRODUCTION_VIDEO_MODEL, jobForm: "video_from_existing_image", inputImageJobId: `existing-image-${number}`, inputImageVerified: true, status: "waiting_for_batch", createdAt: new Date((10 + number) * 1000).toISOString() })),
];
const selected = selectNextSession(state);
assert.equal(selected.ready, true);
assert.deepEqual(selected.batches.map((batch) => batch.generationType), ["image", "video"]);
assert.deepEqual(selected.acceptableGpuClasses, ["rtx4090", "rtx5090"]);

const candidate = selectCloreCandidate([
  { serverId: "cheap-unreliable", gpu: "RTX 4090", vramGb: 24, ramGb: 64, diskGb: 500, onDemand: true, reliability: 0.95, rating: 5, projectedCostUsd: 1, hourlyUsd: 0.2 },
  { serverId: "reliable", gpu: "RTX 5090", vramGb: 32, ramGb: 64, diskGb: 500, onDemand: true, reliability: 0.999, rating: 4.9, projectedCostUsd: 1.5, hourlyUsd: 0.35 },
], state);
assert.equal(candidate.candidate?.serverId, "reliable");

const immediate = defaultGenerationPoolState();
immediate.tasks = [createGenerationTask({ id: "urgent-video", generationType: "video", prompt: "urgent", modelProfile: PRODUCTION_VIDEO_MODEL, jobForm: "video_from_existing_image", inputImageJobId: "existing-image", inputImageVerified: true, status: "armed", priority: "immediate" })];
assert.equal(selectNextSession(immediate).ready, true);

const belowThreshold = defaultGenerationPoolState();
belowThreshold.tasks = [createGenerationTask({ generationType: "video", prompt: "one normal", modelProfile: PRODUCTION_VIDEO_MODEL, jobForm: "video_from_existing_image", inputImageJobId: "existing-image", inputImageVerified: true, status: "waiting_for_batch" })];
assert.equal(selectNextSession(belowThreshold).ready, false);
console.log("Generation task pool selection, threshold, immediate, and GPU policy tests passed.");
