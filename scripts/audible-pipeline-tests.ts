import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { confirmGenerationTasks, createNormalJobSet, readGenerationPool, setLocalAudioReadiness, upsertGenerationTasks } from "../src/lib/generation/task-pool";
import { VIDEO_PROFILES, videoQueueId } from "../src/lib/generation/video-profiles";

const root = mkdtempSync(path.join(os.tmpdir(), "audible-pipeline-"));
const poolPath = path.join(root, "pool.json");

try {
  const silent = VIDEO_PROFILES.filter((profile) => profile.soundMode === "silent");
  const audible = VIDEO_PROFILES.filter((profile) => profile.soundMode === "audible");
  assert.equal(VIDEO_PROFILES.length, 7);
  assert.deepEqual(silent.map((profile) => profile.id), ["low_video_4090", "medium_video_4090", "medium_video_5090", "high_video_5090"]);
  assert.deepEqual(audible.map((profile) => profile.id), ["audible_low_video_4090", "audible_medium_video_5090", "audible_high_video_5090"]);
  assert.ok(audible.every((profile) => profile.audioOrigin === "local_voice_conditioning"));
  assert.deepEqual(audible.map((profile) => videoQueueId(profile.soundMode, profile.gpuClass)), ["audible:rtx4090", "audible:rtx5090", "audible:rtx5090"]);

  const [silentTask] = createNormalJobSet({ jobForm: "video_from_existing_image", prompt: "silent", sizePreset: "low_video_4090", existingImageJobId: "image-verified", existingImageVerified: true });
  const [audibleTask] = createNormalJobSet({ jobForm: "video_from_existing_image", prompt: "audible", sizePreset: "audible_medium_video_5090", existingImageJobId: "image-verified", existingImageVerified: true });
  upsertGenerationTasks([silentTask, audibleTask], poolPath);
  assert.equal(readGenerationPool(poolPath).tasks.find((task) => task.id === audibleTask.id)?.status, "waiting_for_local_audio");
  assert.equal(audibleTask.audioBinding?.status, "waiting_for_local_audio");
  assert.equal(audibleTask.dialogueSnapshot.length, 1);
  assert.throws(() => confirmGenerationTasks([audibleTask.id], "video", poolPath), /本地声音/);

  confirmGenerationTasks([silentTask.id], "video", poolPath);
  setLocalAudioReadiness(audibleTask.id, { status: "local_audio_ready", sha256: "b".repeat(64), durationMs: 5063 }, poolPath);
  confirmGenerationTasks([audibleTask.id], "video", poolPath);
  const confirmed = readGenerationPool(poolPath).tasks.find((task) => task.id === audibleTask.id)!;
  assert.equal(confirmed.status, "waiting_for_gpu");
  assert.deepEqual(confirmed.confirmedAudioRevisionIds, [confirmed.audioBinding!.audioRevisionId]);

  const [failedTask] = createNormalJobSet({ jobForm: "video_from_existing_image", prompt: "failed audio", sizePreset: "audible_low_video_4090", existingImageJobId: "image-verified", existingImageVerified: true });
  upsertGenerationTasks([failedTask], poolPath);
  setLocalAudioReadiness(failedTask.id, { status: "local_audio_failed" }, poolPath);
  assert.throws(() => confirmGenerationTasks([failedTask.id], "video", poolPath), /本地声音/);
  console.log(JSON.stringify({ ok: true, profiles: VIDEO_PROFILES.length, localAudioGate: true, queueMapping: true }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
