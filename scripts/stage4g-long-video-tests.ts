import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LONG_VIDEO_NOTICE,
  LONG_VIDEO_SESSION_POLICY,
  createLongVideoProject,
  createSegmentSlots,
  estimateLongVideo,
  planLongVideoSession,
  segmentTimeLabel,
  validateLongVideoDuration,
} from "../src/lib/long-video/domain";
import {
  confirmLongVideoProject,
  createLongVideoSegmentTask,
  getLongVideoProject,
  persistLongVideoProject,
  processExpiredLongVideoReviews,
  recordLongVideoFirstFrame,
  recordLongVideoSegmentOutput,
  resetLongVideoStateForTests,
  resumeLongVideoProject,
  reviewLongVideoSegment,
  updateLongVideoSegmentPrompt,
} from "../src/lib/long-video/store";
import { rankTasksForLoadedSession } from "../src/lib/generation/scheduler-policy";
import { readGenerationPool } from "../src/lib/generation/task-pool";
import { WORKFLOW_TEMPLATES } from "../src/lib/generation/workflow-registry";

const root = mkdtempSync(path.join(os.tmpdir(), "stage4g-orchestrator-"));
const statePath = path.join(root, "long-video.json");
const poolPath = path.join(root, "pool.json");

function createExisting(duration = 15) {
  return persistLongVideoProject({
    title: "长视频本地验收",
    overallPrompt: "A cinematic landscape with consistent lighting.",
    firstFrameSource: "existing_image",
    firstFrameRef: "image:verified-local-image",
    targetDurationSeconds: duration,
    prompts: Array.from({ length: duration / 5 }, (_, index) => `Segment ${index + 1} continues the same scene.`),
  }, statePath);
}

