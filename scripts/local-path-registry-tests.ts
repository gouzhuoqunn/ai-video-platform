import assert from "node:assert/strict";
import path from "node:path";
import {
  assertSafeLocalPathLength,
  buildAudioWorkerPaths,
  buildImageMediaPaths,
  buildLongVideoProjectMediaPaths,
  buildLongVideoSegmentAttemptMediaPaths,
  buildShortVideoMediaPaths,
  buildVoiceInferencePaths,
  buildVoicePackPaths,
  getLocalDataPaths,
  getLocalMediaReadRoots,
  LEGACY_LOCAL_IMAGE_LIBRARY_DIR,
  LEGACY_LOCAL_VIDEO_LIBRARY_DIR,
  relativeMediaReference,
} from "../src/lib/local-data/path-registry";

const root = path.join(process.cwd(), "path-registry-test-root");
const projectId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const paths = getLocalDataPaths(root);
assert.equal(paths.localDataRoot, path.resolve(root));
assert.equal(paths.imageMediaRoot, path.join(paths.localDataRoot, "media", "images"));
assert.equal(paths.videoMediaRoot, path.join(paths.localDataRoot, "media", "videos"));
assert.equal(paths.voiceInferenceRoot, path.join(paths.localDataRoot, "voice", "inference"));
assert.equal(paths.workerStateRoot, path.join(paths.localDataRoot, "worker-state"));

const image = buildImageMediaPaths(paths.imageMediaRoot, "2026-07-20", "image-task-1");
const shortVideo = buildShortVideoMediaPaths(paths.videoMediaRoot, "2026-07-20", "short-video-1");
const project = buildLongVideoProjectMediaPaths(paths.videoMediaRoot, "2026-07-20", projectId);
const segment = buildLongVideoSegmentAttemptMediaPaths(project.projectDir, 0, attemptId);
assert.ok(image.imagePath.endsWith("output.png"));
assert.ok(shortVideo.outputWithAudioPath.endsWith("output-with-audio.mp4"));
assert.ok(project.master720p.endsWith("master-720p.mp4"));
assert.ok(project.finalVideoWithAudio.endsWith("output-with-audio.mp4"));
assert.ok(segment.dialogueWav.endsWith("dialogue.wav"));
assert.ok(segment.outputWithAudio.endsWith("segment-with-audio.mp4"));
assert.ok(buildAudioWorkerPaths().queueStatePath.endsWith("audio-worker-queue.json"));
assert.ok(buildVoicePackPaths(projectId).manifestPath.endsWith("manifest.json"));
assert.ok(buildVoiceInferencePaths("2026-07-20", projectId).audioPath.endsWith("dialogue.wav"));

const roots = getLocalMediaReadRoots();
assert.equal(roots.imageRoots[0], getLocalDataPaths().imageMediaRoot, "new image root must be read first");
assert.equal(roots.videoRoots[0], getLocalDataPaths().videoMediaRoot, "new video root must be read first");
assert.ok(roots.imageRoots.includes(LEGACY_LOCAL_IMAGE_LIBRARY_DIR), "legacy image library must remain readable");
assert.ok(roots.videoRoots.includes(LEGACY_LOCAL_VIDEO_LIBRARY_DIR), "legacy video library must remain readable");
assert.equal(relativeMediaReference(project.projectDir, segment.outputMp4), `segments/000/attempts/${attemptId}/output.mp4`);
assert.throws(() => relativeMediaReference(project.projectDir, path.join(project.projectDir, "..", "outside.mp4")), /unsafe/);
assert.throws(() => assertSafeLocalPathLength("x".repeat(241)), /too_long/);
console.log("Local path registry tests passed.");
