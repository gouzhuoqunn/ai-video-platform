import path from "node:path";
import { mkdirSync } from "node:fs";

export const LEGACY_LOCAL_IMAGE_LIBRARY_DIR = "D:\\AI-Creative-Library";
export const LEGACY_LOCAL_VIDEO_LIBRARY_DIR = "D:\\AI-Video-Library";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{6,120}$/;
const UUID_PATTERN = /^[a-f0-9-]{36}$/;
const MAX_LOCAL_PATH_LENGTH = 240;

function uniqueRoots(roots: Array<string | undefined>) {
  return [...new Set(roots.map((root) => root?.trim()).filter((root): root is string => Boolean(root)))];
}

function assertDate(date: string) {
  if (date !== "YYYY-MM-DD" && !DATE_PATTERN.test(date)) throw new Error("local_data_date_invalid");
}

function assertAssetId(assetId: string) {
  if (!ASSET_ID_PATTERN.test(assetId)) throw new Error("local_data_asset_id_invalid");
}

function assertUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new Error("local_data_uuid_invalid");
}

export function assertSafeLocalPathLength(filePath: string) {
  if (filePath.length > MAX_LOCAL_PATH_LENGTH) throw new Error("local_data_path_too_long");
  return filePath;
}

function checkedPaths<T extends Record<string, string>>(paths: T) {
  Object.values(paths).forEach(assertSafeLocalPathLength);
  return paths;
}

export type LocalDataPaths = {
  localDataRoot: string;
  mediaRoot: string;
  imageMediaRoot: string;
  videoMediaRoot: string;
  voiceRoot: string;
  voiceModelRoot: string;
  gptSoVitsModelRoot: string;
  voicePackRoot: string;
  voiceInferenceRoot: string;
  voiceRuntimeSourceRoot: string;
  voiceRuntimeEnvRoot: string;
  voiceTrainingSourceRoot: string;
  voiceTrainingResultRoot: string;
  workerStateRoot: string;
  voiceLogRoot: string;
  cacheRoot: string;
  tempRoot: string;
  uploadTempRoot: string;
  audioTempRoot: string;
  audioDownloadTempRoot: string;
  downloadTempRoot: string;
  transcodeTempRoot: string;
  logRoot: string;
  migrationRoot: string;
};

export function getLocalDataPaths(configuredRoot = process.env.LOCAL_DATA_ROOT) : LocalDataPaths {
  const localDataRoot = path.resolve(configuredRoot?.trim() || path.join(process.cwd(), "local-data"));
  const mediaRoot = path.join(localDataRoot, "media");
  const voiceRoot = path.join(localDataRoot, "voice");
  const tempRoot = path.join(localDataRoot, "temp");
  return checkedPaths({
    localDataRoot,
    mediaRoot,
    imageMediaRoot: path.join(mediaRoot, "images"),
    videoMediaRoot: path.join(mediaRoot, "videos"),
    voiceRoot,
    voiceModelRoot: path.join(voiceRoot, "base-models"),
    gptSoVitsModelRoot: path.join(voiceRoot, "base-models", "gpt-sovits"),
    voicePackRoot: path.join(voiceRoot, "voice-packs"),
    voiceInferenceRoot: path.join(voiceRoot, "inference"),
    voiceRuntimeSourceRoot: path.join(voiceRoot, "runtime-sources", "gpt-sovits"),
    voiceRuntimeEnvRoot: path.join(voiceRoot, "runtime-envs", "gpt-sovits"),
    voiceTrainingSourceRoot: path.join(voiceRoot, "training-sources"),
    voiceTrainingResultRoot: path.join(voiceRoot, "training-results"),
    workerStateRoot: path.join(voiceRoot, "worker-state"),
    voiceLogRoot: path.join(voiceRoot, "logs"),
    cacheRoot: path.join(localDataRoot, "cache"),
    tempRoot,
    uploadTempRoot: path.join(tempRoot, "uploads"),
    audioTempRoot: path.join(tempRoot, "audio"),
    audioDownloadTempRoot: path.join(tempRoot, "audio-downloads"),
    downloadTempRoot: path.join(tempRoot, "downloads"),
    transcodeTempRoot: path.join(tempRoot, "transcode"),
    logRoot: path.join(localDataRoot, "logs"),
    migrationRoot: path.join(localDataRoot, "migration"),
  });
}

/** Creates only project-owned, ignored local-audio folders; safe to call repeatedly. */
export function ensureLocalAudioDirectories(configuredRoot = process.env.LOCAL_DATA_ROOT) {
  const paths = getLocalDataPaths(configuredRoot);
  const directories = [
    paths.gptSoVitsModelRoot, paths.voiceRuntimeSourceRoot, paths.voiceRuntimeEnvRoot,
    paths.voicePackRoot, paths.voiceInferenceRoot, paths.voiceTrainingSourceRoot,
    paths.workerStateRoot, paths.voiceLogRoot, paths.audioTempRoot, paths.audioDownloadTempRoot,
  ];
  directories.forEach((directory) => mkdirSync(directory, { recursive: true }));
  return { paths, directories };
}

export function getLocalMediaReadRoots() {
  const paths = getLocalDataPaths();
  return {
    imageRoots: uniqueRoots([paths.imageMediaRoot, process.env.LOCAL_IMAGE_LIBRARY_DIR, LEGACY_LOCAL_IMAGE_LIBRARY_DIR]),
    videoRoots: uniqueRoots([paths.videoMediaRoot, process.env.LOCAL_VIDEO_LIBRARY_DIR, LEGACY_LOCAL_VIDEO_LIBRARY_DIR]),
  };
}

