import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGenerationTask, createManualSilent4090Batch, isManualSilent4090BatchTask, readGenerationPool, updateManualGpuBatch, upsertGenerationTasks } from "../src/lib/generation/task-pool";
import { runManualSilent4090Batch } from "../src/lib/generation/manual-gpu-batch-runner";

const root = mkdtempSync(path.join(os.tmpdir(), "manual-gpu-batch-"));
const poolPath = path.join(root, "pool.json");
const silent = (id: string, createdAt: string) => createGenerationTask({ id, generationType: "video", mediaType: "video", videoSubtype: "short_video", prompt: `silent ${id}`, modelProfile: "wan22-remix-14b-i2v-fp8", modelKey: "video_wan_silent", soundMode: "silent", audioOrigin: "none", requiredGpuClass: "rtx4090", gpuPreference: ["rtx4090"], status: "waiting_for_gpu", confirmedAt: createdAt, createdAt, modelRevision: "civitai-2770795-2771407-v3", width: 1280, height: 720, frames: 81, fps: 16, contentMode: "production", jobForm: "video_from_existing_image", inputImageVerified: true, inputImageJobId: "verified-image" });

async function main() {
  try {
  const first = silent("silent-first", "2026-07-20T00:00:00.000Z");
  const second = silent("silent-second", "2026-07-20T00:01:00.000Z");
  const audible = createGenerationTask({ ...silent("audible", "2026-07-20T00:02:00.000Z"), id: "audible", soundMode: "audible", modelKey: "video_ltx_native_audio", audioOrigin: "local_voice_conditioning", audioBinding: { voiceInferenceJobId: "voice", audioRevisionId: "revision", status: "local_audio_ready", inputAudioSha256: "fixture", inputAudioDurationMs: 5000 } });
  const long = createGenerationTask({ ...silent("long", "2026-07-20T00:03:00.000Z"), id: "long", videoSubtype: "long_video_segment", jobForm: "long_video_segment", longVideoProjectId: "project" });
  const green = createGenerationTask({ ...silent("green", "2026-07-20T00:04:00.000Z"), id: "green", requiredGpuClass: "rtx5090", gpuPreference: ["rtx5090"] });
  upsertGenerationTasks([second, audible, long, first, green], poolPath);
  assert.equal(isManualSilent4090BatchTask(first), true);
  assert.equal(isManualSilent4090BatchTask(audible), false);
  const created = createManualSilent4090Batch(poolPath);
  assert.deepEqual(created.batch.taskIds, ["silent-first", "silent-second"]);
  assert.equal(created.batch.authorizationLimits.maximumEffectiveHourlyUsd, 0.7);
  assert.equal(created.batch.authorizationLimits.maximumSessionSpendUsd, 4.5);
  assert.throws(() => createManualSilent4090Batch(poolPath), /不能重复创建/);
  upsertGenerationTasks([silent("later", "2026-07-20T00:05:00.000Z")], poolPath);
  const restored = readGenerationPool(poolPath).scheduler.manualBatch;
  assert.deepEqual(restored?.taskIds, ["silent-first", "silent-second"]);
  assert.equal(readGenerationPool(poolPath).tasks.find((task) => task.id === "later")?.batchId, null);
  updateManualGpuBatch({ status: "provisioning", providerOrderId: "fake-provider-order" }, poolPath);
  const calls: string[] = [];
  const result = await runManualSilent4090Batch({
    async loadWan22() { calls.push("load"); },
    async runSilentShortVideo(task) {
      calls.push(task.id);
      if (task.id === "silent-second") throw new Error("fake_task_failure");
      return { outputMetadata: { outputPath: `fake/${task.id}.mp4` } };
    },
    async unloadWan22() { calls.push("unload"); },
  }, poolPath);
  assert.deepEqual(calls, ["load", "silent-first", "silent-second", "unload"]);
  assert.deepEqual(result.completedTaskIds, ["silent-first"]);
  assert.deepEqual(result.failedTaskIds, ["silent-second"]);
  const completed = readGenerationPool(poolPath);
  assert.equal(completed.scheduler.manualBatch?.status, "completed");
  assert.equal(completed.scheduler.manualBatch?.completedCount, 1);
  assert.equal(completed.scheduler.manualBatch?.failedCount, 1);
  console.log(JSON.stringify({ ok: true, frozenTaskIds: restored?.taskIds, excluded: ["audible", "long", "green", "later"], order: "oldest_confirmed_first", fakeRuntimeCalls: calls }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
