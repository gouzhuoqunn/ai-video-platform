import "server-only";

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  LONG_VIDEO_REVIEW_SECONDS,
  LONG_VIDEO_SEGMENT_SECONDS,
  createLongVideoProject,
  createLongVideoSeed,
  firstIncompleteSegment,
  type CreateLongVideoProjectInput,
  type LongVideoAttempt,
  type LongVideoProject,
} from "./domain";
import {
  createGenerationTask,
  GENERATION_POOL_PATH,
  updateGenerationTasks,
  upsertGenerationTasks,
  type GenerationTask,
} from "@/lib/generation/task-pool";
import { loadProductionVerification } from "@/lib/generation/production-pipeline";
import { PRODUCTION_IMAGE_MODEL, PRODUCTION_VIDEO_MODEL } from "@/lib/generation/production-models";

export type LongVideoState = { schemaVersion: 1; projects: LongVideoProject[] };
export const LONG_VIDEO_STATE_PATH = process.env.LONG_VIDEO_STATE_PATH?.trim() || path.join(process.cwd(), ".secrets", "long-video-state.json");
const scheduledReviews = new Map<string, ReturnType<typeof setTimeout>>();

function timestamp(at = new Date()) { return at.toISOString(); }

function readState(filePath = LONG_VIDEO_STATE_PATH): LongVideoState {
  if (!existsSync(filePath)) return { schemaVersion: 1, projects: [] };
  const value = JSON.parse(readFileSync(filePath, "utf8")) as LongVideoState;
  if (value.schemaVersion !== 1 || !Array.isArray(value.projects)) throw new Error("long_video_state_invalid");
  return value;
}

