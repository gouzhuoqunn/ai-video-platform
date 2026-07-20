import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  armGenerationPool,
  classifyProductionSessionRecovery,
  createNormalJobSet,
  defaultGenerationPoolState,
  generationPoolSummary,
  persistRecoveredSession,
  regenerateGenerationTasks,
  requestSessionShutdown,
  retryGenerationTasks,
  selectNextSession,
  setGenerationTaskStatus,
  updateGenerationTasks,
  upsertGenerationTasks,
} from "../src/lib/generation/task-pool";
import {
  DEFAULT_PRODUCTION_SCHEDULER_POLICY,
  estimateProductionSession,
  loadProductionReadiness,
  loadProductionVerification,
  loadSchedulerPolicy,
  planSequentialProductionSession,
  productionReadinessGate,
} from "../src/lib/generation/production-pipeline";
import { PRODUCTION_IMAGE_MODEL, PRODUCTION_VIDEO_MODEL } from "../src/lib/generation/production-models";
import { WORKFLOW_TEMPLATES, injectWorkflowParameters, validateWorkflowTemplate } from "../src/lib/generation/workflow-registry";
import { buildLocalImagePaths, buildLocalJobPaths, writeJsonAtomic } from "./local-results/config";

function main() {
  const verification = loadProductionVerification();
  const readiness = loadProductionReadiness();
  assert.equal(verification.immutable, true);
  assert.equal(verification.imageModel.family, PRODUCTION_IMAGE_MODEL);
  assert.equal(verification.videoModel.family, PRODUCTION_VIDEO_MODEL);
  assert.doesNotMatch(JSON.stringify(verification), /[A-Za-z]:[\\/]|\/(?:home|root|workspace|tmp)\//);
  assert.deepEqual({
    model_cache_ready: readiness.model_cache_ready,
    gpu_inference_verified: readiness.gpu_inference_verified,
    normal_ui_pipeline_implemented: readiness.normal_ui_pipeline_implemented,
    normal_ui_pipeline_gpu_verified: readiness.normal_ui_pipeline_gpu_verified,
    daily_use_release_candidate: readiness.daily_use_release_candidate,
    production_ready: readiness.production_ready,
  }, {
    model_cache_ready: true,
    gpu_inference_verified: true,
    normal_ui_pipeline_implemented: true,
    normal_ui_pipeline_gpu_verified: false,
    daily_use_release_candidate: true,
    production_ready: false,
  });
  assert.equal(productionReadinessGate(PRODUCTION_IMAGE_MODEL, "rtx4090").allowed, true);
  assert.equal(productionReadinessGate(PRODUCTION_VIDEO_MODEL, "rtx5090").allowed, true);
  assert.equal(productionReadinessGate("flux2-klein-4b").allowed, false);

  assert.deepEqual(loadSchedulerPolicy({}), DEFAULT_PRODUCTION_SCHEDULER_POLICY);
  const configured = loadSchedulerPolicy({ GENERATION_IMAGE_BATCH_THRESHOLD: "4", GENERATION_VIDEO_BATCH_THRESHOLD: "3", GENERATION_COMBINED_BATCH_THRESHOLD: "2", GENERATION_MAX_WAIT_MINUTES: "45" });
  assert.equal(configured.imageOnlyBatchThreshold, 4);
  assert.equal(configured.maximumWaitMinutes, 45);
  assert.equal(configured.maximumActiveOrders, 1);

  const imageOnly = createNormalJobSet({ jobForm: "image_only", prompt: "A production image", seed: 123, sizePreset: "square_1024" });
  assert.equal(imageOnly.length, 1);
  assert.equal(imageOnly[0].modelProfile, PRODUCTION_IMAGE_MODEL);
  assert.equal(imageOnly[0].status, "pending_confirmation");
  assert.equal(imageOnly[0].seed, 123);

  const chain = createNormalJobSet({ jobForm: "video_from_generated_image", prompt: "A production chain", seed: 456, sizePreset: "wan_4090", priority: "immediate", status: "armed" });
  assert.equal(chain.length, 2);
  assert.equal(chain[1].inputImageJobId, chain[0].id);
  assert.equal(chain[1].modelProfile, PRODUCTION_VIDEO_MODEL);
  assert.equal(chain[1].inputImageVerified, false);

  const existing = createNormalJobSet({ jobForm: "video_from_existing_image", prompt: "Animate existing image", existingImageJobId: "existing-image-123", existingImageVerified: true, sizePreset: "wan_5090" });
  assert.equal(existing[0].inputImageJobId, "existing-image-123");
  assert.equal(existing[0].inputImageVerified, true);
  assert.throws(() => createNormalJobSet({ jobForm: "video_from_existing_image", prompt: "No image", existingImageJobId: "missing", existingImageVerified: false }));

  const plan = planSequentialProductionSession([...chain, ...existing]);
  assert.equal(plan.imageGroups.length, 1);
  assert.equal(plan.videoGroups.length, 2);
  assert.equal(plan.unloadImageModels, true);
  assert.equal(plan.failureIsolation, "per_job");
  assert.equal(plan.cleanupAfterFinalTask, true);

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "stage4f-pipeline-"));
  const poolPath = path.join(tempRoot, "pool.json");
  try {
    upsertGenerationTasks(chain, poolPath);
    const selection = selectNextSession(JSON.parse(readFileSync(poolPath, "utf8")));
    assert.equal(selection.ready, true);
    assert.deepEqual(new Set(selection.tasks.map((task) => task.id)), new Set(chain.map((task) => task.id)));
    const armed = armGenerationPool(poolPath);
    assert.equal(armed.armed, true);
    assert.ok(armed.state.scheduler.selectedBatchId);

    setGenerationTaskStatus([chain[0].id], "completed", { outputPath: "output.png", imagePreserved: true }, poolPath);
    setGenerationTaskStatus([chain[1].id], "failed", { errorClass: "simulated_video_failure", imagePreserved: true }, poolPath);
    const retried = retryGenerationTasks([chain[1].id], poolPath);
    const retriedVideo = retried.tasks.find((task) => task.id === chain[1].id)!;
    assert.equal(retriedVideo.attempts.length, 2);
    assert.equal(retriedVideo.attempts[1].resumeBoundary, "restoring_video_model");
    assert.equal(retried.tasks.find((task) => task.id === chain[0].id)?.status, "completed");
    assert.throws(() => retryGenerationTasks([chain[0].id], poolPath));

    const regenerated = regenerateGenerationTasks(chain.map((task) => task.id), poolPath);
    assert.equal(regenerated.regenerated.length, 2);
    assert.equal(regenerated.regenerated[1].inputImageJobId, regenerated.regenerated[0].id);
    assert.equal(regenerated.regenerated[0].generationNumber, 2);
    assert.equal(regenerated.regenerated[0].originalJobId, chain[0].id);

    persistRecoveredSession({
      sessionId: "normal-session-1",
      providerOrderId: "order-1",
      observation: { providerOrderActive: true, sshReady: true, runtimeReady: true, localImageCompleted: true, remoteInferenceKind: "video" },
      activeTaskIds: [chain[1].id],
      loadedModels: [PRODUCTION_VIDEO_MODEL],
      approximateSpendUsd: 0.2,
      estimatedRemainingMinutes: 5,
    }, poolPath);
    const shutdown = requestSessionShutdown("after_current", poolPath);
    assert.equal(shutdown.scheduler.state, "draining");
    assert.equal(shutdown.scheduler.session?.shutdownMode, "after_current");
    assert.throws(() => persistRecoveredSession({
      sessionId: "other-session",
      providerOrderId: "different-order",
      observation: { providerOrderActive: true },
      activeTaskIds: [],
    }, poolPath));

    const cancelled = requestSessionShutdown("cancel_waiting", poolPath);
    assert.ok(cancelled.tasks.filter((task) => ["pending_confirmation", "waiting_for_batch", "armed", "waiting_for_gpu"].includes(task.status)).length === 0);
    assert.equal(generationPoolSummary(cancelled).orderWouldBeCreated, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  assert.equal(classifyProductionSessionRecovery({ providerOrderActive: false }), "no_provider_order");
  assert.equal(classifyProductionSessionRecovery({ providerOrderActive: true, providerOrderProvisioning: true }), "order_provisioning");
  assert.equal(classifyProductionSessionRecovery({ providerOrderActive: true, sshReady: true, runtimeReady: true, remoteRestoreRunning: true }), "restore_running");
  assert.equal(classifyProductionSessionRecovery({ providerOrderActive: true, sshReady: true, runtimeReady: true, localImageCompleted: true, remoteInferenceKind: "video" }), "video_inference_running");
  assert.equal(classifyProductionSessionRecovery({ providerOrderActive: true, sshReady: true, runtimeReady: true, localVideoSourceReady: true, localMp4Ready: false }), "media_conversion_running");

  const estimate = estimateProductionSession(chain);
  assert.ok(estimate.totalSession.minMinutes >= 60);
  assert.ok(estimate.projectedComputeUsd.max > estimate.projectedComputeUsd.min);
  assert.equal(estimate.userLocalDownloadBytesExcluded, true);
  const reused = estimateProductionSession(chain, { activeSession: true, imageModelLoaded: true, videoModelLoaded: true });
  assert.ok(reused.totalSession.maxMinutes < estimate.totalSession.minMinutes);

  assert.deepEqual(validateWorkflowTemplate(WORKFLOW_TEMPLATES.image_t2i), []);
  assert.deepEqual(validateWorkflowTemplate(WORKFLOW_TEMPLATES.video_i2v), []);
  const videoWorkflow = injectWorkflowParameters(WORKFLOW_TEMPLATES.video_i2v, { seed: 999, width: 832, height: 480, frames: 33 });
  assert.equal((videoWorkflow["11"] as { inputs: { noise_seed: number } }).inputs.noise_seed, 999);
  assert.equal((videoWorkflow["12"] as { inputs: { noise_seed: number } }).inputs.noise_seed, 999);

  const imagePaths = buildLocalImagePaths("D:\\AI-Creative-Library", "2026-07-18", "normal-image-job");
  const videoPaths = buildLocalJobPaths("D:\\AI-Video-Library", "2026-07-18", "normal-video-job");
  assert.equal(imagePaths.sessionDir, path.join("D:\\AI-Creative-Library", "2026-07-18", "normal-image-job"));
  for (const name of ["source.webm", "output.mp4", "thumbnail.jpg", "metadata.json", "workflow-api.json", "runtime-evidence.json", "provider-session.json", "restore-evidence.json"]) {
    assert.ok(Object.values(videoPaths).some((value) => path.basename(value) === name));
  }
  const atomicPath = path.join(os.tmpdir(), `stage4f-atomic-${process.pid}.json`);
  writeJsonAtomic(atomicPath, { ready: true });
  assert.equal(JSON.parse(readFileSync(atomicPath, "utf8")).ready, true);
  assert.equal(existsSync(`${atomicPath}.${process.pid}.part`), false);
  rmSync(atomicPath, { force: true });

  const empty = defaultGenerationPoolState();
assert.equal(empty.schemaVersion, 4);
  assert.equal(empty.scheduler.session, null);
  updateGenerationTasks([], "confirm", path.join(os.tmpdir(), `stage4f-unused-${process.pid}.json`));
  rmSync(path.join(os.tmpdir(), `stage4f-unused-${process.pid}.json`), { force: true });

  console.log("Stage 4F production metadata, defaults, normal jobs, dependencies, batching, estimates, retry, recovery, shutdown, media layout, workflow, and idempotency tests passed.");
}

main();
