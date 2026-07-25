import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { claimImageTask, readImageTask } from "../../src/lib/image-generation/local-image-task-store";
import { freshRunRequiresManualRecovery, prepareFreshReceipt, persistAndFinalizeExactLocalTask, preflightExactLocalImageTask, resolveExactEligibleImageTask, startImageTaskLeaseHeartbeat, type FreshReceipt } from "./run-image-e2e";

const taskId = "723e4567-e89b-42d3-a456-426614174000";
function failedReceipt(state: FreshReceipt["inferenceState"]): FreshReceipt { return { schema: 1, runId: "fixture-run", taskId, orderId: "fixture-order", endpoint: "https://fixture.invalid", currentStep: "failed", inferenceState: state, inferenceSubmitted: state !== "not_started", inferenceSucceeded: false, inferenceSubmittingAt: null, inferenceAcceptedAt: null, acceptedHttpStatus: null, inferenceCompletedAt: null, remoteArtifactAvailable: false, controllerPromptId: null, remoteArtifact: null, artifactDownloaded: false, localArtifactPublished: false, taskFinalized: false, uiVerified: false, orderCancelled: true, timestamps: {}, firstError: "fixture" }; }
function exactModelFixture() { return { models: [
  { role: "transformer", id: "fluxed-up-10.2" as const, filename: "fluxedUpFluxNSFW_102BF16.safetensors", url: "https://fixture.invalid/transformer", sha256: "0".repeat(64), size_bytes: 1 },
  { role: "lora", id: "aidma-lora" as const, filename: "aidmaNSFWunlock-FLUX-V0.2.safetensors", url: "https://fixture.invalid/lora", sha256: "1".repeat(64), size_bytes: 2 },
  { role: "vae", id: "flux-vae" as const, filename: "ae.safetensors", url: "https://fixture.invalid/vae", sha256: "2".repeat(64), size_bytes: 3 },
  { role: "clip_l", id: "flux-clip-l" as const, filename: "clip_l.safetensors", url: "https://fixture.invalid/clip", sha256: "3".repeat(64), size_bytes: 4 },
  { role: "t5", id: "flux-t5xxl-fp8" as const, filename: "t5xxl_fp8_e4m3fn_scaled.safetensors", url: "https://fixture.invalid/t5", sha256: "4".repeat(64), size_bytes: 5 },
], checked: [] as Array<{ id: string; status: number; contentLength: number; source: "civitai" | "huggingface" }> }; }
async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "image-e2e-"));
  try {
    const taskPath = path.join(root, "tasks.json"); const options = { taskPath, artifactRoot: path.join(root, "library") };
    const task = { id: taskId, status: "waiting_for_gpu", mode: "text_generation", referenceImage: null, prompt: "fixture", width: 768, height: 768, steps: 25, cfg: 4, loraStrength: .8, seed: 1, sampler: "Euler", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 0 };
    writeFileSync(taskPath, JSON.stringify([task]), "utf8");
    // Runtime/model preflight reads eligibility without claiming it.
    const eligible = resolveExactEligibleImageTask(taskId, options);
    assert.equal(eligible.status, "waiting_for_gpu");
    assert.equal(readImageTask(taskId, options)?.status, "waiting_for_gpu");
    await assert.rejects(() => preflightExactLocalImageTask(taskId, options, async () => { throw new Error("model_source_unavailable"); }), /model_source_unavailable/);
    assert.equal(readImageTask(taskId, options)?.status, "waiting_for_gpu");
    const preflight = await preflightExactLocalImageTask(taskId, options, async () => exactModelFixture());
    assert.equal(preflight.claimsTask, false);
    assert.equal(readImageTask(taskId, options)?.status, "waiting_for_gpu");
    assert.equal(freshRunRequiresManualRecovery({ taskId, inferenceState: "submitting" }, taskId, "waiting_for_gpu"), true);
    assert.equal(freshRunRequiresManualRecovery({ taskId, inferenceState: "accepted" }, taskId, "waiting_for_gpu"), true);
    assert.equal(freshRunRequiresManualRecovery({ taskId, inferenceState: "succeeded" }, taskId, "waiting_for_gpu"), true);
    assert.equal(freshRunRequiresManualRecovery({ taskId, inferenceState: "failed" }, taskId, "waiting_for_gpu"), false);
    const receiptPath = path.join(root, "receipt.json"); const archiveDir = path.join(root, "diagnostics"); writeFileSync(receiptPath, JSON.stringify(failedReceipt("not_started")), "utf8");
    let activeChecks = 0; const rotated = await prepareFreshReceipt({ taskId, taskStatus: "waiting_for_gpu", receiptPath, archiveDir, activeOrderCount: async () => { activeChecks += 1; return 0; } });
    assert.equal(rotated.inferenceState, "not_started"); assert.notEqual(rotated.runId, "fixture-run"); assert.equal(activeChecks, 1); assert.equal(readdirSync(archiveDir).length, 1); assert.ok(existsSync(receiptPath));
    writeFileSync(receiptPath, JSON.stringify(failedReceipt("submitting")), "utf8"); activeChecks = 0;
    await assert.rejects(() => prepareFreshReceipt({ taskId, taskStatus: "waiting_for_gpu", receiptPath, archiveDir, activeOrderCount: async () => { activeChecks += 1; return 0; } }), /previous_inference_state_requires_manual_recovery/);
    assert.equal(activeChecks, 0);
    const claim = claimImageTask(taskId, "coordinator-fixture", 60_000, options);
    const heartbeat = startImageTaskLeaseHeartbeat({ taskId, claimToken: claim.claimToken, leaseMs: 60_000, options });
    const png = await sharp({ create: { width: 768, height: 768, channels: 3, background: "#2e6" } }).png().toBuffer();
    const result = await persistAndFinalizeExactLocalTask({ task: eligible, claimToken: claim.claimToken, png, remote: { generationDurationSeconds: 1, orderId: "fixture", gpuModel: "RTX 4090", controllerPromptId: null }, options });
    heartbeat.assertHealthy(); heartbeat.stop();
    assert.equal(result.completed.status, "completed");
    assert.equal(readImageTask(taskId, options)?.result?.pngSha256, result.artifact.pngSha256);
    console.log(JSON.stringify({ ok: true, preflight_does_not_claim: true, prior_submitting_blocks_fresh_provider_mutation: true, safe_failed_receipt_archived_and_rotated: true, model_failure_leaves_task_unchanged: true, local_lease_heartbeat: true, persistence_and_exact_finalization: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
void main();
