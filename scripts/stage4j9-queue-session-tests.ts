import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  beginConfirmedQueueExecution,
  confirmGenerationTasks,
  createGenerationTask,
  generationPoolSummary,
  readGenerationPool,
  recordConfirmedQueueRentalSuccess,
  upsertGenerationTasks,
} from "../src/lib/generation/task-pool";
import {
  confirmedQueueCounts,
  executionActionFor,
  normalizeGpuExecutionState,
} from "../src/lib/generation/gpu-execution-state";
import { GpuSessionController, type SafeGpuSessionDriver } from "../src/lib/generation/gpu-session-controller";
import { PRODUCTION_IMAGE_MODEL, PRODUCTION_VIDEO_MODEL } from "../src/lib/generation/production-models";

const root = mkdtempSync(path.join(os.tmpdir(), "stage4j9-queue-session-"));
const poolPath = path.join(root, "pool.json");
const calls: string[] = [];
const driver: SafeGpuSessionDriver = {
  async stopClaiming(family) { calls.push(`stop:${family}`); },
  async interruptGeneration(input) { calls.push(`interrupt:${input.family}:${input.taskIds.join(",")}`); },
  async unloadModelFamily(family) { calls.push(`unload:${family}`); },
  async ensureModelFamilyReady(input) { calls.push(`deploy:${input.family}:${input.gpuClass}:${input.providerOrderId}`); },
  async safeCancelSession(input) { calls.push(`cancel:${input.providerOrderId}:${input.hadActiveGeneration}`); },
};

function task(input: { id: string; family: "image" | "video"; gpu: "rtx4090" | "rtx5090"; long?: boolean }) {
  return createGenerationTask({
    id: input.id,
    generationType: input.family,
    prompt: `${input.id} prompt`,
    modelProfile: input.family === "image" ? PRODUCTION_IMAGE_MODEL : PRODUCTION_VIDEO_MODEL,
    gpuPreference: [input.gpu],
    status: "pending_confirmation",
    jobForm: input.long ? "long_video_segment" : input.family === "image" ? "image_only" : "video_from_existing_image",
    inputImageVerified: input.family === "video",
    inputImageJobId: input.family === "video" ? "verified-image" : null,
    longVideoProjectId: input.long ? "long-project" : null,
    longVideoSegmentIndex: input.long ? 0 : null,
  });
}

