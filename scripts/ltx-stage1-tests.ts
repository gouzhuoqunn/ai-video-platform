import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { confirmGenerationTasks, createNormalJobSet, upsertGenerationTasks, readGenerationPool, setLocalAudioReadiness } from "../src/lib/generation/task-pool";
import { confirmedVideoQueueCounts, defaultGpuExecutionState, recordDeploymentReady } from "../src/lib/generation/gpu-execution-state";
import { VIDEO_PROFILES } from "../src/lib/generation/video-profiles";

const root = mkdtempSync(path.join(os.tmpdir(), "ltx-stage1-"));
const poolPath = path.join(root, "pool.json");

try {
  assert.equal(VIDEO_PROFILES.length, 7);
  assert.deepEqual(VIDEO_PROFILES.filter((profile) => profile.soundMode === "silent").map((profile) => profile.modelKey), Array(4).fill("video_wan_silent"));
  assert.deepEqual(VIDEO_PROFILES.filter((profile) => profile.soundMode === "audible").map((profile) => profile.audioOrigin), Array(3).fill("local_voice_conditioning"));
  const tasks = VIDEO_PROFILES.flatMap((profile) => createNormalJobSet({ jobForm: "video_from_existing_image", prompt: profile.id, sizePreset: profile.id as never, existingImageJobId: "verified-image", existingImageVerified: true, status: "waiting_for_gpu" }));
  upsertGenerationTasks(tasks, poolPath);
  for (const task of tasks) {
    assert.equal(task.audioOrigin, task.soundMode === "audible" ? "local_voice_conditioning" : "none");
    assert.equal(task.modelKey, task.soundMode === "audible" ? "video_ltx_native_audio" : "video_wan_silent");
  }
  const audibleTasks = tasks.filter((task) => task.soundMode === "audible");
  assert.equal(audibleTasks.length, 3);
  assert.ok(audibleTasks.every((task) => task.status === "waiting_for_local_audio"));
  for (const task of audibleTasks) {
    setLocalAudioReadiness(task.id, { status: "local_audio_ready", sha256: "a".repeat(64), durationMs: 5000 }, poolPath);
  }
  confirmGenerationTasks(audibleTasks.map((task) => task.id), "video", poolPath);
  const counts = confirmedVideoQueueCounts(readGenerationPool(poolPath).tasks);
  assert.deepEqual(counts, { silent: { rtx4090: 2, rtx5090: 2 }, audible: { rtx4090: 1, rtx5090: 2 } });
  const deployed = recordDeploymentReady({ ...defaultGpuExecutionState(), activity: "deploying", providerOrderId: "fixture-order", activeExecution: { generationFamily: "video", modelKey: "video_ltx_native_audio", gpuClass: "rtx5090", confirmedTaskIds: [tasks.at(-1)!.id], runtimeSessionId: "fixture-runtime" }, rentedGpuClass: "rtx5090", switchPhase: "deploying" });
  assert.equal(deployed.deployedModel, "video_ltx_native_audio");
  assert.equal(deployed.deployedFamily, "video");
  console.log("LTX Audio-Video Stage 1 tests passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
