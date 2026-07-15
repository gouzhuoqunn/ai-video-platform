import assert from "node:assert/strict";
import { buildFirstImageRestorePlan, buildFluxCacheManifest } from "./model-cache/flux4090-cache";

const manifest = buildFluxCacheManifest();
const plan = buildFirstImageRestorePlan(manifest);
assert.equal(plan.r2_restore_plan_valid, true);
assert.equal(plan.downloads.length, 3);
assert.equal(plan.total_size_bytes, 12_451_817_860);
assert.deepEqual(
  plan.downloads.map((entry) => entry.target_path),
  [
    "/workspace/models/diffusion_models/flux-2-klein-4b-fp8.safetensors",
    "/workspace/models/text_encoders/qwen_3_4b.safetensors",
    "/workspace/models/vae/flux2-vae.safetensors",
  ],
);
assert.ok(plan.downloads.every((entry) => entry.source === "r2"));
assert.ok(plan.downloads.every((entry) => entry.fallback.startsWith("https://huggingface.co/")));
assert.equal(plan.fallback_policy, "huggingface_only_after_r2_failure");

const badManifest = structuredClone(manifest);
badManifest.files[0].key = "production/rtx4090/image/staging/not-final";
assert.throws(() => buildFirstImageRestorePlan(badManifest), /manifest entry mismatch/);

console.log("First-image R2 restore preflight tests passed.");
