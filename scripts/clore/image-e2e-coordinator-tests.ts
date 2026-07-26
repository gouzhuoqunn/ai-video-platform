import assert from "node:assert/strict";
import { runImageE2e, type CoordinatorDeps, type SanitizedImageE2eSession } from "./image-e2e-coordinator";

const task = { id: "eefc2b5b-5f25-4d82-aeeb-3b8ff501a1a0", status: "waiting_for_gpu", mode: "text_generation", referenceImage: null, prompt: "fixture", width: 768, height: 768, steps: 30, cfg: 4, loraStrength: .8, seed: 1, sampler: "FlowMatch" } as any;

function fake(input: { modelAuthFailure?: "once" | "twice"; artifactFailure?: boolean; submittingReceiptFailure?: boolean; acceptedReceiptFailure?: boolean; inferenceFailure?: boolean; resume?: SanitizedImageE2eSession | null } = {}) {
  const events: string[] = []; let saved: SanitizedImageE2eSession | null = input.resume ?? null; let claimed = false; let inferenceCalls = 0;
  const deps: CoordinatorDeps = {
    now: () => "2026-07-25T00:00:00.000Z", persist: (value) => { saved = structuredClone(value); events.push(`persist:${value.phase}`); }, load: () => saved,
    prerental: async () => { events.push("prerental"); return task; }, readEligibleTask: async () => { events.push("read_task"); return task; },
    createOrder: async () => { events.push("create"); return { orderId: "1979999", endpoint: "https://agent.example" }; }, reconnect: async () => ({ active: true, endpoint: "https://agent.example" }),
    armWatchdog: async () => { events.push("arm"); }, disarmWatchdog: async () => { events.push("disarm"); }, health: async () => ({ alive: true, currentStage: "idle", lastError: null }),
    stage: async (_endpoint, stage) => { events.push(`stage:${stage}`); const modelPosts = events.filter((value) => value === "stage:models").length; if (stage === "models" && input.modelAuthFailure && (input.modelAuthFailure === "twice" || modelPosts === 1)) return { status: "failed" as const, error: "model_download_http_error:transformer:x:http_403", data: { code: "model_download_http_error", role: "transformer", http_status: 403, body_excerpt: "AccessDenied" } }; if (stage === "inference") inferenceCalls += 1; return { status: "succeeded" as const }; },
    submitInference: async () => { events.push("inference_post"); inferenceCalls += 1; return { acceptedHttpStatus: 202 as const }; },
    pollInference: async () => { events.push("first_status_get"); return input.inferenceFailure ? { status: "failed" as const, error: "result_dimensions_mismatch:384x384", data: { code: "result_dimensions_mismatch", controller_job_id: "job-fixture", controller_prompt_id: "prompt-fixture", requested_width: 768, requested_height: 768, actual_width: 384, actual_height: 384, png_byte_size: 3, png_sha256: "c".repeat(64), prompt: "must-not-persist" } } : { status: "succeeded" as const, data: { controller_prompt_id: "prompt-from-status", byte_size: 3, sha256: "c".repeat(64), width: 768, height: 768, generation_duration_seconds: 1 } }; },
    inferenceReceipt: async (event, detail) => { events.push(`receipt_${event}`); if (event === "submitting" && input.submittingReceiptFailure) throw new Error("receipt_submitting_write_failed"); if (event === "accepted" && input.acceptedReceiptFailure) throw new Error("receipt_accepted_write_failed"); if (event === "accepted") assert.equal(detail?.acceptedHttpStatus, 202); if (event === "succeeded") { assert.equal(detail?.controllerPromptId, "prompt-from-status"); assert.equal(detail?.remoteArtifact?.sha256, "c".repeat(64)); } if (event === "failed") { assert.equal(detail?.controllerPromptId, "prompt-fixture"); assert.deepEqual(detail?.failure, { code: "result_dimensions_mismatch", controller_job_id: "job-fixture", controller_prompt_id: "prompt-fixture", requested_width: 768, requested_height: 768, actual_width: 384, actual_height: 384, png_byte_size: 3, png_sha256: "c".repeat(64) }); } },
    receiptEvent: async (event) => { events.push(`receipt_${event}`); },
    resolveModels: async () => { events.push("resolve_models"); return [{ role: "transformer", filename: "x", url: "https://signed.example/x?token=secret", sha256: "a".repeat(64), size_bytes: 1 }]; },
    claim: async () => { claimed = true; events.push("claim"); return { token: "plain-claim-token", tokenHash: "b".repeat(64) }; }, startHeartbeat: () => ({ stop: () => events.push("heartbeat_stop"), assertHealthy: () => undefined }),
    retrieveArtifact: async () => { events.push("retrieve"); if (input.artifactFailure && events.filter((value) => value === "retrieve").length === 1) throw new Error("transfer_failed"); return { png: Buffer.from("png"), byteSize: 3, sha256: "c".repeat(64), width: 768, height: 768, generationDurationSeconds: 1, controllerPromptId: "prompt" }; },
    publishAndFinalize: async () => { events.push("finalize"); return { relativeDir: "2026-07-25/eefc2b5b-5f25-4d82-aeeb-3b8ff501a1a0", pngSha256: "c".repeat(64), pngBytes: 3, width: 768, height: 768, completedAt: "2026-07-25T00:00:00.000Z" }; },
    verifyUi: async () => { events.push("ui"); }, failClaim: async () => { events.push("fail_claim"); }, cancelExactOrder: async (id) => { events.push(`cancel:${id}`); }, confirmNoActiveOrders: async () => { events.push("zero"); },
  };
  return { deps, events, get saved() { return saved; }, get claimed() { return claimed; }, get inferenceCalls() { return inferenceCalls; } };
}

