import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { claimImageTask, readImageTask } from "../../src/lib/image-generation/local-image-task-store";
import { createOrderWithRateLimit, freshRunRequiresManualRecovery, prepareFreshReceipt, persistAndFinalizeExactLocalTask, preflightExactLocalImageTask, requeueSafeFailedExactImageTask, resolveExactEligibleImageTask, startImageTaskLeaseHeartbeat, type ActiveOrderSnapshot, type FreshReceipt } from "./run-image-e2e";
import { CloreRateLimitError } from "./client";

const taskId = "eefc2b5b-5f25-4d82-aeeb-3b8ff501a1a0";
function failedReceipt(state: FreshReceipt["inferenceState"]): FreshReceipt { return { schema: 1, runId: "fixture-run", taskId, orderId: "fixture-order", endpoint: "https://fixture.invalid", currentStep: "failed", inferenceState: state, inferenceSubmitted: state !== "not_started", inferenceSucceeded: false, inferenceSubmittingAt: null, inferenceAcceptedAt: null, acceptedHttpStatus: null, inferenceCompletedAt: null, remoteArtifactAvailable: false, controllerPromptId: null, inferenceFailure: null, remoteArtifact: null, artifactDownloaded: false, localArtifactPublished: false, taskFinalized: false, uiVerified: false, orderCancelled: true, timestamps: {}, firstError: "fixture" }; }
function rateLimit(retryAfterMs: number | null, attempt: number, message = "rate limited") { return new CloreRateLimitError({ httpStatus: 429, code: 5, message, retryAfterMs, attempt }); }
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
    const task = { id: taskId, status: "waiting_for_gpu", mode: "text_generation", referenceImage: null, prompt: "fixture", width: 768, height: 768, steps: 25, cfg: 4, loraStrength: .8, seed: 1, sampler: "Euler", gpuClass: "rtx4090", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 0 };
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

    const preOrderReceipt = { ...failedReceipt("not_started"), orderId: null, endpoint: null, orderCancelled: false, runId: "pre-order" };
    writeFileSync(receiptPath, JSON.stringify(preOrderReceipt), "utf8"); activeChecks = 0;
    const preOrderRotated = await prepareFreshReceipt({ taskId, taskStatus: "waiting_for_gpu", receiptPath, archiveDir, activeOrderCount: async () => { activeChecks += 1; return 0; } });
    assert.equal(preOrderRotated.inferenceState, "not_started"); assert.equal(activeChecks, 1);
    writeFileSync(receiptPath, JSON.stringify(preOrderReceipt), "utf8");
    await assert.rejects(() => prepareFreshReceipt({ taskId, taskStatus: "waiting_for_gpu", receiptPath, archiveDir, activeOrderCount: async () => 1 }), /previous_receipt_active_order_exists/);

    const dimensionFailure = { ...failedReceipt("failed"), firstError: "inference_stage_failed:result_dimensions_mismatch:384x384", orderCancelled: true, controllerPromptId: "prompt-fixture", inferenceFailure: { code: "result_dimensions_mismatch", requested_width: 768, requested_height: 768, actual_width: 384, actual_height: 384, controller_prompt_id: "prompt-fixture", controller_job_id: "job-fixture", png_byte_size: 1, png_sha256: "a".repeat(64) }, remoteArtifact: null, remoteArtifactAvailable: false, artifactDownloaded: false, localArtifactPublished: false, taskFinalized: false };
    writeFileSync(taskPath, JSON.stringify([{ ...task, status: "failed", attempts: 1, error: { retryable: true, message: "result_dimensions_mismatch:384x384" } }]), "utf8");
    const requeued = requeueSafeFailedExactImageTask({ taskId, receipt: dimensionFailure, activeOrderCount: 0, options });
    assert.equal(requeued.status, "waiting_for_gpu"); assert.equal(Number(requeued.attempts), 2);
    assert.equal(readImageTask(taskId, options)?.status, "waiting_for_gpu");
    assert.throws(() => requeueSafeFailedExactImageTask({ taskId, receipt: { ...dimensionFailure, inferenceFailure: { ...dimensionFailure.inferenceFailure, actual_width: 512 } }, activeOrderCount: 0, options }), /safe_exact_retry_receipt_not_eligible/);
    writeFileSync(receiptPath, JSON.stringify(dimensionFailure), "utf8");
    const rotatedDimensionFailure = await prepareFreshReceipt({ taskId, taskStatus: "waiting_for_gpu", receiptPath, archiveDir, activeOrderCount: async () => 0 });
    assert.equal(rotatedDimensionFailure.inferenceState, "not_started");

    const emptySnapshot = { orders: [], checkedAt: 0 };
    let firstCreateReconciliations = 0;
    await createOrderWithRateLimit({ serverId: "98682", createOnce: async () => ({ id: "created-first" }), reconcile: async () => { firstCreateReconciliations += 1; return emptySnapshot; } });
    assert.equal(firstCreateReconciliations, 0, "the fresh zero-order snapshot is reused for the first create");
    const retryAfterDelays: number[] = []; let createCalls = 0; const payloadReferences: object[] = []; const payload = { unchanged: true };
    const retryAfter = await createOrderWithRateLimit({ serverId: "98682", createOnce: async () => { createCalls += 1; payloadReferences.push(payload); if (createCalls === 1) throw rateLimit(12_000, 1); return { id: "created" }; }, reconcile: async () => emptySnapshot, sleepImpl: async (delay) => { retryAfterDelays.push(delay); }, jitter: () => 0 });
    assert.equal(retryAfter.attempts, 2); assert.equal(createCalls, 2); assert.deepEqual(retryAfterDelays, [12_000]); assert.equal(payloadReferences[0], payloadReferences[1]);
    const fallbackDelays: number[] = []; createCalls = 0;
    await createOrderWithRateLimit({ serverId: "98682", createOnce: async () => { createCalls += 1; if (createCalls === 1) throw rateLimit(null, 1); return { id: "created" }; }, reconcile: async () => emptySnapshot, sleepImpl: async (delay) => { fallbackDelays.push(delay); }, jitter: () => 0 });
    assert.deepEqual(fallbackDelays, [90_000]);
    createCalls = 0;
    const adopted = await createOrderWithRateLimit({ serverId: "98682", createOnce: async () => { createCalls += 1; throw rateLimit(null, 1); }, reconcile: async (): Promise<ActiveOrderSnapshot> => ({ orders: [{ orderId: "adopted", serverId: "98682", active: true }], checkedAt: 0 }), sleepImpl: async () => undefined, jitter: () => 0 });
    assert.equal(adopted.adoptedOrderId, "adopted"); assert.equal(createCalls, 1);
    createCalls = 0; const diagnostics: unknown[] = [];
    await assert.rejects(() => createOrderWithRateLimit({ serverId: "98682", createOnce: async () => { createCalls += 1; throw rateLimit(null, createCalls, "token=fixture-secret"); }, reconcile: async () => emptySnapshot, sleepImpl: async () => undefined, jitter: () => 0, onDiagnostic: (value) => diagnostics.push(value) }), /create_order_rate_limit_persisted/);
    assert.equal(createCalls, 2); assert.ok(!JSON.stringify(diagnostics).includes("fixture-secret"));
    const claim = claimImageTask(taskId, "coordinator-fixture", 60_000, options);
    const heartbeat = startImageTaskLeaseHeartbeat({ taskId, claimToken: claim.claimToken, leaseMs: 60_000, options });
    const png = await sharp({ create: { width: 768, height: 768, channels: 3, background: "#2e6" } }).png().toBuffer();
    const result = await persistAndFinalizeExactLocalTask({ task: eligible, claimToken: claim.claimToken, png, remote: { generationDurationSeconds: 1, orderId: "fixture", gpuModel: "RTX 4090", controllerPromptId: null }, options });
    heartbeat.assertHealthy(); heartbeat.stop();
    assert.equal(result.completed.status, "completed");
    assert.equal(readImageTask(taskId, options)?.result?.pngSha256, result.artifact.pngSha256);
    console.log(JSON.stringify({ ok: true, preflight_does_not_claim: true, prior_submitting_blocks_fresh_provider_mutation: true, safe_failed_receipt_archived_and_rotated: true, safe_preorder_receipt_archived_and_rotated: true, exact_safe_dimension_failure_requeued_and_archived: true, ambiguous_dimension_failure_stays_blocked: true, active_order_blocks_preorder_rotation: true, single_snapshot_before_first_create: true, exact_429_retry_after_and_fallback: true, reconciled_order_adopted_without_second_create: true, second_429_stops_without_alternate: true, model_failure_leaves_task_unchanged: true, local_lease_heartbeat: true, persistence_and_exact_finalization: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
void main();
