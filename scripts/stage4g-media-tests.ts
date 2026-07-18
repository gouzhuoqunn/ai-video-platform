import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createLongVideoProject, type LongVideoProject } from "../src/lib/long-video/domain";
import {
  cleanupLongVideoSegmentMedia,
  mergeLongVideoProjectMedia,
  persistLongVideoSegmentMedia,
} from "../src/lib/long-video/media";

const require = createRequire(import.meta.url);
const ffmpeg = (require("@ffmpeg-installer/ffmpeg") as { path: string }).path;
const root = mkdtempSync(path.join(os.tmpdir(), "stage4g-media-"));
const libraryDir = path.join(root, "library");
const source = path.join(root, "source.webm");

function createFixtureSource() {
  const result = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=16", "-t", "1", "-an", "-c:v", "libvpx-vp9", "-f", "webm", source], { encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, String(result.stderr));
  assert.ok(statSync(source).size > 1024);
}

function prepareProject(idTitle: string, forceFallback = false) {
  const project = createLongVideoProject({ title: idTitle, overallPrompt: "A stable synthetic scene.", firstFrameSource: "existing_image", firstFrameRef: "image:fixture", targetDurationSeconds: 10, prompts: ["First segment.", "Second segment."], at: new Date("2026-07-18T00:00:00Z") });
  const prepared = structuredClone(project) as LongVideoProject;
  prepared.segments.forEach((segment) => {
    const attemptId = randomUUID();
    const media = persistLongVideoSegmentMedia({ project, sequenceIndex: segment.sequenceIndex, attemptId, sourceVideo: source, libraryDir, workflow: { fixture: true } });
    segment.status = "accepted";
    segment.approvalState = "accepted";
    segment.selectedAttemptId = attemptId;
    segment.outputVideoRef = media.outputVideoRef;
    segment.lastFrameRef = media.lastFrameRef;
    segment.attemptsCount = 1;
    segment.attempts = [{ id: attemptId, number: 1, generationJobId: null, status: "accepted", sourceWebmRef: media.sourceWebmRef, outputVideoRef: media.outputVideoRef, thumbnailRef: media.thumbnailRef, lastFrameRef: media.lastFrameRef, evidenceSummary: media.evidenceSummary, createdAt: project.createdAt, completedAt: project.createdAt }];
  });
  prepared.status = "awaiting_merge_confirmation";
  prepared.mergeStatus = "awaiting_confirmation";
  const merged = mergeLongVideoProjectMedia({ project: prepared, libraryDir, forceFallback });
  assert.ok(existsSync(merged.paths.finalVideo));
  assert.ok(existsSync(merged.paths.finalThumbnail));
  assert.equal(merged.evidence.deterministicOrder.join(","), "0,1");
  const cleanup = cleanupLongVideoSegmentMedia(prepared, libraryDir);
  assert.equal(cleanup.complete, true);
  assert.equal(existsSync(merged.paths.segmentsDir), false);
  assert.ok(existsSync(merged.paths.finalVideo));
  return merged.strategy;
}

try {
  createFixtureSource();
  assert.equal(prepareProject("concat-copy"), "concat_copy");
  assert.equal(prepareProject("fallback", true), "h264_fallback");
  console.log(JSON.stringify({ ok: true, atomicSource: true, concatCopy: true, h264Fallback: true, segmentCleanupAfterFinalValidation: true }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
