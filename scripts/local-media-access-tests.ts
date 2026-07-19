import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildImageMediaPaths, buildShortVideoMediaPaths, relativeMediaReference } from "../src/lib/local-data/path-registry";
import { assertApprovedLocalMediaFile, openLocalFolderAsset } from "../src/lib/local-lab/open-local-folder";
import { findLocalImageResultFile, findLocalResultFile } from "../src/lib/local-lab/local-results";

const root = mkdtempSync(path.join(os.tmpdir(), "local-media-access-"));
const originalDataRoot = process.env.LOCAL_DATA_ROOT;
const originalVideoRoot = process.env.LOCAL_VIDEO_LIBRARY_DIR;
const originalImageRoot = process.env.LOCAL_IMAGE_LIBRARY_DIR;

async function main() {
  try {
  const newRoot = path.join(root, "new");
  const legacyVideoRoot = path.join(root, "legacy-video");
  const legacyImageRoot = path.join(root, "legacy-image");
  process.env.LOCAL_DATA_ROOT = newRoot;
  process.env.LOCAL_VIDEO_LIBRARY_DIR = legacyVideoRoot;
  process.env.LOCAL_IMAGE_LIBRARY_DIR = legacyImageRoot;

  const date = "2026-07-20";
  const jobId = "short-video-1";
  const newVideo = buildShortVideoMediaPaths(path.join(newRoot, "media", "videos"), date, jobId);
  mkdirSync(newVideo.jobDir, { recursive: true });
  writeFileSync(newVideo.videoPath, "silent");
  writeFileSync(newVideo.outputWithAudioPath, "audio");
  assert.equal(findLocalResultFile(jobId, "video")?.filePath, newVideo.outputWithAudioPath, "audio output must win when present");
  unlinkSync(newVideo.outputWithAudioPath);
  assert.equal(findLocalResultFile(jobId, "video")?.filePath, newVideo.videoPath, "silent output must remain playable without audio");

  rmSync(newVideo.videoPath);
  const legacyVideo = buildShortVideoMediaPaths(legacyVideoRoot, date, jobId);
  mkdirSync(legacyVideo.jobDir, { recursive: true });
  writeFileSync(legacyVideo.videoPath, "legacy");
  assert.equal(findLocalResultFile(jobId, "video")?.filePath, legacyVideo.videoPath, "legacy video root must remain readable");

  const image = buildImageMediaPaths(legacyImageRoot, date, "image-task-1");
  mkdirSync(image.sessionDir, { recursive: true });
  writeFileSync(image.imagePath, "png");
  assert.equal(findLocalImageResultFile("image-task-1")?.filePath, image.imagePath, "legacy image root must remain readable");

  assert.equal(assertApprovedLocalMediaFile(legacyVideo.videoPath, [legacyVideoRoot]), legacyVideo.videoPath);
  const outside = path.join(root, "outside.mp4");
  writeFileSync(outside, "outside");
  assert.throws(() => assertApprovedLocalMediaFile(outside, [legacyVideoRoot]), /允许目录/);
  const junction = path.join(legacyVideoRoot, "junction");
  symlinkSync(path.dirname(outside), junction, "junction");
  assert.throws(() => assertApprovedLocalMediaFile(path.join(junction, path.basename(outside)), [legacyVideoRoot]), /允许目录/);
  assert.throws(() => relativeMediaReference(legacyVideo.jobDir, outside), /unsafe/);
  await assert.rejects(() => openLocalFolderAsset({ kind: "image", sessionId: "image-task-1" }, "linux"), /Windows/);

  const longRoute = await import("node:fs").then(({ readFileSync }) => readFileSync("src/app/api/local-lab/long-video/[projectId]/media/[kind]/route.ts", "utf8"));
  assert.ok(longRoute.includes("createReadStream"), "long-video media must stream from disk");
  assert.ok(!longRoute.includes("readFileSync"), "long-video media must not read whole files into memory");
  assert.ok(longRoute.includes("status: 206") && longRoute.includes("status: 416"), "long-video media must retain Range responses");
  console.log("Local media access tests passed.");
  } finally {
    if (originalDataRoot === undefined) delete process.env.LOCAL_DATA_ROOT; else process.env.LOCAL_DATA_ROOT = originalDataRoot;
    if (originalVideoRoot === undefined) delete process.env.LOCAL_VIDEO_LIBRARY_DIR; else process.env.LOCAL_VIDEO_LIBRARY_DIR = originalVideoRoot;
    if (originalImageRoot === undefined) delete process.env.LOCAL_IMAGE_LIBRARY_DIR; else process.env.LOCAL_IMAGE_LIBRARY_DIR = originalImageRoot;
    rmSync(root, { recursive: true, force: true });
  }
}

void main();
