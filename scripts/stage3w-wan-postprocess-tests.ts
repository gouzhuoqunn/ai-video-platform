import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { archiveStage3OWanVideo, buildStage3OWanWorkflow, bundledMediaTools, deterministicThumbnailSecond, probeMedia, validateStage3OWanWorkflow } from "./stage3o-wan-executor";
import { STAGE3O_VIDEO_TASK_ID } from "./stage3o-batch";

function success(result: ReturnType<typeof spawnSync>, label: string) {
  assert.equal(result.status, 0, `${label}: ${String(result.stderr ?? result.error?.message ?? "")}`);
}

const root = mkdtempSync(path.join(os.tmpdir(), "stage3w-postprocess-"));
try {
  const { ffmpegPath, ffprobePath } = bundledMediaTools();
  const ffmpegVersion = spawnSync(ffmpegPath, ["-version"], { encoding: "utf8" });
  const ffprobeVersion = spawnSync(ffprobePath, ["-version"], { encoding: "utf8" });
  success(ffmpegVersion, "bundled_ffmpeg_version"); success(ffprobeVersion, "bundled_ffprobe_version");
  assert.match(String(ffmpegVersion.stdout), /^ffmpeg version/i);
  assert.match(String(ffprobeVersion.stdout), /^ffprobe version/i);

  const source = path.join(root, "synthetic.webm");
  success(spawnSync(ffmpegPath, ["-y", "-f", "lavfi", "-i", "testsrc2=size=832x480:rate=16", "-t", "2.0625", "-an", "-c:v", "libvpx-vp9", "-f", "webm", source], { encoding: "utf8", timeout: 120_000 }), "synthetic_webm");
  const sourceBefore = readFileSync(source);
  const workflow = buildStage3OWanWorkflow(); const validation = validateStage3OWanWorkflow(workflow);
  const archived = archiveStage3OWanVideo({ sourceWebm: source, workflow, promptId: "synthetic-stage3w", validation, oomFallbackUsed: false, libraryDir: root, runtimeEvidence: { synthetic: true } });
  assert.equal(archived.sourcePreserved, true); assert.equal(archived.localConversion, true);
  assert.deepEqual(readFileSync(source), sourceBefore, "input source must not be changed");
  assert.ok(statSync(archived.sourcePath).size > 1024); assert.ok(statSync(archived.outputPath).size > 1024); assert.ok(statSync(archived.thumbnailPath).size > 256);
  const mp4 = probeMedia(archived.outputPath); const stream = mp4.streams.find((value) => value.codec_type === "video");
  assert.equal(stream?.codec_name, "h264"); assert.equal(stream?.pix_fmt, "yuv420p");
  assert.equal(readFileSync(archived.outputPath).indexOf(Buffer.from("moov")) < readFileSync(archived.outputPath).indexOf(Buffer.from("mdat")), true);
  const thumbnail = probeMedia(archived.thumbnailPath).streams.find((value) => value.codec_type === "video");
  assert.ok(Number(thumbnail?.width) <= 640 && Number(thumbnail?.height) <= 360);
  const second = deterministicThumbnailSecond(20260715, archived.durationSeconds);
  assert.ok(second >= archived.durationSeconds * 0.1 && second <= archived.durationSeconds * 0.9);
  assert.equal(deterministicThumbnailSecond(20260715, archived.durationSeconds), second);

  const failureRoot = path.join(root, "failure"); const invalidMp4 = path.join(root, "invalid.mp4"); writeFileSync(invalidMp4, "not an mp4");
  assert.throws(() => archiveStage3OWanVideo({ sourceWebm: source, workflow, promptId: "failure-stage3w", validation, oomFallbackUsed: false, libraryDir: failureRoot, preconvertedMp4: invalidMp4 }), /wan_(mp4|ffprobe)/);
  const preservedAfterFailure = path.join(failureRoot, new Date().toISOString().slice(0, 10), STAGE3O_VIDEO_TASK_ID, "source.webm");
  assert.ok(statSync(preservedAfterFailure).size > 1024, "conversion failure must preserve source.webm");
  console.log(JSON.stringify({ stage3w_postprocess_verified: true, ffmpeg: String(ffmpegVersion.stdout).split(/\r?\n/)[0], ffprobe: String(ffprobeVersion.stdout).split(/\r?\n/)[0], source_preserved: true, browser_mp4: true, yuv420p: true, faststart: true, thumbnail_360p: true, deterministic_thumbnail_second: second }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