export function buildImageMediaPaths(root: string, date: string, sessionId: string) {
  assertDate(date);
  assertAssetId(sessionId);
  const sessionDir = path.join(root, date, sessionId);
  return checkedPaths({
    sessionDir,
    imagePath: path.join(sessionDir, "output.png"),
    thumbnailPath: path.join(sessionDir, "thumbnail.jpg"),
    metadataPath: path.join(sessionDir, "metadata.json"),
    workflowPath: path.join(sessionDir, "workflow-api.json"),
    evidencePath: path.join(sessionDir, "runtime-evidence.json"),
    providerSessionPath: path.join(sessionDir, "provider-session.json"),
    restoreEvidencePath: path.join(sessionDir, "restore-evidence.json"),
  });
}

export function buildShortVideoMediaPaths(root: string, date: string, jobId: string) {
  assertDate(date);
  assertAssetId(jobId);
  const jobDir = path.join(root, date, jobId);
  return checkedPaths({
    jobDir,
    sourceWebmPath: path.join(jobDir, "source.webm"),
    videoPath: path.join(jobDir, "output.mp4"),
    outputWithAudioPath: path.join(jobDir, "output-with-audio.mp4"),
    partialVideoPath: path.join(jobDir, "output.mp4.part"),
    metadataPath: path.join(jobDir, "metadata.json"),
    thumbnailPath: path.join(jobDir, "thumbnail.jpg"),
    workflowPath: path.join(jobDir, "workflow-api.json"),
    runtimeEvidencePath: path.join(jobDir, "runtime-evidence.json"),
    providerSessionPath: path.join(jobDir, "provider-session.json"),
    restoreEvidencePath: path.join(jobDir, "restore-evidence.json"),
  });
}

export function buildLongVideoProjectMediaPaths(root: string, date: string, projectId: string) {
  assertDate(date);
  assertUuid(projectId);
  const projectDir = path.join(root, date, projectId);
  return checkedPaths({
    projectDir,
    projectJson: path.join(projectDir, "project.json"),
    metadataJson: path.join(projectDir, "metadata.json"),
    segmentsDir: path.join(projectDir, "segments"),
    finalVideo: path.join(projectDir, "output.mp4"),
    finalVideoWithAudio: path.join(projectDir, "output-with-audio.mp4"),
    finalVideoPart: path.join(projectDir, "output.mp4.part"),
    master720p: path.join(projectDir, "master-720p.mp4"),
    finalThumbnail: path.join(projectDir, "thumbnail.jpg"),
    mergeEvidence: path.join(projectDir, "merge-evidence.json"),
    concatList: path.join(projectDir, "concat.txt"),
  });
}

export function buildLongVideoSegmentAttemptMediaPaths(projectDir: string, sequenceIndex: number, attemptId: string) {
  if (!Number.isInteger(sequenceIndex) || sequenceIndex < 0) throw new Error("long_video_sequence_invalid");
  assertUuid(attemptId);
  const attemptDir = path.join(projectDir, "segments", String(sequenceIndex).padStart(3, "0"), "attempts", attemptId);
  return checkedPaths({
    attemptDir,
    sourceWebm: path.join(attemptDir, "source.webm"),
    sourceWebmPart: path.join(attemptDir, "source.webm.part"),
    outputMp4: path.join(attemptDir, "output.mp4"),
    outputWithAudio: path.join(attemptDir, "segment-with-audio.mp4"),
    outputMp4Part: path.join(attemptDir, "output.mp4.part"),
    dialogueWav: path.join(attemptDir, "dialogue.wav"),
    thumbnail: path.join(attemptDir, "thumbnail.jpg"),
    lastFrame: path.join(attemptDir, "last-frame.png"),
    lastFramePart: path.join(attemptDir, "last-frame.png.part"),
    workflow: path.join(attemptDir, "workflow-api.json"),
    evidence: path.join(attemptDir, "runtime-evidence.json"),
  });
}

export function buildAudioWorkerPaths() {
  const paths = getLocalDataPaths();
  return {
    queueStatePath: path.join(paths.workerStateRoot, "audio-worker-queue.json"),
    workerStatePath: path.join(paths.workerStateRoot, "audio-worker-state.json"),
    recoveryPath: path.join(paths.workerStateRoot, "audio-worker-recovery.json"),
  };
}

export function buildVoicePackPaths(profileId: string) {
  assertUuid(profileId);
  const paths = getLocalDataPaths();
  const packDir = path.join(paths.voicePackRoot, profileId);
  return checkedPaths({ packDir, manifestPath: path.join(packDir, "manifest.json"), weightsDir: path.join(packDir, "weights") });
}

export function buildVoiceInferencePaths(date: string, inferenceJobId: string) {
  assertDate(date);
  assertUuid(inferenceJobId);
  const paths = getLocalDataPaths();
  const inferenceDir = path.join(paths.voiceInferenceRoot, date, inferenceJobId);
  return checkedPaths({ inferenceDir, audioPath: path.join(inferenceDir, "dialogue.wav"), metadataPath: path.join(inferenceDir, "metadata.json") });
}

export function relativeMediaReference(root: string, filePath: string) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath)).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("local_media_reference_unsafe");
  return relative;
}
