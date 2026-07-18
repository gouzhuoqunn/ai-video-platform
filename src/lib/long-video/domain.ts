import { randomInt, randomUUID } from "node:crypto";
import { loadProductionVerification } from "@/lib/generation/production-pipeline";

export const LONG_VIDEO_SEGMENT_SECONDS = 5;
export const LONG_VIDEO_REVIEW_SECONDS = 20;
export const LONG_VIDEO_NOTICE = "长视频将分段生成，可能跨多次显卡会话续作。";

export type WorkflowCapability = "first_frame_text" | "first_last_frame" | "text_only";
export type FirstFrameSource = "upload" | "existing_image" | "pure_prompt";
export type LongVideoProjectStatus =
  | "pending_confirmation" | "waiting_for_gpu" | "generating" | "awaiting_review"
  | "paused" | "awaiting_merge_confirmation" | "merging" | "completed" | "cancelled" | "failed";
export type LongVideoSegmentStatus = "pending" | "ready" | "generating" | "awaiting_review" | "accepted" | "invalidated" | "paused" | "failed";
export type LongVideoApprovalState = "not_ready" | "awaiting_review" | "accepted" | "rejected" | "paused" | "timed_out";

export type LongVideoAttempt = {
  id: string;
  number: number;
  generationJobId: string | null;
  status: "pending" | "running" | "awaiting_review" | "accepted" | "rejected" | "invalidated" | "failed";
  sourceWebmRef: string | null;
  outputVideoRef: string | null;
  thumbnailRef: string | null;
  lastFrameRef: string | null;
  evidenceSummary: Record<string, string | number | boolean | null>;
  createdAt: string;
  completedAt: string | null;
};

