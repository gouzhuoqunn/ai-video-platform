import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DEFAULT_LOCAL_VIDEO_LIBRARY_DIR, writeJsonAtomic } from "../../../scripts/local-results/config";
import type { LongVideoProject } from "./domain";

const require = createRequire(import.meta.url);
const FFMPEG_PATH = (require("@ffmpeg-installer/ffmpeg") as { path: string }).path;
const FFPROBE_PATH = (require("@ffprobe-installer/ffprobe") as { path: string }).path;
const PROJECT_ID = /^[a-f0-9-]{36}$/;

export type LongVideoMediaProbe = {
  format: { format_name?: string; duration?: string; size?: string; start_time?: string };
  streams: Array<{
    codec_type?: string;
    codec_name?: string;
    pix_fmt?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
  }>;
};

export function loadLongVideoLibraryDir() {
  return process.env.LOCAL_VIDEO_LIBRARY_DIR?.trim() || DEFAULT_LOCAL_VIDEO_LIBRARY_DIR;
}

export function persistLongVideoProjectSnapshot(project: LongVideoProject, libraryDir = loadLongVideoLibraryDir()) {
  const paths = buildLongVideoProjectPaths(libraryDir, project.createdAt.slice(0, 10), project.id);
  mkdirSync(paths.projectDir, { recursive: true });
  writeJsonAtomic(paths.projectJson, project);
  writeJsonAtomic(paths.metadataJson, {
    schemaVersion: 1,
    projectId: project.id,
    title: project.title,
    targetDurationSeconds: project.targetDurationSeconds,
    segmentDurationSeconds: project.segmentDurationSeconds,
    totalSegments: project.totalSegments,
    status: project.status,
    nextSegmentIndex: project.nextSegmentIndex,
    estimate: project.estimate,
    mergeStatus: project.mergeStatus,
    cleanupStatus: project.cleanupStatus,
    updatedAt: project.updatedAt,
  });
  return paths;
}

export function buildLongVideoProjectPaths(libraryDir: string, date: string, projectId: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !PROJECT_ID.test(projectId)) throw new Error("long_video_storage_identifier_invalid");
  const projectDir = path.join(libraryDir, date, projectId);
  return {
    projectDir,
    projectJson: path.join(projectDir, "project.json"),
    metadataJson: path.join(projectDir, "metadata.json"),
    segmentsDir: path.join(projectDir, "segments"),
    finalVideo: path.join(projectDir, "output.mp4"),
    finalVideoPart: path.join(projectDir, "output.mp4.part"),
    finalThumbnail: path.join(projectDir, "thumbnail.jpg"),
    mergeEvidence: path.join(projectDir, "merge-evidence.json"),
    concatList: path.join(projectDir, "concat.txt"),
  };
}

export function buildLongVideoAttemptPaths(projectDir: string, sequenceIndex: number, attemptId: string) {
  if (!Number.isInteger(sequenceIndex) || sequenceIndex < 0 || !PROJECT_ID.test(attemptId)) throw new Error("long_video_attempt_identifier_invalid");
  const attemptDir = path.join(projectDir, "segments", String(sequenceIndex).padStart(3, "0"), "attempts", attemptId);
  return {
    attemptDir,
    sourceWebm: path.join(attemptDir, "source.webm"),
    sourceWebmPart: path.join(attemptDir, "source.webm.part"),
    outputMp4: path.join(attemptDir, "output.mp4"),
    outputMp4Part: path.join(attemptDir, "output.mp4.part"),
    thumbnail: path.join(attemptDir, "thumbnail.jpg"),
    lastFrame: path.join(attemptDir, "last-frame.png"),
    lastFramePart: path.join(attemptDir, "last-frame.png.part"),
    workflow: path.join(attemptDir, "workflow-api.json"),
    evidence: path.join(attemptDir, "runtime-evidence.json"),
  };
}

function assertInside(root: string, filePath: string) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("long_video_media_path_escape");
  return filePath;
}

function command(result: ReturnType<typeof spawnSync>, code: string) {
  if (result.status !== 0) throw new Error(`${code}:${String(result.error?.message ?? result.stderr ?? result.stdout ?? `exit_${result.status}`).slice(-2000)}`);
}

export function probeLongVideoMedia(filePath: string): LongVideoMediaProbe {
  const result = spawnSync(FFPROBE_PATH, ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath], { encoding: "utf8", timeout: 120_000 });
  command(result, "long_video_ffprobe_failed");
  return JSON.parse(String(result.stdout)) as LongVideoMediaProbe;
}