function writeState(state: LongVideoState, filePath = LONG_VIDEO_STATE_PATH) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.part`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
  return state;
}

function clone<T>(value: T): T { return structuredClone(value); }

function mutateProject(
  projectId: string,
  expectedVersion: number | null,
  mutation: (project: LongVideoProject) => void,
  filePath = LONG_VIDEO_STATE_PATH,
  at = new Date(),
) {
  const state = readState(filePath);
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error("长视频项目不存在。");
  if (expectedVersion !== null && project.version !== expectedVersion) throw new Error("long_video_project_version_conflict");
  mutation(project);
  project.version += 1;
  project.updatedAt = timestamp(at);
  writeState(state, filePath);
  return clone(project);
}

function createFirstFrameTask(project: LongVideoProject): GenerationTask | null {
  if (project.firstFrameSource !== "pure_prompt" || !project.firstFrameJobId || project.firstFrameRef) return null;
  const verification = loadProductionVerification();
  return createGenerationTask({
    id: project.firstFrameJobId,
    generationType: "image",
    jobForm: "image_only",
    prompt: project.overallPrompt,
    modelProfile: PRODUCTION_IMAGE_MODEL,
    modelRevision: verification.imageModel.revision,
    width: 1024,
    height: 1024,
    priority: "immediate",
    status: "waiting_for_batch",
    confirmedAt: timestamp(),
    gpuPreference: project.gpuPreference,
    longVideoProjectId: project.id,
    longVideoSegmentIndex: null,
    outputMetadata: { longVideoProjectId: project.id, independentFirstFrameResult: true },
  });
}

export function createLongVideoSegmentTask(project: LongVideoProject, sequenceIndex: number) {
  const segment = project.segments[sequenceIndex];
  if (!segment) throw new Error("长视频分段不存在。");
  if (sequenceIndex > 0 && !segment.inputFrameRef) throw new Error("上一段尚未确认，不能提交下一段推理。");
  const verification = loadProductionVerification();
  const jobId = segment.generationJobId ?? crypto.randomUUID();
  return createGenerationTask({
    id: jobId,
    generationType: "video",
    jobForm: "long_video_segment",
    prompt: segment.prompt || project.overallPrompt,
    modelProfile: PRODUCTION_VIDEO_MODEL,
    modelRevision: verification.videoModel.revision,
    width: project.gpuPreference[0] === "rtx5090" ? 1280 : 832,
    height: project.gpuPreference[0] === "rtx5090" ? 704 : 480,
    frames: LONG_VIDEO_SEGMENT_SECONDS * 16 + 1,
    fps: 16,
    priority: "immediate",
    status: "waiting_for_batch",
    confirmedAt: timestamp(),
    gpuPreference: project.gpuPreference,
    inputImageJobId: sequenceIndex === 0 && project.firstFrameSource === "pure_prompt" ? project.firstFrameJobId : segment.inputFrameRef,
    inputImageVerified: sequenceIndex > 0 || project.firstFrameSource !== "pure_prompt" || Boolean(project.firstFrameRef),
    longVideoProjectId: project.id,
    longVideoSegmentIndex: sequenceIndex,
    outputMetadata: {
      workflowCapability: project.workflowCapability,
      inputFrameRef: segment.inputFrameRef,
      reuseLoadedWan: true,
    },
  });
}

function queueBoundaryTasks(project: LongVideoProject, filePath?: string) {
  const tasks: GenerationTask[] = [];
  const firstFrame = createFirstFrameTask(project);
  if (firstFrame) tasks.push(firstFrame);
  const segment = firstIncompleteSegment(project);
  const firstFrameDependencyReady = project.firstFrameSource !== "pure_prompt" || Boolean(project.firstFrameRef);
  if (segment && (segment.sequenceIndex > 0 ? Boolean(segment.inputFrameRef) : firstFrameDependencyReady)) {
    const task = createLongVideoSegmentTask(project, segment.sequenceIndex);
    segment.generationJobId = task.id;
    tasks.push(task);
  }
  if (tasks.length) upsertGenerationTasks(tasks, filePath);
  return tasks;
}

export function recordLongVideoFirstFrame(
  projectId: string,
  firstFrameRef: string,
  expectedVersion: number,
  options: { statePath?: string; poolPath?: string } = {},
) {
  if (!firstFrameRef || /^[A-Za-z]:[\\/]/.test(firstFrameRef) || firstFrameRef.includes("..")) throw new Error("首帧结果引用无效。");
  const statePath = options.statePath ?? LONG_VIDEO_STATE_PATH;
  const project = mutateProject(projectId, expectedVersion, (current) => {
    if (current.firstFrameSource !== "pure_prompt" || current.firstFrameRef) throw new Error("项目不需要新的首帧结果。");
    current.firstFrameRef = firstFrameRef;
    current.segments[0].inputFrameRef = firstFrameRef;
    current.segments[0].status = "ready";
    current.segments[0].version += 1;
  }, statePath);
  const tasks = queueBoundaryTasks(project, isolatedPoolPath(statePath, options.poolPath));
  if (!tasks.length) return project;
  return mutateProject(projectId, project.version, (current) => {
    const queued = tasks.find((task) => task.jobForm === "long_video_segment");
    if (queued) current.segments[0].generationJobId = queued.id;
  }, statePath);
}

function isolatedPoolPath(statePath: string, poolPath?: string) {
  return poolPath ?? (statePath === LONG_VIDEO_STATE_PATH ? undefined : `${statePath}.pool.json`);
}

function projectTaskIds(project: LongVideoProject) {
  return [...new Set([
    project.firstFrameJobId,
    ...project.segments.flatMap((segment) => [segment.generationJobId, ...segment.attempts.map((attempt) => attempt.generationJobId)]),
  ].filter((value): value is string => Boolean(value)))];
}

function updateProjectTasks(project: LongVideoProject, action: "cancel" | "delete", poolPath?: string) {
  const taskIds = projectTaskIds(project);
  if (!taskIds.length) return 0;
  updateGenerationTasks(taskIds, action, poolPath ?? GENERATION_POOL_PATH);
  return taskIds.length;
}

export function listLongVideoProjects(filePath = LONG_VIDEO_STATE_PATH) {
  processExpiredLongVideoReviews(new Date(), filePath);
  return readState(filePath).projects.map(clone).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function getLongVideoProject(projectId: string, filePath = LONG_VIDEO_STATE_PATH) {
  processExpiredLongVideoReviews(new Date(), filePath);
  const project = readState(filePath).projects.find((candidate) => candidate.id === projectId);
  return project ? clone(project) : null;
}

export function persistLongVideoProject(input: CreateLongVideoProjectInput, filePath = LONG_VIDEO_STATE_PATH) {
  const state = readState(filePath);
  const project = createLongVideoProject(input);
  state.projects.push(project);
  writeState(state, filePath);
  return clone(project);
}

export function confirmLongVideoProject(projectId: string, expectedVersion: number, options: { statePath?: string; poolPath?: string } = {}) {
  const statePath = options.statePath ?? LONG_VIDEO_STATE_PATH;
  const project = mutateProject(projectId, expectedVersion, (current) => {
    if (current.status !== "pending_confirmation" && current.status !== "paused") throw new Error("项目当前不能确认生成。");
    current.status = "waiting_for_gpu";
    const first = firstIncompleteSegment(current);
    if (first) first.status = "ready";
  }, statePath);
  const tasks = queueBoundaryTasks(project, isolatedPoolPath(statePath, options.poolPath));
  if (tasks.length) {
    return mutateProject(projectId, project.version, (current) => {
      const queued = tasks.find((task) => task.jobForm === "long_video_segment");
      if (queued) current.segments[queued.longVideoSegmentIndex!].generationJobId = queued.id;
    }, statePath);
  }
  return project;
}

export function updateLongVideoSegmentPrompt(
  projectId: string,
  sequenceIndex: number,
  prompt: string,
  expectedProjectVersion: number,
  expectedSegmentVersion: number,
  filePath = LONG_VIDEO_STATE_PATH,
) {
  return mutateProject(projectId, expectedProjectVersion, (project) => {
    const segment = project.segments[sequenceIndex];
    if (!segment || segment.version !== expectedSegmentVersion) throw new Error("long_video_segment_version_conflict");
    if (!["pending", "ready", "invalidated"].includes(segment.status)) throw new Error("这一段已开始生成，不能直接修改提示词。");
    segment.prompt = prompt.trim().slice(0, 2000);
    segment.version += 1;
    segment.updatedAt = timestamp();
  }, filePath);
}

export function recordLongVideoSegmentOutput(input: {
  projectId: string;
  sequenceIndex: number;
  outputVideoRef: string;
  sourceWebmRef?: string | null;
  thumbnailRef: string;
  lastFrameRef: string;
  evidenceSummary?: LongVideoAttempt["evidenceSummary"];
  attemptId?: string;
  now?: Date;
  expectedProjectVersion: number;
  expectedSegmentVersion: number;
  filePath?: string;
}) {
  const at = input.now ?? new Date();
  const project = mutateProject(input.projectId, input.expectedProjectVersion, (current) => {
    const segment = current.segments[input.sequenceIndex];
    if (!segment || segment.version !== input.expectedSegmentVersion) throw new Error("long_video_segment_version_conflict");
    if (!["generating", "ready", "invalidated"].includes(segment.status)) throw new Error("分段当前不能接收新输出。");
    const attemptId = input.attemptId ?? crypto.randomUUID();
    if (!/^[a-f0-9-]{36}$/.test(attemptId)) throw new Error("长视频尝试编号无效。");
    const attempt: LongVideoAttempt = {
      id: attemptId,
      number: segment.attempts.length + 1,
      generationJobId: segment.generationJobId,
      status: "awaiting_review",
      sourceWebmRef: input.sourceWebmRef ?? null,
      outputVideoRef: input.outputVideoRef,
      thumbnailRef: input.thumbnailRef,
      lastFrameRef: input.lastFrameRef,
      evidenceSummary: input.evidenceSummary ?? {},
      createdAt: timestamp(at),
      completedAt: timestamp(at),
    };
    segment.attempts.push(attempt);
    segment.attemptsCount = segment.attempts.length;
    segment.selectedAttemptId = attempt.id;
    segment.outputVideoRef = input.outputVideoRef;
    segment.lastFrameRef = input.lastFrameRef;
    segment.status = "awaiting_review";
    segment.approvalState = "awaiting_review";
    segment.approvalDeadline = new Date(at.getTime() + LONG_VIDEO_REVIEW_SECONDS * 1000).toISOString();
    segment.nextRequestPrepared = input.sequenceIndex + 1 < current.totalSegments;
    segment.version += 1;
    segment.updatedAt = timestamp(at);
    current.status = "awaiting_review";
  }, input.filePath ?? LONG_VIDEO_STATE_PATH, at);
  scheduleLongVideoReview(project.id, input.sequenceIndex, input.filePath ?? LONG_VIDEO_STATE_PATH);
  return project;
}

export function reviewLongVideoSegment(input: {
  projectId: string;
  sequenceIndex: number;
  action: "accept" | "timeout_accept" | "regenerate" | "pause";
  expectedProjectVersion: number;
  expectedSegmentVersion: number;
  now?: Date;
  statePath?: string;
  poolPath?: string;
}) {
  const at = input.now ?? new Date();
  const before = clone(readState(input.statePath ?? LONG_VIDEO_STATE_PATH).projects.find((candidate) => candidate.id === input.projectId) ?? null);
  const invalidatedTaskIds = input.action === "regenerate" && before
    ? projectTaskIds(before).filter((taskId) => before.segments
      .filter((segment) => segment.sequenceIndex >= input.sequenceIndex)
      .some((segment) => segment.generationJobId === taskId || segment.attempts.some((attempt) => attempt.generationJobId === taskId)))
    : [];
  const project = mutateProject(input.projectId, input.expectedProjectVersion, (current) => {
    const segment = current.segments[input.sequenceIndex];
    if (!segment || segment.version !== input.expectedSegmentVersion) throw new Error("long_video_review_version_conflict");
    if (input.action === "accept" || input.action === "timeout_accept") {
      if (segment.status !== "awaiting_review") throw new Error("这一段不在审核中。");
      segment.status = "accepted";
      segment.approvalState = input.action === "timeout_accept" ? "timed_out" : "accepted";
      segment.approvalDeadline = null;
      const selected = segment.attempts.find((attempt) => attempt.id === segment.selectedAttemptId);
      if (selected) selected.status = "accepted";
      const next = current.segments[input.sequenceIndex + 1];
      if (next) {
        if (!segment.lastFrameRef) throw new Error("上一段末帧尚未验证。");
        next.inputFrameRef = segment.lastFrameRef;
        next.status = "ready";
        next.version += 1;
        current.nextSegmentIndex = next.sequenceIndex;
        current.status = "waiting_for_gpu";
      } else {
        current.nextSegmentIndex = current.totalSegments;
        current.status = "awaiting_merge_confirmation";
        current.mergeStatus = "awaiting_confirmation";
      }
    } else if (input.action === "regenerate") {
      for (const downstream of current.segments.filter((candidate) => candidate.sequenceIndex >= input.sequenceIndex)) {
        for (const attempt of downstream.attempts) {
          if (["accepted", "awaiting_review"].includes(attempt.status)) attempt.status = "invalidated";
        }
        downstream.status = downstream.sequenceIndex === input.sequenceIndex ? "ready" : "invalidated";
        downstream.selectedAttemptId = null;
        downstream.outputVideoRef = null;
        downstream.lastFrameRef = null;
        downstream.approvalState = "rejected";
        downstream.approvalDeadline = null;
        downstream.nextRequestPrepared = false;
        downstream.generationJobId = null;
        downstream.invalidatedAt = timestamp(at);
        downstream.version += 1;
      }
      const source = current.segments[input.sequenceIndex];
      source.inputFrameRef = input.sequenceIndex === 0 ? current.firstFrameRef : current.segments[input.sequenceIndex - 1]?.lastFrameRef ?? null;
      current.nextSegmentIndex = input.sequenceIndex;
      current.status = "waiting_for_gpu";
      current.mergeStatus = "not_ready";
      current.finalVideoRef = null;
      current.finalThumbnailRef = null;
    } else {
      if (!["awaiting_review", "ready", "generating"].includes(segment.status)) throw new Error("当前边界不能暂停。");
      segment.status = "paused";
      segment.approvalState = "paused";
      segment.approvalDeadline = null;
      segment.version += 1;
      current.status = "paused";
    }
  }, input.statePath ?? LONG_VIDEO_STATE_PATH, at);
  const timerKey = `${input.statePath ?? LONG_VIDEO_STATE_PATH}:${input.projectId}:${input.sequenceIndex}`;
  const timer = scheduledReviews.get(timerKey);
  if (timer) clearTimeout(timer);
  scheduledReviews.delete(timerKey);
  const poolPath = isolatedPoolPath(input.statePath ?? LONG_VIDEO_STATE_PATH, input.poolPath);
  if (input.action === "pause") updateProjectTasks(project, "cancel", poolPath);
  if (input.action === "regenerate" && invalidatedTaskIds.length) updateGenerationTasks(invalidatedTaskIds, "cancel", poolPath ?? GENERATION_POOL_PATH);
  if (input.action !== "pause") {
    const updated = queueBoundaryTasks(project, poolPath);
    if (updated.length) {
      return mutateProject(project.id, project.version, (current) => {
        const queued = updated.find((task) => task.jobForm === "long_video_segment");
        if (queued) current.segments[queued.longVideoSegmentIndex!].generationJobId = queued.id;
      }, input.statePath ?? LONG_VIDEO_STATE_PATH, at);
    }
  }
  return project;
}

export function resumeLongVideoProject(projectId: string, expectedVersion: number, options: { statePath?: string; poolPath?: string } = {}) {
  const statePath = options.statePath ?? LONG_VIDEO_STATE_PATH;
  const project = mutateProject(projectId, expectedVersion, (current) => {
    if (current.status !== "paused") throw new Error("只有已暂停项目可以继续。");
    const segment = firstIncompleteSegment(current);
    if (!segment) throw new Error("项目没有待继续分段。");
    segment.status = "ready";
    segment.approvalState = "not_ready";
    segment.version += 1;
    current.nextSegmentIndex = segment.sequenceIndex;
    current.status = "waiting_for_gpu";
  }, statePath);
  const tasks = queueBoundaryTasks(project, isolatedPoolPath(statePath, options.poolPath));
  if (!tasks.length) return project;
  return mutateProject(projectId, project.version, (current) => {
    const queued = tasks.find((task) => task.jobForm === "long_video_segment");
    if (queued) current.segments[queued.longVideoSegmentIndex!].generationJobId = queued.id;
  }, statePath);
}

export function cancelLongVideoProject(
  projectId: string,
  expectedVersion: number,
  options: { statePath?: string; poolPath?: string } = {},
) {
  const statePath = options.statePath ?? LONG_VIDEO_STATE_PATH;
  const project = mutateProject(projectId, expectedVersion, (current) => {
    if (current.status === "completed") throw new Error("已完成项目请使用删除。");
    current.status = "cancelled";
  }, statePath);
  updateProjectTasks(project, "cancel", isolatedPoolPath(statePath, options.poolPath));
  return project;
}

export function markLongVideoMergeStarted(projectId: string, expectedVersion: number, filePath = LONG_VIDEO_STATE_PATH) {
  return mutateProject(projectId, expectedVersion, (project) => {
    if (project.status !== "awaiting_merge_confirmation" || project.mergeStatus !== "awaiting_confirmation") throw new Error("所有分段确认后才能合并。");
    if (!project.segments.every((segment) => segment.status === "accepted" && segment.selectedAttemptId && segment.outputVideoRef)) throw new Error("存在未确认或缺少媒体的分段。");
    project.status = "merging";
    project.mergeStatus = "merging";
  }, filePath);
}

export function commitLongVideoMerge(input: {
  projectId: string;
  expectedVersion: number;
  finalVideoRef: string;
  finalThumbnailRef: string;
  actualDurationSeconds: number;
  filePath?: string;
}) {
  return mutateProject(input.projectId, input.expectedVersion, (project) => {
    if (project.status !== "merging" || project.mergeStatus !== "merging") throw new Error("长视频合并事务已改变。");
    project.finalVideoRef = input.finalVideoRef;
    project.finalThumbnailRef = input.finalThumbnailRef;
    project.mergeStatus = "completed";
    project.status = "completed";
    project.cleanupStatus = "pending";
    project.segments.forEach((segment) => {
      const attempt = segment.attempts.find((candidate) => candidate.id === segment.selectedAttemptId);
      if (attempt) attempt.evidenceSummary.actualMergedDurationSeconds = input.actualDurationSeconds;
    });
  }, input.filePath ?? LONG_VIDEO_STATE_PATH);
}

export function completeLongVideoSegmentCleanup(
  projectId: string,
  expectedVersion: number,
  result: { complete: boolean; remainingFiles: number },
  filePath = LONG_VIDEO_STATE_PATH,
) {
  return mutateProject(projectId, expectedVersion, (project) => {
    if (project.mergeStatus !== "completed" || !project.finalVideoRef || !project.finalThumbnailRef) throw new Error("最终媒体尚未提交，不能清理分段。");
    project.segmentMediaCleaned = result.complete;
    project.cleanupStatus = result.complete ? "completed" : "retry";
    project.segments.forEach((segment) => {
      if (result.complete) {
        segment.outputVideoRef = null;
        segment.lastFrameRef = null;
        segment.inputFrameRef = segment.sequenceIndex === 0 ? project.firstFrameRef : null;
      }
      segment.attempts.forEach((attempt) => {
        attempt.evidenceSummary.segmentMediaCleaned = result.complete;
        attempt.evidenceSummary.cleanupRemainingFiles = result.remainingFiles;
        if (result.complete) {
          attempt.sourceWebmRef = null;
          attempt.outputVideoRef = null;
          attempt.thumbnailRef = null;
          attempt.lastFrameRef = null;
        }
      });
    });
  }, filePath);
}

export function markLongVideoMergeFailed(projectId: string, expectedVersion: number, filePath = LONG_VIDEO_STATE_PATH) {
  return mutateProject(projectId, expectedVersion, (project) => {
    project.status = "awaiting_merge_confirmation";
    project.mergeStatus = "failed";
  }, filePath);
}

export function deleteLongVideoProject(projectId: string, expectedVersion: number, filePath = LONG_VIDEO_STATE_PATH) {
  const state = readState(filePath);
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project) return false;
  if (project.version !== expectedVersion) throw new Error("long_video_project_version_conflict");
  state.projects = state.projects.filter((candidate) => candidate.id !== projectId);
  if (!state.projects.length) {
    if (existsSync(filePath)) unlinkSync(filePath);
    return true;
  }
  writeState(state, filePath);
  return true;
}

export function deleteLongVideoProjectTasks(project: LongVideoProject, poolPath = GENERATION_POOL_PATH) {
  return updateProjectTasks(project, "delete", poolPath);
}

export function processExpiredLongVideoReviews(at = new Date(), filePath = LONG_VIDEO_STATE_PATH) {
  const state = readState(filePath);
  const expired = state.projects.flatMap((project) => project.segments
    .filter((segment) => segment.status === "awaiting_review" && segment.approvalDeadline && Date.parse(segment.approvalDeadline) <= at.getTime())
    .map((segment) => ({ projectId: project.id, sequenceIndex: segment.sequenceIndex, projectVersion: project.version, segmentVersion: segment.version })));
  for (const review of expired) {
    try {
      reviewLongVideoSegment({
        ...review,
        expectedProjectVersion: review.projectVersion,
        expectedSegmentVersion: review.segmentVersion,
        action: "timeout_accept",
        now: at,
        statePath: filePath,
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("version_conflict")) throw error;
    }
  }
  return expired.length;
}

export function scheduleLongVideoReview(projectId: string, sequenceIndex: number, filePath = LONG_VIDEO_STATE_PATH) {
  const project = readState(filePath).projects.find((candidate) => candidate.id === projectId);
  const segment = project?.segments[sequenceIndex];
  if (!project || !segment?.approvalDeadline) return;
  const key = `${filePath}:${projectId}:${sequenceIndex}`;
  const previous = scheduledReviews.get(key);
  if (previous) clearTimeout(previous);
  const delay = Math.max(0, Date.parse(segment.approvalDeadline) - Date.now());
  const timer = setTimeout(() => {
    scheduledReviews.delete(key);
    try {
      processExpiredLongVideoReviews(new Date(), filePath);
    } catch {
      // Durable deadline is processed again on the next API read after restart or a transient failure.
    }
  }, Math.min(delay, 2_147_000_000));
  timer.unref?.();
  scheduledReviews.set(key, timer);
}

export function resetLongVideoStateForTests(filePath: string) {
  if (existsSync(filePath)) unlinkSync(filePath);
}

export function longVideoFixtureSeed() {
  return createLongVideoSeed();
}