async function main() {
  try {
    const tasks = [
      task({ id: "image-blue", family: "image", gpu: "rtx4090" }),
      task({ id: "image-green", family: "image", gpu: "rtx5090" }),
      task({ id: "video-blue", family: "video", gpu: "rtx4090" }),
      task({ id: "video-green", family: "video", gpu: "rtx5090" }),
      task({ id: "video-long-blue", family: "video", gpu: "rtx4090", long: true }),
    ];
    upsertGenerationTasks(tasks, poolPath);
    assert.deepEqual(confirmedQueueCounts(readGenerationPool(poolPath).tasks), {
      image: { rtx4090: 0, rtx5090: 0 },
      video: { rtx4090: 0, rtx5090: 0 },
    });

    const imageConfirmation = confirmGenerationTasks(["image-blue", "image-green"], "image", poolPath);
    assert.equal(imageConfirmation.confirmed, 2);
    assert.deepEqual(generationPoolSummary(imageConfirmation.state).confirmedQueueCounts.image, { rtx4090: 1, rtx5090: 1 });
    const videoConfirmation = confirmGenerationTasks(["video-blue", "video-green", "video-long-blue"], "video", poolPath);
    assert.equal(videoConfirmation.confirmed, 3);
    assert.deepEqual(generationPoolSummary(videoConfirmation.state).confirmedQueueCounts.video, { rtx4090: 2, rtx5090: 1 });
    assert.throws(() => confirmGenerationTasks(["image-blue", "video-blue"], "image", poolPath), /不能混合图片和视频/);
    assert.equal(readGenerationPool(poolPath).tasks.find((item) => item.id === "video-blue")?.status, "waiting_for_gpu");

    let state = beginConfirmedQueueExecution({
      generationFamily: "image",
      gpuClass: "rtx5090",
      operationId: "rent-image-5090",
      manualRentalIntentVerified: true,
    }, poolPath);
    assert.equal(state.execution.activity, "searching");
    assert.deepEqual(state.execution.activeExecution?.confirmedTaskIds, ["image-green"]);
    assert.throws(() => beginConfirmedQueueExecution({ generationFamily: "image", gpuClass: "rtx5090", operationId: "duplicate", manualRentalIntentVerified: true }, poolPath), /处理中|已有租用/);

    state = recordConfirmedQueueRentalSuccess({ providerOrderId: "order-5090", runtimeSessionId: "runtime-5090", gpuClass: "rtx5090" }, poolPath);
    assert.equal(state.execution.activity, "deploying");
    assert.equal(state.execution.notice, "rental_succeeded");
    assert.equal(state.execution.rentedGpuClass, "rtx5090");
    assert.equal(state.execution.deployedFamily, "none");

    const controller = new GpuSessionController(driver, poolPath);
    state = await controller.deployActiveQueue();
    assert.equal(state.execution.activity, "running");
    assert.equal(state.execution.deployedFamily, "image");
    assert.equal(executionActionFor(state.execution, "video", "rtx5090", 1).kind, "blocked");
    assert.match(executionActionFor(state.execution, "video", "rtx5090", 1).reason ?? "", /先终止生成/);

    const imageAttempts = state.tasks.find((item) => item.id === "image-green")!.attempts.length;
    state = await controller.stopGeneration();
    assert.equal(state.execution.activity, "idle");
    assert.equal(state.execution.rentedGpuClass, "rtx5090");
    assert.equal(state.execution.providerOrderId, "order-5090");
    assert.equal(state.execution.deployedFamily, "image");
    assert.ok(state.execution.idleCancelAt);
    assert.equal(Date.parse(state.execution.idleCancelAt!) - Date.parse(state.execution.updatedAt), 120_000);
    assert.equal(state.tasks.find((item) => item.id === "image-green")?.attempts.length, imageAttempts);
    assert.equal(state.tasks.find((item) => item.id === "image-green")?.status, "waiting_for_gpu");

    const originalOrder = state.execution.providerOrderId;
    state = beginConfirmedQueueExecution({ generationFamily: "video", gpuClass: "rtx5090", operationId: "switch-video-5090", manualRentalIntentVerified: true }, poolPath);
    assert.equal(state.execution.activity, "deploying");
    assert.equal(state.execution.switchPhase, "unloading");
    assert.equal(state.execution.idleCancelAt, null);
    state = await controller.deployActiveQueue();
    assert.equal(state.execution.deployedFamily, "video");
    assert.equal(state.execution.activity, "running");
    assert.equal(state.execution.providerOrderId, originalOrder);
    assert.deepEqual(calls.filter((call) => call.startsWith("unload:")), ["unload:image"]);
    assert.ok(calls.includes("deploy:video:rtx5090:order-5090"));

    state = await controller.stopGeneration();
    state = beginConfirmedQueueExecution({ generationFamily: "video", gpuClass: "rtx5090", operationId: "resume-video-5090", manualRentalIntentVerified: true }, poolPath);
    assert.equal(state.execution.activity, "deploying");
    assert.equal(state.execution.idleCancelAt, null);
    state = await controller.deployActiveQueue();
    assert.equal(state.execution.activity, "running");
    assert.equal(calls.filter((call) => call === "unload:image").length, 1);
    state = await controller.stopGeneration();
    assert.throws(() => beginConfirmedQueueExecution({ generationFamily: "image", gpuClass: "rtx4090", operationId: "wrong-gpu", manualRentalIntentVerified: true }, poolPath), /当前租用的是 RTX 5090/);
    const cancelAt = Date.parse(state.execution.idleCancelAt!);
    const idleCancelCallsBefore = calls.filter((call) => call.startsWith("cancel:")).length;
    const expired = await controller.cancelExpiredIdleSession(cancelAt);
    assert.equal(expired.canceled, true);
    assert.equal(expired.state.execution.rentedGpuClass, null);
    assert.equal(expired.state.execution.deployedFamily, "none");
    assert.equal(expired.state.execution.activity, "idle");
    assert.equal(calls.filter((call) => call.startsWith("cancel:")).length, idleCancelCallsBefore + 1);
    await assert.rejects(() => controller.cancelGpu(), /没有可退租/);
    assert.equal(calls.filter((call) => call.startsWith("cancel:")).length, idleCancelCallsBefore + 1);

    const recovered = normalizeGpuExecutionState(null, {
      providerOrderId: "legacy-order",
      loadedModels: [PRODUCTION_VIDEO_MODEL],
      activeTaskIds: ["video-green"],
      phase: "video_inference_running",
      automaticShutdownAt: null,
    });
    assert.equal(recovered.rentedGpuClass, null);
    assert.equal(recovered.deployedFamily, "video");
    assert.equal(recovered.activity, "running");

    const studio = readFileSync("src/components/LocalCreationStudio.tsx", "utf8");
    const route = readFileSync("src/app/api/local-lab/generation-pool/route.ts", "utf8");
    const manual = readFileSync("src/lib/local-lab/clore-console.ts", "utf8");
    assert.match(studio, /可同时包含蓝色与绿色卡片/);
    assert.match(studio, /视频队列（短视频与长视频合并）/);
    assert.match(studio, /execution-queue-\$\{modelKey\}-\$\{gpuClass\}/);
    assert.match(studio, /正在恢复GPU会话/);
    assert.match(studio, /租用成功/);
    assert.match(studio, /终止.*生成，但不退租GPU/);
    assert.doesNotMatch(studio, /立即生成/);
    assert.match(route, /provider_mutations: 0/);
    assert.match(route, /create_order_called: false/);
    assert.match(route, /confirmedVideoQueueCounts: confirmedVideoQueueCounts\(tasks\)/);
    assert.match(manual, /riskAccepted !== true/);
    assert.match(manual, /确认文字必须与服务器和价格计划完全一致/);
    assert.equal(generationPoolSummary(readGenerationPool(poolPath)).mixedBatchEnabled, false);

    console.log(JSON.stringify({
      ok: true,
      queueBuckets: 4,
      sameFamilyMixedGpuConfirmation: true,
      shortLongVideoCombined: true,
      explicitActivity: true,
      sameOrderModelSwitch: true,
      stopPreservesGpu: true,
      idleCancelSeconds: 120,
      providerCancelCalls: calls.filter((call) => call.startsWith("cancel:")).length,
      providerMutations: 0,
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