export type LongVideoSegment = {
  id: string;
  projectId: string;
  sequenceIndex: number;
  startSecond: number;
  endSecond: number;
  prompt: string;
  status: LongVideoSegmentStatus;
  selectedAttemptId: string | null;
  inputFrameRef: string | null;
  outputVideoRef: string | null;
  lastFrameRef: string | null;
  approvalState: LongVideoApprovalState;
  approvalDeadline: string | null;
  generationJobId: string | null;
  attemptsCount: number;
  attempts: LongVideoAttempt[];
  invalidatedAt: string | null;
  nextRequestPrepared: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type LongVideoEstimate = {
  segmentCount: number;
  likelySessions: { min: number; max: number };
  firstFrameMinutes: { min: number; max: number };
  wanRestoreMinutes: { min: number; max: number };
  segmentInferenceMinutes: { min: number; max: number };
  totalMinutes: { min: number; max: number };
  projectedComputeUsd: { min: number; max: number };
  creationFeeCaveat: string;
};

export type LongVideoProject = {
  id: string;
  userId: string;
  title: string;
  overallPrompt: string;
  firstFrameSource: FirstFrameSource;
  firstFrameRef: string | null;
  firstFrameJobId: string | null;
  targetDurationSeconds: number;
  segmentDurationSeconds: 5;
  totalSegments: number;
  status: LongVideoProjectStatus;
  nextSegmentIndex: number;
  gpuPreference: Array<"rtx4090" | "rtx5090">;
  workflowProfile: "wan22-remix-14b-i2v-fp8";
  workflowCapability: WorkflowCapability;
  estimate: LongVideoEstimate;
  finalVideoRef: string | null;
  finalThumbnailRef: string | null;
  mergeStatus: "not_ready" | "awaiting_confirmation" | "merging" | "completed" | "failed";
  cleanupStatus: "not_started" | "pending" | "completed" | "retry";
  segmentMediaCleaned: boolean;
  approximateSpendUsd: number;
  segments: LongVideoSegment[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateLongVideoProjectInput = {
  userId?: string;
  title: string;
  overallPrompt: string;
  firstFrameSource: FirstFrameSource;
  firstFrameRef?: string | null;
  targetDurationSeconds: number;
  prompts: string[];
  gpuPreference?: Array<"rtx4090" | "rtx5090">;
  at?: Date;
};

export const LONG_VIDEO_SESSION_POLICY = {
  maxSessionWallMinutes: 150,
  sessionSpendLimitUsd: 0.75,
  drainingAtMinutes: 135,
  maximumSegmentsPerSession: 12,
  maximumConsecutiveSegments: 4,
  reviewSeconds: LONG_VIDEO_REVIEW_SECONDS,
  resumeFromFirstIncomplete: true,
  keepWanLoadedBetweenSegments: true,
} as const;

export function validateLongVideoDuration(durationSeconds: number) {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 300 || durationSeconds % LONG_VIDEO_SEGMENT_SECONDS !== 0) {
    throw new Error("长视频时长必须是 5～300 秒，并以 5 秒递增。");
  }
  return durationSeconds / LONG_VIDEO_SEGMENT_SECONDS;
}

export function segmentTimeLabel(segment: Pick<LongVideoSegment, "startSecond" | "endSecond">) {
  return `${segment.startSecond + 1}～${segment.endSecond}秒`;
}

export function createSegmentSlots(projectId: string, durationSeconds: number, prompts: string[], at = new Date()) {
  const total = validateLongVideoDuration(durationSeconds);
  if (prompts.length !== total) throw new Error(`需要填写 ${total} 段提示词。`);
  const timestamp = at.toISOString();
  return Array.from({ length: total }, (_, index): LongVideoSegment => ({
    id: randomUUID(),
    projectId,
    sequenceIndex: index,
    startSecond: index * LONG_VIDEO_SEGMENT_SECONDS,
    endSecond: Math.min((index + 1) * LONG_VIDEO_SEGMENT_SECONDS, durationSeconds),
    prompt: String(prompts[index] ?? "").trim().slice(0, 2000),
    status: index === 0 ? "ready" : "pending",
    selectedAttemptId: null,
    inputFrameRef: null,
    outputVideoRef: null,
    lastFrameRef: null,
    approvalState: "not_ready",
    approvalDeadline: null,
    generationJobId: null,
    attemptsCount: 0,
    attempts: [],
    invalidatedAt: null,
    nextRequestPrepared: false,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}

function minuteRange(ms: number, low: number, high: number) {
  return { min: Math.max(1, Math.ceil(ms * low / 60_000)), max: Math.max(1, Math.ceil(ms * high / 60_000)) };
}

export function estimateLongVideo(durationSeconds: number, source: FirstFrameSource, hourlyRange: [number, number] = [0.23, 0.35]): LongVideoEstimate {
  const segmentCount = validateLongVideoDuration(durationSeconds);
  const baseline = loadProductionVerification();
  const sessions = Math.max(1, Math.ceil(segmentCount / LONG_VIDEO_SESSION_POLICY.maximumSegmentsPerSession));
  const firstFrameMs = source === "pure_prompt" ? baseline.restores.imageMs + baseline.image.inferenceMs : 0;
  const wanRestoreMs = sessions * baseline.restores.videoMs;
  const perSegmentMs = baseline.video.inferenceMs + 45_000;
  const totalMs = sessions * 9 * 60_000 + firstFrameMs + wanRestoreMs + segmentCount * perSegmentMs;
  const totalMinutes = minuteRange(totalMs, 0.8, 1.25);
  return {
    segmentCount,
    likelySessions: { min: sessions, max: Math.max(sessions, Math.ceil(segmentCount / Math.max(4, LONG_VIDEO_SESSION_POLICY.maximumSegmentsPerSession - 4))) },
    firstFrameMinutes: firstFrameMs ? minuteRange(firstFrameMs, 0.8, 1.3) : { min: 0, max: 0 },
    wanRestoreMinutes: minuteRange(baseline.restores.videoMs, 0.8, 1.3),
    segmentInferenceMinutes: minuteRange(perSegmentMs, 0.8, 1.3),
    totalMinutes,
    projectedComputeUsd: {
      min: Number((totalMinutes.min / 60 * hourlyRange[0]).toFixed(2)),
      max: Number((totalMinutes.max / 60 * hourlyRange[1]).toFixed(2)),
    },
    creationFeeCaveat: "另有 Clore 创建费、提供商费用与计费取整；这里仅显示计算费范围。",
  };
}

function assertOpaqueReference(value: string | null | undefined, label: string) {
  if (!value) return;
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\/(?:home|root|workspace|tmp)\//.test(value) || value.includes("..")) {
    throw new Error(`${label} 必须使用不含本机绝对路径的安全引用。`);
  }
}

export function createLongVideoProject(input: CreateLongVideoProjectInput): LongVideoProject {
  const totalSegments = validateLongVideoDuration(input.targetDurationSeconds);
  const title = input.title.trim().slice(0, 120);
  const overallPrompt = input.overallPrompt.trim().slice(0, 2000);
  if (!title) throw new Error("请填写长视频标题。");
  if (!overallPrompt) throw new Error("请填写长视频整体提示词。");
  if (!["upload", "existing_image", "pure_prompt"].includes(input.firstFrameSource)) throw new Error("首帧来源无效。");
  if (input.firstFrameSource !== "pure_prompt" && !input.firstFrameRef) throw new Error("请选择或上传首帧图片。");
  assertOpaqueReference(input.firstFrameRef, "首帧引用");
  const at = input.at ?? new Date();
  const projectId = randomUUID();
  const segments = createSegmentSlots(projectId, input.targetDurationSeconds, input.prompts, at);
  segments[0].inputFrameRef = input.firstFrameSource === "pure_prompt" ? null : input.firstFrameRef ?? null;
  const timestamp = at.toISOString();
  return {
    id: projectId,
    userId: input.userId ?? "local_tester",
    title,
    overallPrompt,
    firstFrameSource: input.firstFrameSource,
    firstFrameRef: input.firstFrameSource === "pure_prompt" ? null : input.firstFrameRef ?? null,
    firstFrameJobId: input.firstFrameSource === "pure_prompt" ? randomUUID() : null,
    targetDurationSeconds: input.targetDurationSeconds,
    segmentDurationSeconds: LONG_VIDEO_SEGMENT_SECONDS,
    totalSegments,
    status: "pending_confirmation",
    nextSegmentIndex: 0,
    gpuPreference: input.gpuPreference?.length ? [...new Set(input.gpuPreference)] : ["rtx4090", "rtx5090"],
    workflowProfile: "wan22-remix-14b-i2v-fp8",
    workflowCapability: "first_frame_text",
    estimate: estimateLongVideo(input.targetDurationSeconds, input.firstFrameSource),
    finalVideoRef: null,
    finalThumbnailRef: null,
    mergeStatus: "not_ready",
    cleanupStatus: "not_started",
    segmentMediaCleaned: false,
    approximateSpendUsd: 0,
    segments,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLongVideoSeed() {
  return randomInt(1, 2_147_483_647);
}

export function firstIncompleteSegment(project: LongVideoProject) {
  return project.segments.find((segment) => segment.status !== "accepted") ?? null;
}

export function planLongVideoSession(project: LongVideoProject, options: { elapsedMinutes?: number; spendUsd?: number } = {}) {
  const start = firstIncompleteSegment(project);
  if (!start || project.status === "completed" || project.status === "cancelled") return { segmentIndexes: [], reason: "project_complete", restoreWan: false };
  const remaining = project.segments.filter((segment) => segment.sequenceIndex >= start.sequenceIndex && ["pending", "ready", "invalidated", "paused"].includes(segment.status));
  const elapsed = options.elapsedMinutes ?? 0;
  const spend = options.spendUsd ?? 0;
  if (elapsed >= LONG_VIDEO_SESSION_POLICY.drainingAtMinutes) return { segmentIndexes: [], reason: "session_draining", restoreWan: false };
  if (spend >= LONG_VIDEO_SESSION_POLICY.sessionSpendLimitUsd) return { segmentIndexes: [], reason: "session_spend_limit", restoreWan: false };
  return {
    segmentIndexes: remaining.slice(0, LONG_VIDEO_SESSION_POLICY.maximumSegmentsPerSession).map((segment) => segment.sequenceIndex),
    reason: remaining.length > LONG_VIDEO_SESSION_POLICY.maximumSegmentsPerSession ? "session_chunk_limit" : "all_remaining_fit",
    restoreWan: true,
    keepWanLoaded: true,
    generateFirstFrame: project.firstFrameSource === "pure_prompt" && !project.firstFrameRef && start.sequenceIndex === 0,
  };
}

export function toPublicLongVideoProject(project: LongVideoProject): LongVideoProject {
  const publicProject = structuredClone(project);
  publicProject.firstFrameRef = project.firstFrameRef ? `${project.firstFrameSource}:ready` : null;
  publicProject.finalVideoRef = project.finalVideoRef ? "final:video" : null;
  publicProject.finalThumbnailRef = project.finalThumbnailRef ? "final:thumbnail" : null;
  publicProject.segments = project.segments.map((segment) => ({
    ...structuredClone(segment),
    inputFrameRef: segment.inputFrameRef ? "frame:ready" : null,
    outputVideoRef: segment.outputVideoRef ? `segment:${segment.sequenceIndex}:video` : null,
    lastFrameRef: segment.lastFrameRef ? `segment:${segment.sequenceIndex}:last-frame` : null,
    attempts: segment.attempts.map((attempt) => ({
      ...structuredClone(attempt),
      sourceWebmRef: attempt.sourceWebmRef ? `attempt:${attempt.id}:source` : null,
      outputVideoRef: attempt.outputVideoRef ? `attempt:${attempt.id}:video` : null,
      thumbnailRef: attempt.thumbnailRef ? `attempt:${attempt.id}:thumbnail` : null,
      lastFrameRef: attempt.lastFrameRef ? `attempt:${attempt.id}:last-frame` : null,
    })),
  }));
  return publicProject;
}
