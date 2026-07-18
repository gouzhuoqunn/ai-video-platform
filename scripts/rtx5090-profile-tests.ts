import assert from "node:assert/strict";
import { resolveGpuProfile, RTX5090_BLACKWELL_PROFILE } from "../src/lib/generation/rtx5090-profile";

assert.equal(resolveGpuProfile("NVIDIA GeForce RTX 4090").gpu, "rtx4090");
assert.equal(resolveGpuProfile("NVIDIA GeForce RTX 5090").gpu, "rtx5090");
assert.equal(RTX5090_BLACKWELL_PROFILE.verified, false);
assert.equal(RTX5090_BLACKWELL_PROFILE.readiness.native1080Verified, false);
assert.equal(RTX5090_BLACKWELL_PROFILE.capabilities.find((item) => item.key === "high_long_video_final")?.final.width, 1920);
console.log("Non-paid RTX 5090 profile metadata checks passed.");