function sha256(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function opaqueRelative(projectDir: string, filePath: string) {
  const relative = path.relative(projectDir, filePath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("long_video_reference_unsafe");
  return relative;
}

export function extractLongVideoLastFrame(inputVideo: string, outputPng: string) {
  mkdirSync(path.dirname(outputPng), { recursive: true });
  const temporary = `${outputPng}.part`;
  rmSync(temporary, { force: true });
  const result = spawnSync(FFMPEG_PATH, ["-y", "-sseof", "-0.08", "-i", inputVideo, "-frames:v", "1", "-c:v", "png", "-f", "image2", temporary], { encoding: "utf8", timeout: 120_000 });
  command(result, "long_video_last_frame_extract_failed");
  if (!existsSync(temporary) || statSync(temporary).size < 100) throw new Error("long_video_last_frame_invalid");
  const signature = readFileSync(temporary).subarray(0, 8);
  if (!signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error("long_video_last_frame_not_png");
  renameSync(temporary, outputPng);
  return { sizeBytes: statSync(outputPng).size, sha256: sha256(outputPng) };
}

export function persistLongVideoSegmentMedia(input: {
  project: LongVideoProject;
  sequenceIndex: number;
  attemptId: string;
  sourceVideo: string;
  libraryDir?: string;
  workflow?: unknown;
  evidence?: Record<string, unknown>;
}) {
  if (!PROJECT_ID.test(input.attemptId)) throw new Error("long_video_attempt_identifier_invalid");
  if (!existsSync(input.sourceVideo) || statSync(input.sourceVideo).size < 1024) throw new Error("long_video_source_invalid");
  const paths = buildLongVideoProjectPaths(input.libraryDir ?? loadLongVideoLibraryDir(), input.project.createdAt.slice(0, 10), input.project.id);
  const attempt = buildLongVideoAttemptPaths(paths.projectDir, input.sequenceIndex, input.attemptId);
  mkdirSync(attempt.attemptDir, { recursive: true });
  rmSync(attempt.sourceWebmPart, { force: true });
  copyFileSync(input.sourceVideo, attempt.sourceWebmPart);
  renameSync(attempt.sourceWebmPart, attempt.sourceWebm);
  rmSync(attempt.outputMp4Part, { force: true });
  const convert = spawnSync(FFMPEG_PATH, [
    "-y", "-i", attempt.sourceWebm, "-map", "0:v:0", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-f", "mp4", attempt.outputMp4Part,
  ], { encoding: "utf8", timeout: 600_000 });
  command(convert, "long_video_segment_conversion_failed");
  if (!existsSync(attempt.outputMp4Part) || statSync(attempt.outputMp4Part).size < 1024) throw new Error("long_video_segment_output_invalid");
  const outputProbe = probeLongVideoMedia(attempt.outputMp4Part);
  videoSignature(outputProbe);
  renameSync(attempt.outputMp4Part, attempt.outputMp4);
  const thumbnailPart = `${attempt.thumbnail}.part`;
  rmSync(thumbnailPart, { force: true });
  const thumbnail = spawnSync(FFMPEG_PATH, ["-y", "-ss", "0.1", "-i", attempt.outputMp4, "-frames:v", "1", "-vf", "scale=640:-2:force_original_aspect_ratio=decrease", "-q:v", "3", "-f", "image2", thumbnailPart], { encoding: "utf8", timeout: 120_000 });
  command(thumbnail, "long_video_segment_thumbnail_failed");
  if (!existsSync(thumbnailPart) || statSync(thumbnailPart).size < 100) throw new Error("long_video_segment_thumbnail_invalid");
  renameSync(thumbnailPart, attempt.thumbnail);
  const lastFrame = extractLongVideoLastFrame(attempt.outputMp4, attempt.lastFrame);
  if (input.workflow !== undefined) writeJsonAtomic(attempt.workflow, input.workflow);
  writeJsonAtomic(attempt.evidence, {
    schemaVersion: 1,
    projectId: input.project.id,
    sequenceIndex: input.sequenceIndex,
    attemptId: input.attemptId,
    source: { sizeBytes: statSync(attempt.sourceWebm).size, sha256: sha256(attempt.sourceWebm) },
    output: { ...lastFrame, sizeBytes: statSync(attempt.outputMp4).size, sha256: sha256(attempt.outputMp4), durationSeconds: Number(outputProbe.format.duration) },
    ...(input.evidence ?? {}),
  });
  return {
    sourceWebmRef: opaqueRelative(paths.projectDir, attempt.sourceWebm),
    outputVideoRef: opaqueRelative(paths.projectDir, attempt.outputMp4),
    thumbnailRef: opaqueRelative(paths.projectDir, attempt.thumbnail),
    lastFrameRef: opaqueRelative(paths.projectDir, attempt.lastFrame),
    evidenceSummary: { durationSeconds: Number(outputProbe.format.duration), outputSha256: sha256(attempt.outputMp4), lastFrameSha256: lastFrame.sha256 },
  };
}

function resolveSegmentFiles(project: LongVideoProject, projectDir: string) {
  return project.segments.map((segment) => {
    if (segment.status !== "accepted" || !segment.selectedAttemptId || !segment.outputVideoRef) throw new Error(`long_video_segment_${segment.sequenceIndex}_not_accepted`);
    const attempt = segment.attempts.find((candidate) => candidate.id === segment.selectedAttemptId);
    const reference = attempt?.outputVideoRef ?? segment.outputVideoRef;
    if (!reference || path.isAbsolute(reference)) throw new Error("long_video_segment_reference_unsafe");
    const filePath = assertInside(projectDir, path.join(projectDir, reference));
    if (!existsSync(filePath) || statSync(filePath).size < 1024) throw new Error(`long_video_segment_${segment.sequenceIndex}_missing`);
    return { segment, attempt, filePath, probe: probeLongVideoMedia(filePath) };
  });
}

function videoSignature(probe: LongVideoMediaProbe) {
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  if (!video?.codec_name || !video.width || !video.height) throw new Error("long_video_segment_video_stream_invalid");
  return [video.codec_name, video.pix_fmt ?? "", video.width, video.height, video.avg_frame_rate ?? video.r_frame_rate ?? ""].join("|");
}

function writeConcatList(filePath: string, files: string[]) {
  const text = files.map((value) => `file '${value.replace(/'/g, "'\\''").replace(/\\/g, "/")}'`).join("\n");
  writeFileSync(filePath, `${text}\n`, { encoding: "utf8", mode: 0o600 });
}

export function mergeLongVideoProjectMedia(input: {
  project: LongVideoProject;
  libraryDir?: string;
  forceFallback?: boolean;
}) {
  const libraryDir = input.libraryDir ?? loadLongVideoLibraryDir();
  const date = input.project.createdAt.slice(0, 10);
  const paths = buildLongVideoProjectPaths(libraryDir, date, input.project.id);
  mkdirSync(paths.projectDir, { recursive: true });
  const selected = resolveSegmentFiles(input.project, paths.projectDir);
  const signatures = selected.map(({ probe }) => videoSignature(probe));
  const copySafe = new Set(signatures).size === 1 && !input.forceFallback;
  writeConcatList(paths.concatList, selected.map((item) => item.filePath));
  rmSync(paths.finalVideoPart, { force: true });
  let strategy: "concat_copy" | "h264_fallback" = "concat_copy";
  if (copySafe) {
    const copy = spawnSync(FFMPEG_PATH, ["-y", "-f", "concat", "-safe", "0", "-i", paths.concatList, "-map", "0:v:0", "-an", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", paths.finalVideoPart], { encoding: "utf8", timeout: 300_000 });
    if (copy.status !== 0) strategy = "h264_fallback";
  } else strategy = "h264_fallback";
  if (strategy === "h264_fallback") {
    rmSync(paths.finalVideoPart, { force: true });
    const fallback = spawnSync(FFMPEG_PATH, [
      "-y", "-f", "concat", "-safe", "0", "-i", paths.concatList, "-map", "0:v:0", "-an",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-f", "mp4", paths.finalVideoPart,
    ], { encoding: "utf8", timeout: 600_000 });
    command(fallback, "long_video_merge_fallback_failed");
  }
  if (!existsSync(paths.finalVideoPart) || statSync(paths.finalVideoPart).size < 1024) throw new Error("long_video_merge_output_invalid");
  const probe = probeLongVideoMedia(paths.finalVideoPart);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const durationSeconds = Number(probe.format.duration);
  const expectedDuration = selected.reduce((sum, item) => sum + Number(item.probe.format.duration ?? 0), 0);
  if (!video?.width || !video.height || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || Math.abs(durationSeconds - expectedDuration) > Math.max(1, selected.length * 0.15)) {
    throw new Error("long_video_merge_validation_failed");
  }
  renameSync(paths.finalVideoPart, paths.finalVideo);
  const thumbnailPart = `${paths.finalThumbnail}.part`;
  rmSync(thumbnailPart, { force: true });
  const thumbnail = spawnSync(FFMPEG_PATH, [
    "-y", "-ss", String(Math.min(Math.max(durationSeconds * 0.1, 0.05), 2)),
    "-i", paths.finalVideo, "-frames:v", "1", "-vf", "scale=640:-2:force_original_aspect_ratio=decrease",
    "-q:v", "3", "-f", "image2", thumbnailPart,
  ], { encoding: "utf8", timeout: 120_000 });
  command(thumbnail, "long_video_thumbnail_failed");
  if (!existsSync(thumbnailPart) || statSync(thumbnailPart).size < 100) throw new Error("long_video_thumbnail_invalid");
  renameSync(thumbnailPart, paths.finalThumbnail);
  const evidence = {
    schemaVersion: 1,
    projectId: input.project.id,
    createdAt: new Date().toISOString(),
    strategy,
    deterministicOrder: selected.map((item) => item.segment.sequenceIndex),
    segmentSignatures: signatures,
    segments: selected.map((item) => ({
      sequenceIndex: item.segment.sequenceIndex,
      attemptId: item.attempt?.id ?? item.segment.selectedAttemptId,
      sizeBytes: statSync(item.filePath).size,
      sha256: sha256(item.filePath),
      durationSeconds: Number(item.probe.format.duration),
    })),
    output: {
      durationSeconds,
      expectedDurationSeconds: expectedDuration,
      width: video.width,
      height: video.height,
      codec: video.codec_name,
      pixelFormat: video.pix_fmt,
      sizeBytes: statSync(paths.finalVideo).size,
      sha256: sha256(paths.finalVideo),
      seekable: Number(probe.format.start_time ?? 0) <= 0.1,
    },
    thumbnail: { sizeBytes: statSync(paths.finalThumbnail).size, sha256: sha256(paths.finalThumbnail) },
  };
  writeJsonAtomic(paths.mergeEvidence, evidence);
  rmSync(paths.concatList, { force: true });
  return {
    paths,
    strategy,
    evidence,
    finalVideoRef: opaqueRelative(paths.projectDir, paths.finalVideo),
    finalThumbnailRef: opaqueRelative(paths.projectDir, paths.finalThumbnail),
  };
}

function countFiles(directory: string): number {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory, { withFileTypes: true }).reduce((count, entry) => count + (entry.isDirectory() ? countFiles(path.join(directory, entry.name)) : 1), 0);
}

export function cleanupLongVideoSegmentMedia(project: LongVideoProject, libraryDir = loadLongVideoLibraryDir()) {
  const paths = buildLongVideoProjectPaths(libraryDir, project.createdAt.slice(0, 10), project.id);
  if (!existsSync(paths.finalVideo) || !existsSync(paths.finalThumbnail) || !existsSync(paths.mergeEvidence)) throw new Error("long_video_final_media_not_committed");
  probeLongVideoMedia(paths.finalVideo);
  try {
    rmSync(paths.segmentsDir, { recursive: true, force: true });
  } catch {
    return { complete: false, remainingFiles: countFiles(paths.segmentsDir) };
  }
  return { complete: !existsSync(paths.segmentsDir), remainingFiles: countFiles(paths.segmentsDir) };
}

export function fastDeleteLongVideoProjectMedia(project: LongVideoProject, libraryDir = loadLongVideoLibraryDir()) {
  const paths = buildLongVideoProjectPaths(libraryDir, project.createdAt.slice(0, 10), project.id);
  if (!existsSync(paths.projectDir)) return { removed: true, residue: 0 };
  const trash = `${paths.projectDir}.delete-${randomUUID()}`;
  renameSync(paths.projectDir, trash);
  try {
    rmSync(trash, { recursive: true, force: true });
    return { removed: true, residue: 0 };
  } catch {
    return { removed: false, residue: countFiles(trash) };
  }
}

export function copyLongVideoSegmentFixture(source: string, destination: string) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  copyFileSync(source, temporary);
  renameSync(temporary, destination);
}
