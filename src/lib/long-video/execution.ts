import "server-only";

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadProductionVerification } from "@/lib/generation/production-pipeline";
import { buildLongVideoAttemptPaths, buildLongVideoProjectPaths, cleanupLongVideoSegmentMedia, loadLongVideoLibraryDir, mergeLongVideoProjectMedia, persistLongVideoSegmentMedia, probeLongVideoMedia } from "@/lib/long-video/media";
import {
  LONG_VIDEO_SESSION_POLICY,
  type LongVideoProject,
  type LongVideoProjectStatus,
} from "@/lib/long-video/domain";
import {
  getLongVideoProject,
  markLongVideoMergeStarted,
  commitLongVideoMerge,
  completeLongVideoSegmentCleanup,
  deleteLongVideoProjectTasks,
  prepareLongVideoSegmentAttempt,
  recordLongVideoSegmentOutput,
  reviewLongVideoSegment,
  setLongVideoExecutionState,
} from "@/lib/long-video/store";

export type LongVideoExecutionAuthorization = {
  id: string;
  projectId: string;
  provider: "clore";
  gpuProfile: "rtx4090" | "rtx5090";
  oneUse: true;
  expiresAt: string;
  consumedAt?: string | null;
  maxSpendUsd: number;
  releaseHold: boolean;
  maxActiveOrders?: number;
  maxPreSshAttempts?: number;
  maxFailedDeploymentSpendUsd?: number;
  wallClockMinutes?: number;
  drainingAtMinutes?: number;
  maxSegments?: number;
  batchId?: string;
  resolutionNonce?: string;
  allowedTaskIds?: string[];
  maxHourlyUsd?: number;
  maxOrders?: 1;
};

export type LongVideoExecutionPolicy = {
  maxActiveOrders: 1;
  maxSpendUsd: number;
  maxSegmentsPerSession: number;
  maxConsecutiveSegments: number;
  reviewSeconds: number;
};

export const DEFAULT_LONG_VIDEO_EXECUTION_POLICY: LongVideoExecutionPolicy = {
  maxActiveOrders: 1,
  maxSpendUsd: LONG_VIDEO_SESSION_POLICY.sessionSpendLimitUsd,
  maxSegmentsPerSession: LONG_VIDEO_SESSION_POLICY.maximumSegmentsPerSession,
  maxConsecutiveSegments: LONG_VIDEO_SESSION_POLICY.maximumConsecutiveSegments,
  reviewSeconds: LONG_VIDEO_SESSION_POLICY.reviewSeconds,
};

export type LongVideoProviderCandidate = { serverId: string; gpuProfile: string; hourlyUsd: number; vramGb: number };
export type LongVideoProviderSession = { sessionId: string; orderId: string; serverId: string; gpuProfile: "rtx4090" | "rtx5090"; host: string; port: number };
export type LongVideoSegmentMedia = {
  sourceVideo: string;
  workflow?: unknown;
  inputFrameSha256: string;
  previousSegmentId?: string | null;
  previousAttemptId?: string | null;
  previousLastFrameSha256?: string | null;
};
export type LongVideoReviewDecision = "accept" | "timeout_accept" | "regenerate" | "pause";

export interface LongVideoProvider {
  listCandidates(): Promise<LongVideoProviderCandidate[]>;
  activeOrderCount(): Promise<number>;
  createSession(input: { projectId: string; authorization: LongVideoExecutionAuthorization; candidate: LongVideoProviderCandidate }): Promise<LongVideoProviderSession>;
  waitForSsh(session: LongVideoProviderSession): Promise<void>;
  prepareWorkspace(session: LongVideoProviderSession): Promise<void>;
  bootstrapRuntime(session: LongVideoProviderSession): Promise<void>;
  runCanary(session: LongVideoProviderSession): Promise<void>;
  restoreWan(session: LongVideoProviderSession): Promise<{ revision: string; verifiedObjects: number }>;
  generateSegment(input: { session: LongVideoProviderSession; project: LongVideoProject; sequenceIndex: number; attemptId: string; prompt: string; inputFrameRef: string; previousSegmentId: string | null; previousAttemptId: string | null; previousLastFrameSha256: string | null }): Promise<LongVideoSegmentMedia>;
  awaitReview(input: { projectId: string; sequenceIndex: number; deadline: string }): Promise<LongVideoReviewDecision>;
  cancelSession(session: LongVideoProviderSession): Promise<void>;
}