try {
  const migration = readFileSync(path.join(process.cwd(), "supabase", "migrations", "0009_long_video_projects.sql"), "utf8");
  for (const required of [
    "create table if not exists public.long_video_projects",
    "create table if not exists public.long_video_segments",
    "create table if not exists public.long_video_segment_attempts",
    "references public.long_video_projects(id)",
    "enable row level security",
    "create_long_video_project",
    "update_long_video_segment_prompt",
    "review_long_video_segment",
    "p_expected_project_version",
    "approval_deadline",
  ]) assert.ok(migration.includes(required), `migration missing ${required}`);
  assert.ok(!migration.match(/\b(drop table|truncate)\b/i), "migration must be additive");

  assert.equal(validateLongVideoDuration(5), 1);
  assert.equal(validateLongVideoDuration(300), 60);
  assert.throws(() => validateLongVideoDuration(7));
  const slots = createSegmentSlots("fixture-project", 15, ["a", "b", "c"], new Date("2026-07-18T00:00:00Z"));
  assert.deepEqual(slots.map(segmentTimeLabel), ["1～5秒", "6～10秒", "11～15秒"]);
  assert.equal(slots[0].status, "ready");
  assert.equal(slots[1].status, "pending");

  for (const source of ["upload", "existing_image", "pure_prompt"] as const) {
    const project = createLongVideoProject({
      title: source,
      overallPrompt: "A production-safe scene.",
      firstFrameSource: source,
      firstFrameRef: source === "upload" ? "upload:11111111-1111-4111-8111-111111111111" : source === "existing_image" ? "image:verified-result" : null,
      targetDurationSeconds: 5,
      prompts: ["Continue the scene."],
    });
    assert.equal(project.firstFrameSource, source);
    assert.equal(project.workflowCapability, "first_frame_text");
    assert.equal(project.firstFrameJobId !== null, source === "pure_prompt");
  }
  assert.deepEqual(WORKFLOW_TEMPLATES.video_i2v.capabilities, ["first_frame_text"]);
  assert.deepEqual(WORKFLOW_TEMPLATES.video_flf2v.capabilities, ["first_last_frame"]);
  assert.ok(LONG_VIDEO_NOTICE.includes("跨多次显卡会话"));

  let project = createExisting();
  project = confirmLongVideoProject(project.id, project.version, { statePath, poolPath });
  let pool = readGenerationPool(poolPath);
  assert.equal(pool.tasks.length, 1);
  assert.equal(pool.tasks[0].jobForm, "long_video_segment");
  assert.equal(pool.tasks[0].longVideoProjectId, project.id);
  assert.equal(pool.tasks[0].longVideoSegmentIndex, 0);
  assert.equal(pool.tasks[0].inputImageJobId, "image:verified-local-image");
  assert.equal(pool.tasks[0].frames, 81, "five-second long-video slots require 81 frames at 16fps");
  assert.equal(pool.tasks[0].fps, 16);
  assert.match(pool.tasks[0].prompt, /Segment 1/);
  assert.match(pool.tasks[0].prompt, /consistent lighting/);
  assert.doesNotMatch(pool.tasks[0].prompt, /Segment 2/);

  const beforeEdit = project;
  project = updateLongVideoSegmentPrompt(project.id, 1, "A safely persisted second prompt.", project.version, project.segments[1].version, statePath);
  assert.equal(project.segments[1].prompt, "A safely persisted second prompt.");
  assert.throws(() => updateLongVideoSegmentPrompt(project.id, 1, "stale", beforeEdit.version, beforeEdit.segments[1].version, statePath), /version_conflict/);
  project = { ...project, segments: project.segments.map((segment, index) => index === 1 ? { ...segment, inputFrameRef: "segment:0:last-frame" } : segment) };
  const secondTask = createLongVideoSegmentTask(project, 1);
  assert.match(secondTask.prompt, /A safely persisted second prompt/);
  assert.match(secondTask.prompt, /consistent lighting/);
  assert.match(secondTask.prompt, /连续/);
  assert.doesNotMatch(secondTask.prompt, /Segment 1 continues/);

  const fakeNow = new Date("2026-07-18T01:00:00Z");
  project = recordLongVideoSegmentOutput({
    projectId: project.id,
    sequenceIndex: 0,
    outputVideoRef: "segment:0:attempt:1:output",
    thumbnailRef: "segment:0:attempt:1:thumbnail",
    lastFrameRef: "segment:0:attempt:1:last-frame",
    expectedProjectVersion: project.version,
    expectedSegmentVersion: project.segments[0].version,
    now: fakeNow,
    filePath: statePath,
  });
  assert.equal(project.status, "awaiting_review");
  assert.equal(project.segments[0].nextRequestPrepared, true);
  assert.equal(project.segments[1].generationJobId, null, "next inference must remain blocked before approval");
  assert.equal(Date.parse(project.segments[0].approvalDeadline!) - fakeNow.getTime(), 20_000);

  const raceVersion = project.version;
  const raceSegmentVersion = project.segments[0].version;
  assert.equal(processExpiredLongVideoReviews(new Date(fakeNow.getTime() + 19_999), statePath), 0);
  assert.equal(processExpiredLongVideoReviews(new Date(fakeNow.getTime() + 20_000), statePath), 1);
  project = getLongVideoProject(project.id, statePath)!;
  assert.equal(project.segments[0].approvalState, "timed_out");
  assert.equal(project.segments[0].status, "accepted");
  assert.equal(project.segments[1].inputFrameRef, "segment:0:attempt:1:last-frame");
  assert.ok(project.segments[1].generationJobId);
  assert.throws(() => reviewLongVideoSegment({
    projectId: project.id,
    sequenceIndex: 0,
    action: "regenerate",
    expectedProjectVersion: raceVersion,
    expectedSegmentVersion: raceSegmentVersion,
    statePath,
    poolPath,
  }), /version_conflict/, "timeout acceptance and regeneration cannot both win");

  project = recordLongVideoSegmentOutput({
    projectId: project.id,
    sequenceIndex: 1,
    outputVideoRef: "segment:1:attempt:1:output",
    thumbnailRef: "segment:1:attempt:1:thumbnail",
    lastFrameRef: "segment:1:attempt:1:last-frame",
    expectedProjectVersion: project.version,
    expectedSegmentVersion: project.segments[1].version,
    now: new Date("2026-07-18T01:01:00Z"),
    filePath: statePath,
  });
  project = reviewLongVideoSegment({
    projectId: project.id,
    sequenceIndex: 1,
    action: "accept",
    expectedProjectVersion: project.version,
    expectedSegmentVersion: project.segments[1].version,
    statePath,
    poolPath,
  });
  assert.equal(project.segments[2].inputFrameRef, "segment:1:attempt:1:last-frame");

  project = reviewLongVideoSegment({
    projectId: project.id,
    sequenceIndex: 0,
    action: "regenerate",
    expectedProjectVersion: project.version,
    expectedSegmentVersion: project.segments[0].version,
    statePath,
    poolPath,
  });
  assert.equal(project.segments[0].status, "ready");
  assert.equal(project.segments[1].status, "invalidated");
  assert.equal(project.segments[2].status, "invalidated");
  assert.equal(project.segments[0].attempts.length, 1, "old attempt history must remain");
  assert.equal(project.segments[0].attempts[0].status, "invalidated");
  assert.equal(project.nextSegmentIndex, 0);

  project = recordLongVideoSegmentOutput({
    projectId: project.id,
    sequenceIndex: 0,
    outputVideoRef: "segment:0:attempt:2:output",
    thumbnailRef: "segment:0:attempt:2:thumbnail",
    lastFrameRef: "segment:0:attempt:2:last-frame",
    expectedProjectVersion: project.version,
    expectedSegmentVersion: project.segments[0].version,
    now: new Date("2026-07-18T01:02:00Z"),
    filePath: statePath,
  });
  project = reviewLongVideoSegment({
    projectId: project.id,
    sequenceIndex: 0,
    action: "pause",
    expectedProjectVersion: project.version,
    expectedSegmentVersion: project.segments[0].version,
    statePath,
    poolPath,
  });
  assert.equal(project.status, "paused");
  project = resumeLongVideoProject(project.id, project.version, { statePath, poolPath });
  assert.equal(project.status, "waiting_for_gpu");
  assert.equal(project.segments[0].attempts.length, 2);

  const purePath = path.join(root, "pure.json");
  const purePool = path.join(root, "pure-pool.json");
  let pure = persistLongVideoProject({
    title: "纯提示词",
    overallPrompt: "Create a safe independent first frame.",
    firstFrameSource: "pure_prompt",
    targetDurationSeconds: 10,
    prompts: ["Move gently.", "Continue smoothly."],
  }, purePath);
  pure = confirmLongVideoProject(pure.id, pure.version, { statePath: purePath, poolPath: purePool });
  pool = readGenerationPool(purePool);
  assert.equal(pool.tasks.length, 1, "pure prompt must generate the first frame before queuing Wan");
  assert.equal(pool.tasks[0].generationType, "image");
  assert.equal(pool.tasks[0].outputMetadata.independentFirstFrameResult, true);
  pure = recordLongVideoFirstFrame(pure.id, "image:independent-ultrareal-result", pure.version, { statePath: purePath, poolPath: purePool });
  pool = readGenerationPool(purePool);
  assert.equal(pool.tasks.filter((task) => task.generationType === "image").length, 1, "initial image must not be regenerated");
  assert.equal(pool.tasks.filter((task) => task.jobForm === "long_video_segment").length, 1);
  assert.equal(pure.segments[0].inputFrameRef, "image:independent-ultrareal-result");

  const large = createLongVideoProject({
    title: "五分钟项目",
    overallPrompt: "A continuous production-safe story.",
    firstFrameSource: "existing_image",
    firstFrameRef: "image:verified",
    targetDurationSeconds: 300,
    prompts: Array.from({ length: 60 }, (_, index) => `Part ${index + 1}.`),
  });
  const sessionPlan = planLongVideoSession(large);
  assert.equal(sessionPlan.segmentIndexes.length, LONG_VIDEO_SESSION_POLICY.maximumSegmentsPerSession);
  assert.equal(sessionPlan.restoreWan, true);
  assert.equal(planLongVideoSession(large, { elapsedMinutes: LONG_VIDEO_SESSION_POLICY.drainingAtMinutes }).reason, "session_draining");
  assert.ok(estimateLongVideo(300, "existing_image").likelySessions.min >= 5);
  assert.equal(estimateLongVideo(10, "pure_prompt").firstFrameMinutes.min > 0, true);

  const tasks = [
    { createdAt: "2026-07-18T00:00:00Z", priority: "normal" as const, modelProfile: "wan22-remix-14b-i2v-fp8", longVideoProjectId: "long-a", id: "active-long" },
    { createdAt: "2026-07-18T00:01:00Z", priority: "immediate" as const, modelProfile: "wan22-remix-14b-i2v-fp8", longVideoProjectId: null, id: "urgent-short" },
    { createdAt: "2026-07-18T00:02:00Z", priority: "normal" as const, modelProfile: "ultrareal-flux1-dev-fp8", longVideoProjectId: null, id: "other" },
  ];
  assert.equal(rankTasksForLoadedSession(tasks, { loadedModels: ["wan22-remix-14b-i2v-fp8"], activeLongVideoProjectId: "long-a", consecutiveLongVideoSegments: 1 })[0].id, "active-long");
  assert.equal(rankTasksForLoadedSession(tasks, { loadedModels: ["wan22-remix-14b-i2v-fp8"], activeLongVideoProjectId: "long-a", consecutiveLongVideoSegments: 4 })[0].id, "urgent-short");

  console.log(JSON.stringify({
    ok: true,
    migration: "additive_rls_rpc_verified",
    labels: slots.map(segmentTimeLabel),
    reviewDeadlineSeconds: 20,
    tailFrameChaining: true,
    downstreamInvalidation: true,
    purePromptIndependentFirstFrame: true,
    maximumSegmentsPerSession: LONG_VIDEO_SESSION_POLICY.maximumSegmentsPerSession,
    fairnessBoundary: LONG_VIDEO_SESSION_POLICY.maximumConsecutiveSegments,
  }, null, 2));
} finally {
  resetLongVideoStateForTests(statePath);
  assert.equal(existsSync(statePath), false);
  rmSync(root, { recursive: true, force: true });
}