async function main() {
  const success = fake(); await runImageE2e({ taskId: task.id, immutableCommit: "a".repeat(40), tokenFile: ".secrets/token", tokenSha256: "d".repeat(64), resume: false }, success.deps);
  assert.ok(success.events.indexOf("create") > success.events.indexOf("prerental"));
  assert.ok(success.events.indexOf("claim") > success.events.indexOf("stage:models"));
  assert.equal(success.events.filter((value) => value === "inference_post").length, 1);
  assert.ok(success.events.indexOf("receipt_submitting") < success.events.indexOf("inference_post"));
  assert.ok(success.events.indexOf("inference_post") < success.events.indexOf("receipt_accepted"));
  assert.ok(success.events.indexOf("receipt_accepted") < success.events.indexOf("first_status_get"));
  assert.equal(success.events.includes("stage:inference"), false);
  assert.ok(success.events.includes("receipt_artifact_downloaded") && success.events.includes("receipt_task_finalized") && success.events.includes("receipt_ui_verified") && success.events.includes("receipt_order_cancelled"));
  assert.ok(success.events.includes("cancel:1979999") && success.events.filter((value) => value === "zero").length === 2);
  assert.ok(!JSON.stringify(success.saved).includes("plain-claim-token") && !JSON.stringify(success.saved).includes("signed.example"));
  const refreshed = fake({ modelAuthFailure: "once" }); await runImageE2e({ taskId: task.id, immutableCommit: "a".repeat(40), tokenFile: ".secrets/token", tokenSha256: "d".repeat(64), resume: false }, refreshed.deps);
  assert.equal(refreshed.events.filter((value) => value === "resolve_models").length, 2);
  assert.equal(refreshed.events.filter((value) => value === "stage:models").length, 2);
  assert.equal(refreshed.inferenceCalls, 1);
  const authorizationExhausted = fake({ modelAuthFailure: "twice" });
  await assert.rejects(() => runImageE2e({ taskId: task.id, immutableCommit: "a".repeat(40), tokenFile: ".secrets/token", tokenSha256: "d".repeat(64), resume: false }, authorizationExhausted.deps), /model_download_authorization_failed_after_refresh/);
  assert.equal(authorizationExhausted.events.filter((value) => value === "stage:models").length, 2);
  assert.equal(authorizationExhausted.inferenceCalls, 0); assert.equal(authorizationExhausted.claimed, false); assert.ok(authorizationExhausted.events.includes("cancel:1979999"));
  const transfer = fake({ artifactFailure: true }); await runImageE2e({ taskId: task.id, immutableCommit: "a".repeat(40), tokenFile: ".secrets/token", tokenSha256: "d".repeat(64), resume: false }, transfer.deps);
  assert.equal(transfer.inferenceCalls, 1); assert.equal(transfer.events.filter((value) => value === "retrieve").length, 2); assert.ok(transfer.events.includes("cancel:1979999"));
  const submittingWriteFailure = fake({ submittingReceiptFailure: true });
  await assert.rejects(() => runImageE2e({ taskId: task.id, immutableCommit: "a".repeat(40), tokenFile: ".secrets/token", tokenSha256: "d".repeat(64), resume: false }, submittingWriteFailure.deps), /receipt_submitting_write_failed/);
  assert.equal(submittingWriteFailure.inferenceCalls, 0);
  const postAcceptedCrash = fake({ acceptedReceiptFailure: true });
  await assert.rejects(() => runImageE2e({ taskId: task.id, immutableCommit: "a".repeat(40), tokenFile: ".secrets/token", tokenSha256: "d".repeat(64), resume: false }, postAcceptedCrash.deps), /receipt_accepted_write_failed/);
  assert.equal(postAcceptedCrash.inferenceCalls, 1); assert.equal(postAcceptedCrash.events.includes("first_status_get"), false);
  const explicitInferenceFailure = fake({ inferenceFailure: true });
  await assert.rejects(() => runImageE2e({ taskId: task.id, immutableCommit: "a".repeat(40), tokenFile: ".secrets/token", tokenSha256: "d".repeat(64), resume: false }, explicitInferenceFailure.deps), /inference_stage_failed:result_dimensions_mismatch:384x384/);
  assert.equal(explicitInferenceFailure.inferenceCalls, 1); assert.equal(explicitInferenceFailure.events.filter((value) => value === "inference_post").length, 1); assert.ok(explicitInferenceFailure.events.includes("receipt_failed"));
  const completed = fake(); completed.deps.prerental = async () => { throw new Error("image_task_not_eligible_for_restricted_4090_run"); };
  await assert.rejects(() => runImageE2e({ taskId: task.id, immutableCommit: "a".repeat(40), tokenFile: ".secrets/token", tokenSha256: "d".repeat(64), resume: false }, completed.deps));
  assert.equal(completed.events.includes("create"), false);
  console.log(JSON.stringify({ ok: true, full_fake_sequence: true, prerental_before_order: true, claim_after_models: true, inference_receipt_order: true, submitting_write_prevents_post: true, post_202_before_poll: true, accepted_receipt_prompt_free: true, polling_prompt_metadata_recorded: true, dimension_failure_prompt_and_job_recorded: true, accepted_receipt_crash_stays_pre_poll: true, explicit_failure_single_post: true, artifact_retry_without_inference_rerun: true, legacy_inference_forbidden: true, finally_exact_cancel: true, secrets_sanitized: true }));
}
void main();