export type LongVideoExecutionSession = {
  schemaVersion: 1;
  projectId: string;
  provider: "clore";
  authorizationId: string;
  orderId: string | null;
  providerSessionId: string | null;
  serverId: string | null;
  gpuProfile: "rtx4090" | "rtx5090";
  runtimeState: "not_started" | "provisioning" | "ssh_ready" | "runtime_ready";
  restoreState: "not_started" | "restoring" | "completed";
  restoreRevision: string | null;
  currentSegmentIndex: number | null;
  currentAttemptId: string | null;
  draining: boolean;
  cleanupState: "not_started" | "pending" | "completed";
  approximateSpendUsd: number;
  resumeReason?: string | null;
  previousSessionId?: string | null;
  resumeFromSegment?: number;
  preservedAcceptedSegmentIds?: string[];
  expectedNewSegmentInferences?: number;
  maxSegments?: number;
  wallClockMinutes?: number;
  drainingAtMinutes?: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type CoordinatorOptions = {
  provider: LongVideoProvider;
  authorization?: LongVideoExecutionAuthorization;
  policy?: Partial<LongVideoExecutionPolicy>;
  statePath?: string;
  sessionPath?: string;
  libraryDir?: string;
  now?: () => Date;
};

export type LongVideoPlan = {
  long_video_executor_ready: boolean;
  real_project_plan_ready: boolean;
  paid_execution_authorized: false;
  projectId: string;
  expectedSequence: number[];
  projectStatus: string;
  gpuProfile: string[];
  sourceValid: boolean;
  promptsDistinct: boolean;
  wanCacheReady: boolean;
  runtimeProfileReady: boolean;
  ffmpegReady: boolean;
  activeOrderCount: number;
  activeAuthorization: boolean;
  estimatedBudgetUsd: { min: number; max: number };
  resume_existing_project: boolean;
  resume_from_segment: number | null;
  accepted_segments: number[];
  segments_to_generate: number[];
  accepted_segments_reused: number;
  expected_new_segment_inferences: number;
  expected_wan_restores: number;
  expected_provider_orders: number;
  segment0_will_not_regenerate: boolean;
  segment0_last_frame_sha256: string | null;
  blockers: string[];
};

function atomicWrite(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.part`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
}

function readSession(filePath: string): LongVideoExecutionSession | null {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8")) as LongVideoExecutionSession;
}

function readConsumedAuthorizations(filePath: string) {
  if (!existsSync(filePath)) return [] as string[];
  const value = JSON.parse(readFileSync(filePath, "utf8")) as { ids?: string[] };
  return Array.isArray(value.ids) ? value.ids : [];
}

function sha256(filePath: string) { return createHash("sha256").update(readFileSync(filePath)).digest("hex"); }
const require = createRequire(import.meta.url);

function resolveProjectRef(project: LongVideoProject, reference: string, libraryDir: string) {
  const paths = buildLongVideoProjectPaths(libraryDir, project.createdAt.slice(0, 10), project.id);
  const resolved = path.resolve(paths.projectDir, reference);
  const relative = path.relative(path.resolve(paths.projectDir), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("long_video_project_reference_invalid");
  return resolved;
}

function inspectPreservedSegmentZero(project: LongVideoProject, libraryDir: string) {
  const segment = project.segments[0];
  const attempt = segment?.selectedAttemptId ? segment.attempts.find((candidate) => candidate.id === segment.selectedAttemptId) : null;
  if (!segment || segment.status !== "accepted" || !attempt || attempt.status !== "accepted" || !attempt.outputVideoRef || !attempt.lastFrameRef) return { valid: false, lastFrameSha256: null };
  try {
    const outputPath = resolveProjectRef(project, attempt.outputVideoRef, libraryDir);
    const lastFramePath = resolveProjectRef(project, attempt.lastFrameRef, libraryDir);
    if (!existsSync(outputPath) || !existsSync(lastFramePath) || statSize(outputPath) < 1024 || statSize(lastFramePath) < 100) return { valid: false, lastFrameSha256: null };
    probeLongVideoMedia(outputPath);
    const signature = readFileSync(lastFramePath).subarray(0, 8);
    if (!signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { valid: false, lastFrameSha256: null };
    const actualSha = sha256(lastFramePath);
    return { valid: actualSha === attempt.evidenceSummary.lastFrameSha256, lastFrameSha256: actualSha };
  } catch {
    return { valid: false, lastFrameSha256: null };
  }
}

function statSize(filePath: string) { return readFileSync(filePath).byteLength; }

function mergePolicy(value?: Partial<LongVideoExecutionPolicy>): LongVideoExecutionPolicy {
  return { ...DEFAULT_LONG_VIDEO_EXECUTION_POLICY, ...value, maxActiveOrders: 1 };
}

function validateAuthorization(projectId: string, authorization: LongVideoExecutionAuthorization, policy: LongVideoExecutionPolicy, now: Date) {
  if (!authorization.oneUse || authorization.projectId !== projectId || authorization.provider !== "clore" || !["rtx4090", "rtx5090"].includes(authorization.gpuProfile)) throw new Error("long_video_authorization_mismatch");
  if (authorization.consumedAt) throw new Error("long_video_authorization_consumed");
  if (Date.parse(authorization.expiresAt) <= now.getTime()) throw new Error("long_video_authorization_expired");
  if (authorization.maxSpendUsd > policy.maxSpendUsd) throw new Error("long_video_authorization_spend_cap_exceeded");
}

export class LongVideoExecutionCoordinator {
  private readonly provider: LongVideoProvider;
  private readonly policy: LongVideoExecutionPolicy;
  private readonly statePath: string;
  private readonly sessionPath: string;
  private readonly libraryDir?: string;
  private readonly now: () => Date;
  private readonly authorizationLedgerPath: string;

  constructor(options: CoordinatorOptions) {
    this.provider = options.provider;
    this.policy = mergePolicy(options.policy);
    this.statePath = options.statePath ?? path.join(process.cwd(), ".secrets", "long-video-state.json");
    this.sessionPath = options.sessionPath ?? path.join(process.cwd(), ".secrets", "long-video-execution.json");
    this.libraryDir = options.libraryDir;
    this.now = options.now ?? (() => new Date());
    this.authorizationLedgerPath = `${this.sessionPath}.authorizations.json`;
  }

  readSession() { return readSession(this.sessionPath); }

  async plan(projectId: string): Promise<LongVideoPlan> {
    const project = getLongVideoProject(projectId, this.statePath);
    const blockers: string[] = [];
    if (!project) blockers.push("project_missing");
    const current = project;
    const acceptedSegments = current?.segments.filter((segment) => segment.status === "accepted").map((segment) => segment.sequenceIndex) ?? [];
    const resumeFromSegment = current && acceptedSegments.length > 0 && current.nextSegmentIndex > 0 ? current.nextSegmentIndex : null;
    const resumeExistingProject = Boolean(current && current.status === "failed" && resumeFromSegment !== null && acceptedSegments.length === resumeFromSegment);
    const segmentsToGenerate = current ? current.segments.filter((segment) => segment.sequenceIndex >= (resumeFromSegment ?? 0) && segment.status !== "accepted").map((segment) => segment.sequenceIndex) : [];
    const preservedSegmentZero = current ? inspectPreservedSegmentZero(current, this.libraryDir ?? loadLongVideoLibraryDir()) : { valid: false, lastFrameSha256: null };
    const verification = (() => { try { return loadProductionVerification(); } catch { return null; } })();
    const sourceValid = Boolean(current?.firstFrameSource === "existing_image" && current.firstFrameRef && current.segments[0]?.inputFrameRef && (!resumeExistingProject || preservedSegmentZero.valid));
    const prompts = current?.segments.map((segment) => segment.prompt.trim()) ?? [];
    const blackwellAcceptance = Boolean(current && current.gpuPreference.length === 1 && current.gpuPreference[0] === "rtx5090" && current.totalSegments === 2);
    const promptsDistinct = prompts.length === (blackwellAcceptance ? 2 : 3) && new Set(prompts).size === prompts.length && prompts.every(Boolean);
    if (current && current.status !== "waiting_for_gpu" && !resumeExistingProject) blockers.push("project_not_waiting_for_gpu");
    if (current && !blackwellAcceptance && (current.gpuPreference.length !== 1 || current.gpuPreference[0] !== "rtx4090")) blockers.push("gpu_preference_not_rtx4090_only");
    if (current && !blackwellAcceptance && current.totalSegments !== 3) blockers.push("expected_three_segments");
    if (!sourceValid) blockers.push("existing_source_invalid");
    if (resumeExistingProject && !preservedSegmentZero.valid) blockers.push("preserved_segment_zero_invalid");
    if (resumeExistingProject && segmentsToGenerate.length !== 2) blockers.push("resume_expected_two_segments");
    if (!promptsDistinct) blockers.push("segment_prompts_not_distinct");
    const activeOrderCount = await this.provider.activeOrderCount();
    if (activeOrderCount !== 0) blockers.push("active_provider_order_exists");
    const session = readSession(this.sessionPath);
    const activeAuthorization = Boolean(session?.active);
    if (activeAuthorization) blockers.push("active_execution_session_exists");
    if (!verification?.videoModel.currentKey) blockers.push("wan_cache_not_ready");
    if (!verification?.runtime?.bootstrapMode) blockers.push("runtime_profile_not_ready");
    const ffmpegReady = (() => { try { return existsSync((require("@ffmpeg-installer/ffmpeg") as { path: string }).path); } catch { return false; } })();
    if (!ffmpegReady) blockers.push("ffmpeg_not_ready");
    const estimate = current?.estimate.projectedComputeUsd ?? { min: 0, max: 0 };
    return {
      long_video_executor_ready: blockers.every((blocker) => !["project_missing", "wan_cache_not_ready", "runtime_profile_not_ready", "ffmpeg_not_ready"].includes(blocker)),
      real_project_plan_ready: blockers.length === 0,
      paid_execution_authorized: false,
      projectId,
      expectedSequence: current?.segments.map((segment) => segment.sequenceIndex) ?? [],
      projectStatus: current?.status ?? "missing",
      gpuProfile: current?.gpuPreference ?? [],
      sourceValid,
      promptsDistinct,
      wanCacheReady: Boolean(verification?.videoModel.currentKey),
      runtimeProfileReady: Boolean(verification?.runtime?.bootstrapMode),
      ffmpegReady,
      activeOrderCount,
      activeAuthorization,
      estimatedBudgetUsd: estimate,
      resume_existing_project: resumeExistingProject,
      resume_from_segment: resumeFromSegment,
      accepted_segments: acceptedSegments,
      segments_to_generate: segmentsToGenerate,
      accepted_segments_reused: acceptedSegments.length,
      expected_new_segment_inferences: segmentsToGenerate.length,
      expected_wan_restores: 1,
      expected_provider_orders: 1,
      segment0_will_not_regenerate: resumeExistingProject && !segmentsToGenerate.includes(0),
      segment0_last_frame_sha256: preservedSegmentZero.lastFrameSha256,
      blockers,
    };
  }

  private saveSession(session: LongVideoExecutionSession) { atomicWrite(this.sessionPath, session); }

  private deleteProjectTasks(project: LongVideoProject) {
    const defaultStatePath = path.resolve(path.join(process.cwd(), ".secrets", "long-video-state.json"));
    const poolPath = path.resolve(this.statePath) === defaultStatePath ? undefined : `${this.statePath}.pool.json`;
    deleteLongVideoProjectTasks(project, poolPath);
  }

  private async transition(project: LongVideoProject, status: LongVideoProjectStatus) {
    return setLongVideoExecutionState(project.id, project.version, status, this.statePath);
  }

  async execute(projectId: string, authorization: LongVideoExecutionAuthorization, options: { resume?: boolean } = {}): Promise<LongVideoExecutionSession> {
    const started = this.now();
    const project = getLongVideoProject(projectId, this.statePath);
    if (!project) throw new Error("project_missing");
    validateAuthorization(projectId, authorization, this.policy, started);
    const plan = await this.plan(projectId);
    if (!plan.real_project_plan_ready) throw new Error(`long_video_plan_blocked:${plan.blockers.join(",")}`);
    if (plan.resume_existing_project && !options.resume) throw new Error("long_video_resume_flag_required");
    if (authorization.maxSegments !== undefined && authorization.maxSegments > this.policy.maxSegmentsPerSession) throw new Error("long_video_authorization_segment_cap_exceeded");
    // The project creation flow leaves a boundary task in the generation pool.
    // Direct real-session execution owns the full sequence, so remove that
    // stale task before provisioning to prevent a second scheduler attempt.
    this.deleteProjectTasks(project);
    const consumed = readConsumedAuthorizations(this.authorizationLedgerPath);
    if (consumed.includes(authorization.id)) throw new Error("long_video_authorization_consumed");
    if (this.readSession()?.active) throw new Error("long_video_active_session_exists");
    const candidates = (await this.provider.listCandidates()).filter((candidate) => candidate.gpuProfile === authorization.gpuProfile && candidate.hourlyUsd >= 0 && candidate.hourlyUsd <= (authorization.gpuProfile === "rtx5090" ? 0.65 : 0.7)).sort((left, right) => left.hourlyUsd - right.hourlyUsd);
    if (!candidates.length) throw new Error(`long_video_no_${authorization.gpuProfile}_candidate`);
    if (await this.provider.activeOrderCount() >= this.policy.maxActiveOrders) throw new Error("long_video_active_order_limit");
    const session: LongVideoExecutionSession = {
      schemaVersion: 1, projectId, provider: "clore", authorizationId: authorization.id, orderId: null, providerSessionId: null,
      serverId: null, gpuProfile: authorization.gpuProfile, runtimeState: "not_started", restoreState: "not_started", restoreRevision: null,
      currentSegmentIndex: null, currentAttemptId: null, draining: false, cleanupState: "not_started", approximateSpendUsd: 0,
      resumeReason: plan.resume_existing_project ? "stage4h5_retry_after_idempotent_review_race" : null,
      previousSessionId: this.readSession()?.providerSessionId ?? null,
      resumeFromSegment: plan.resume_from_segment ?? 0,
      preservedAcceptedSegmentIds: plan.accepted_segments.map((index) => project.segments[index].id),
      expectedNewSegmentInferences: plan.expected_new_segment_inferences,
      maxSegments: authorization.maxSegments ?? this.policy.maxSegmentsPerSession,
      wallClockMinutes: authorization.wallClockMinutes ?? 150,
      drainingAtMinutes: authorization.drainingAtMinutes ?? 135,
      active: true, createdAt: started.toISOString(), updatedAt: started.toISOString(),
    };
    atomicWrite(this.authorizationLedgerPath, { schemaVersion: 1, ids: [...consumed, authorization.id], updatedAt: started.toISOString() });
    this.saveSession(session);
    let providerSession: LongVideoProviderSession | null = null;
    try {
      await this.transition(project, "provisioning");
      let createError: unknown = null;
      for (const candidate of candidates.slice(0, authorization.maxPreSshAttempts ?? 2)) {
        try {
          providerSession = await this.provider.createSession({ projectId, authorization, candidate });
          break;
        } catch (error) {
          createError = error;
        }
      }
      if (!providerSession) throw createError instanceof Error ? createError : new Error("long_video_provider_session_create_failed");
      session.providerSessionId = providerSession.sessionId; session.orderId = providerSession.orderId; session.serverId = providerSession.serverId; session.updatedAt = this.now().toISOString(); this.saveSession(session);
      await this.provider.waitForSsh(providerSession); session.runtimeState = "ssh_ready"; session.updatedAt = this.now().toISOString(); this.saveSession(session); await this.transition(getLongVideoProject(projectId, this.statePath)!, "ssh_ready");
      await this.provider.prepareWorkspace(providerSession); await this.provider.bootstrapRuntime(providerSession); await this.provider.runCanary(providerSession);
      session.runtimeState = "runtime_ready"; session.updatedAt = this.now().toISOString(); this.saveSession(session); await this.transition(getLongVideoProject(projectId, this.statePath)!, "runtime_ready");
      await this.transition(getLongVideoProject(projectId, this.statePath)!, "restoring_video_model"); session.restoreState = "restoring"; this.saveSession(session);
      const restored = await this.provider.restoreWan(providerSession); session.restoreState = "completed"; session.restoreRevision = restored.revision; session.updatedAt = this.now().toISOString(); this.saveSession(session);
      let current = getLongVideoProject(projectId, this.statePath)!;
      let generatedThisSession = 0;
      const hardDeadline = started.getTime() + (authorization.wallClockMinutes ?? 150) * 60_000;
      const drainAt = started.getTime() + (authorization.drainingAtMinutes ?? 135) * 60_000;
      for (let index = current.nextSegmentIndex; index < current.totalSegments; index += 1) {
        if (Date.now() >= hardDeadline) throw new Error("long_video_wall_clock_cap_exceeded");
        if (generatedThisSession >= (authorization.maxSegments ?? this.policy.maxSegmentsPerSession) || Date.now() >= drainAt) { session.draining = true; this.saveSession(session); await this.transition(current, "draining"); break; }
        current = getLongVideoProject(projectId, this.statePath)!;
        const segment = current.segments[index];
        if (segment.status === "accepted") continue;
        const inputFrameRef = segment.inputFrameRef ?? (index === 0 ? current.firstFrameRef : null);
        if (!inputFrameRef) throw new Error("long_video_input_frame_missing");
        const attempt = prepareLongVideoSegmentAttempt({ projectId, sequenceIndex: index, expectedProjectVersion: current.version, expectedSegmentVersion: segment.version, now: this.now(), filePath: this.statePath });
        session.currentSegmentIndex = index; session.currentAttemptId = attempt.segments[index].attempts.at(-1)?.id ?? null; session.updatedAt = this.now().toISOString(); this.saveSession(session);
        const previousSegment = index > 0 ? current.segments[index - 1] : null;
        const previousAttempt = previousSegment?.attempts.find((candidate) => candidate.id === previousSegment.selectedAttemptId) ?? null;
        const previousLastFrameSha256 = typeof previousAttempt?.evidenceSummary.lastFrameSha256 === "string" ? previousAttempt.evidenceSummary.lastFrameSha256 : null;
        const media = await this.provider.generateSegment({ session: providerSession, project: attempt, sequenceIndex: index, attemptId: session.currentAttemptId!, prompt: segment.prompt, inputFrameRef, previousSegmentId: previousSegment?.id ?? null, previousAttemptId: previousAttempt?.id ?? null, previousLastFrameSha256 });
        if (index > 0 && (!previousLastFrameSha256 || media.inputFrameSha256 !== previousLastFrameSha256 || media.previousLastFrameSha256 !== previousLastFrameSha256 || media.previousSegmentId !== previousSegment?.id || media.previousAttemptId !== previousAttempt?.id)) throw new Error("long_video_tail_frame_sha_chain_invalid");
        const persisted = persistLongVideoSegmentMedia({ project: attempt, sequenceIndex: index, attemptId: session.currentAttemptId!, sourceVideo: media.sourceVideo, libraryDir: this.libraryDir, workflow: media.workflow, evidence: { inputFrameSha256: media.inputFrameSha256, previousSegmentId: media.previousSegmentId ?? null, previousAttemptId: media.previousAttemptId ?? null, previousLastFrameSha256: media.previousLastFrameSha256 ?? null } });
        current = getLongVideoProject(projectId, this.statePath)!;
        const recorded = recordLongVideoSegmentOutput({ projectId, sequenceIndex: index, attemptId: session.currentAttemptId!, expectedProjectVersion: current.version, expectedSegmentVersion: current.segments[index].version, outputVideoRef: persisted.outputVideoRef, sourceWebmRef: persisted.sourceWebmRef, thumbnailRef: persisted.thumbnailRef, lastFrameRef: persisted.lastFrameRef, evidenceSummary: { ...persisted.evidenceSummary, inputFrameSha256: media.inputFrameSha256, previousSegmentId: media.previousSegmentId ?? null, previousAttemptId: media.previousAttemptId ?? null, previousLastFrameSha256: media.previousLastFrameSha256 ?? null }, now: this.now(), filePath: this.statePath });
        const decision = await this.provider.awaitReview({ projectId, sequenceIndex: index, deadline: recorded.segments[index].approvalDeadline! });
        current = getLongVideoProject(projectId, this.statePath)!;
        // The expiry worker can accept the boundary between the provider's
        // review poll and this write. Treat an already-accepted segment as
        // the idempotent result instead of submitting a second review action.
        const reviewed = current.segments[index].status === "accepted"
          ? current
          : reviewLongVideoSegment({ projectId, sequenceIndex: index, action: decision, expectedProjectVersion: current.version, expectedSegmentVersion: current.segments[index].version, now: this.now(), statePath: this.statePath });
        if (decision === "pause") { await this.provider.cancelSession(providerSession); session.cleanupState = "completed"; session.active = false; session.updatedAt = this.now().toISOString(); this.saveSession(session); return session; }
        if (decision === "regenerate") { index -= 1; continue; }
        current = reviewed;
        this.deleteProjectTasks(current);
        if (current.segments[index].status === "accepted") generatedThisSession += 1;
      }
      current = getLongVideoProject(projectId, this.statePath)!;
      if (current.status !== "awaiting_merge_confirmation") await this.transition(current, "awaiting_merge_confirmation");
      this.deleteProjectTasks(getLongVideoProject(projectId, this.statePath)!);
      await this.provider.cancelSession(providerSession);
      session.cleanupState = "completed"; session.active = false; session.updatedAt = this.now().toISOString(); this.saveSession(session);
      return session;
    } catch (error) {
      if (providerSession) { try { await this.provider.cancelSession(providerSession); } catch { /* cleanup is retried on resume */ } }
      session.cleanupState = providerSession ? "completed" : "pending"; session.active = false; session.updatedAt = this.now().toISOString(); this.saveSession(session);
      const current = getLongVideoProject(projectId, this.statePath); if (current) { try { await this.transition(current, "failed"); } catch { /* preserve original error */ } }
      throw error;
    }
  }

  async resumeLongVideoExecution(projectId: string) {
    const session = this.readSession();
    if (!session || session.projectId !== projectId) return { recovered: false, reason: "no_session" as const };
    const project = getLongVideoProject(projectId, this.statePath);
    if (!project) throw new Error("project_missing");
    if (!session.active && session.cleanupState === "completed") return { recovered: true, reason: "already_cleaned" as const, project };
    return { recovered: true, reason: "durable_session_present" as const, project, session };
  }

  async mergeAfterConfirmation(projectId: string) {
    const session = this.readSession();
    if (session?.active || session?.cleanupState !== "completed") throw new Error("long_video_provider_cleanup_required_before_merge");
    let project = getLongVideoProject(projectId, this.statePath);
    if (!project || project.status !== "awaiting_merge_confirmation") throw new Error("long_video_merge_confirmation_required");
    project = markLongVideoMergeStarted(projectId, project.version, this.statePath);
    const merged = mergeLongVideoProjectMedia({ project, libraryDir: this.libraryDir });
    project = commitLongVideoMerge({ projectId, expectedVersion: project.version, finalVideoRef: merged.finalVideoRef, finalThumbnailRef: merged.finalThumbnailRef, actualDurationSeconds: Number(merged.evidence.output.durationSeconds), filePath: this.statePath });
    const result = cleanupLongVideoSegmentMedia(project, this.libraryDir);
    return completeLongVideoSegmentCleanup(projectId, project.version, result, this.statePath);
  }
}

export function sha256File(filePath: string) { return sha256(filePath); }
