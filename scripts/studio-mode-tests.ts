import assert from "node:assert/strict";
import { AUTOMATIC_GPU_PROVIDER, batchThreshold, normalizeStudioMode, shouldArmCloreScheduler, STUDIO_MODE_STORAGE_KEY } from "../src/lib/local-lab/studio-mode";

assert.equal(normalizeStudioMode("image"), "image");
assert.equal(normalizeStudioMode("video"), "video");
assert.equal(normalizeStudioMode("bad"), "video");
assert.match(STUDIO_MODE_STORAGE_KEY, /studio-mode/);
assert.equal(AUTOMATIC_GPU_PROVIDER, "clore");
assert.equal(batchThreshold("4"), 4);
assert.equal(batchThreshold("0"), 2);
assert.equal(shouldArmCloreScheduler({ immediate: true, queuedCount: 1, threshold: 3 }).schedulerArmed, true);
assert.equal(shouldArmCloreScheduler({ immediate: false, queuedCount: 2, threshold: 3 }).schedulerArmed, false);
assert.equal(shouldArmCloreScheduler({ immediate: false, queuedCount: 3, threshold: 3 }).schedulerArmed, true);
assert.equal(shouldArmCloreScheduler({ immediate: true, queuedCount: 1, threshold: 3 }).createOrderAllowed, false);
assert.equal(shouldArmCloreScheduler({ immediate: true, queuedCount: 1, threshold: 3, compliantHostExists: true }).createOrderAllowed, true);
console.log("Chinese image/video mode and Clore scheduler arming tests passed.");
