import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { CloreLongVideoProviderAdapter } from "../src/lib/long-video/clore-adapter";
import {
  LongVideoExecutionCoordinator,
  type LongVideoExecutionAuthorization,
  type LongVideoProvider,
  type LongVideoProviderCandidate,
  type LongVideoProviderSession,
} from "../src/lib/long-video/execution";
import { buildLongVideoProjectPaths, mergeLongVideoProjectMedia, probeLongVideoMedia } from "../src/lib/long-video/media";
import { commitLongVideoMerge, createLongVideoSegmentTask, getLongVideoProject, markLongVideoMergeFailed, markLongVideoMergeStarted } from "../src/lib/long-video/store";
import { readGenerationPool, upsertGenerationTasks } from "../src/lib/generation/task-pool";
import { getGpuProvider } from "./gpu-providers";
import type { GpuCandidate } from "./gpu-providers/types";
import { readCloreSshAuthEvidence, readLastCloreCreateEvidence } from "./gpu-providers/clore";
import { readGpuBillingStatus } from "./gpu-billing-status";
import { buildStage4J2FinalRetryPlan } from "./stage4j2-final-retry-plan";
import { setCloreDeploymentHold } from "./clore/deployment-hold";
import { clearManualParitySecrets } from "./clore/manual-parity";
import { resilientCreateOrder, type ResilientCreateAttempt } from "./clore/resilient-create";
import { LOCAL_WATCHDOG_TASK_NAME } from "./clore/watchdog-io";

const PROJECT_ID = "a6cbf8c1-f158-4583-8f40-fa524dddd9d1";
const SEGMENT_0_ID = "9e5f4d03-5233-4612-a375-01251c9c230a";
const SEGMENT_0_ATTEMPT_ID = "b94faa26-e434-4c38-a67c-bacbb3bd51a6";
const SEGMENT_1_ID = "554adaa8-fc5f-40c3-a02b-331eabcd23c8";
const SEGMENT_1_JOB_ID = "4aef1e01-ec3e-40cb-936d-5b6c1e29d68c";
const SEGMENT_0_MP4_SHA = "4d72d09d12f2bf7a40e6ab49f29cc963e002bcab3d3ec2046126aef2307758d9";
const SEGMENT_0_LAST_FRAME_SHA = "6260f7149b352bb4f337d8ce9a63f16f169e28c61e11052590e653e342cfb77a";
const LIBRARY_DIR = "D:\\AI-Video-Library";
const STATE_PATH = path.join(process.cwd(), ".secrets", "long-video-state.json");
const SESSION_PATH = path.join(process.cwd(), ".secrets", "long-video-execution.json");
const BATCH_PATH = path.join(process.cwd(), ".secrets", "stage4j1-batch.json");
const AUTH_DIR = path.join(process.cwd(), ".secrets", "long-video-authorizations");
const EVIDENCE_PATH = path.join(process.cwd(), ".secrets", "stage4j6-session-evidence.json");
const FAILURE_PATH = path.join(process.cwd(), ".secrets", "stage4j6-session-failure.json");
const CREATE_BUDGET_PATH = path.join(process.cwd(), ".secrets", "stage4j6-create-budget.json");
const FFMPEG_PATH = ffmpegInstaller.path;

type Batch = {
  batchId: string;
  resolutionNonce: string;
  longVideoProjectId: string;
  imageJobs: string[];
  paidExecutionAuthorized: boolean;
  video: { negativePrompt: string; seed: number; segmentPrompts: string[] };
};
type CreateBudget = {
  schemaVersion: 1;
  createRequestCount: number;
  attemptedCandidateIds: string[];
  requestStartedAt: string[];
  attempts: ResilientCreateAttempt[];
};

function sha256(filePath: string) { return createHash("sha256").update(readFileSync(filePath)).digest("hex"); }
function atomicJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const part = `${filePath}.${process.pid}.part`;
  writeFileSync(part, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(part, filePath);
}
function readCreateBudget(): CreateBudget {
  if (!existsSync(CREATE_BUDGET_PATH)) return { schemaVersion: 1, createRequestCount: 0, attemptedCandidateIds: [], requestStartedAt: [], attempts: [] };
  const value = JSON.parse(readFileSync(CREATE_BUDGET_PATH, "utf8")) as CreateBudget;
  if (value.schemaVersion !== 1 || !Number.isInteger(value.createRequestCount) || value.createRequestCount < 0 || value.createRequestCount > 3) {
    throw new Error("stage4j6_create_budget_invalid");
  }
  return value;
}
function requireCommand(result: ReturnType<typeof spawnSync>, code: string) {
  if (result.status !== 0) throw new Error(`${code}:${String(result.error?.message ?? result.stderr ?? result.stdout ?? `exit_${result.status}`).slice(-2000)}`);
}
function runNpm(args: string[], timeoutMs = 180_000) {
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const commandArgs = process.platform === "win32" ? ["/c", "npm", ...args] : args;
  return spawnSync(command, commandArgs, { cwd: process.cwd(), encoding: "utf8", timeout: timeoutMs });
}
function disableLocalWatchdog() {
  if (process.platform === "win32") spawnSync("schtasks.exe", ["/Change", "/TN", LOCAL_WATCHDOG_TASK_NAME, "/Disable"], { encoding: "utf8", timeout: 30_000 });
}
function disarmWatchdogs() {
  try { runNpm(["run", "clore:watchdog:remote:disarm"], 180_000); } finally { disableLocalWatchdog(); }
}
function armWatchdogs(serverId: string) {
  requireCommand(runNpm(["run", "clore:watchdog:local:install"]), "stage4j6_watchdog_install_failed");
  requireCommand(runNpm([
    "run", "clore:watchdog:remote:arm", "--", `--server-id=${serverId}`,
    "--hard-deadline-minutes=120", "--draining-at-minutes=105", "--hard-budget-usd=1.25",
  ], 240_000), "stage4j6_watchdog_arm_failed");
}

function preservedState() {
  const project = getLongVideoProject(PROJECT_ID, STATE_PATH);
  if (!project) throw new Error("stage4j6_project_missing");
  const paths = buildLongVideoProjectPaths(LIBRARY_DIR, project.createdAt.slice(0, 10), project.id);
  const root = path.join(paths.projectDir, "segments", "000", "attempts", SEGMENT_0_ATTEMPT_ID);
  const mp4 = path.join(root, "output.mp4");
  const lastFrame = path.join(root, "last-frame.png");
  const batch = JSON.parse(readFileSync(BATCH_PATH, "utf8")) as Batch;
  const task = readGenerationPool().tasks.find((candidate) => candidate.id === SEGMENT_1_JOB_ID);
  return {
    project, paths, batch, task,
    mp4Valid: existsSync(mp4) && statSync(mp4).size > 1024 && sha256(mp4) === SEGMENT_0_MP4_SHA,
    lastFrameValid: existsSync(lastFrame) && statSync(lastFrame).size > 1024 && sha256(lastFrame) === SEGMENT_0_LAST_FRAME_SHA,
  };
}

function runnerReady() {
  const source = readFileSync(path.join(process.cwd(), "scripts", "comfy-remote-runner.ts"), "utf8");
  return source.includes("COMPLETE_SENTINEL") && source.includes("terminalSentinelCount") &&
    source.includes("fetchAttempt <= 3") && source.includes("</dev/null >/dev/null 2>&1");
}

async function buildPlan(provider = new CloreLongVideoProviderAdapter({ libraryDir: LIBRARY_DIR })) {
  const state = preservedState();
  const identity = buildStage4J2FinalRetryPlan();
  const coordinator = new LongVideoExecutionCoordinator({
    provider, policy: { maxSpendUsd: 1.25, maxSegmentsPerSession: 1, maxConsecutiveSegments: 1 },
    libraryDir: LIBRARY_DIR, statePath: STATE_PATH, sessionPath: SESSION_PATH,
  });
  const resume = await coordinator.plan(PROJECT_ID);
  const segment0 = state.project.segments[0];
  const segment1 = state.project.segments[1];
  const flags = {
    final_video_resume_ready:
      state.project.status === "failed" && state.project.nextSegmentIndex === 1 &&
      state.project.totalSegments === 2 && segment0.id === SEGMENT_0_ID &&
      segment0.status === "accepted" && segment0.attemptsCount === 1 &&
      segment0.selectedAttemptId === SEGMENT_0_ATTEMPT_ID &&
      segment1.id === SEGMENT_1_ID && segment1.status === "ready" &&
      segment1.attemptsCount === 0 && segment1.attempts.length === 0 &&
      segment1.generationJobId === SEGMENT_1_JOB_ID && state.task?.id === SEGMENT_1_JOB_ID &&
      segment1.prompt.trim() === state.batch.video.segmentPrompts[1]?.trim() &&
      state.mp4Valid && state.lastFrameValid && resume.real_project_plan_ready &&
      resume.resume_existing_project && resume.segments_to_generate.join(",") === "1" &&
      identity.canonical_ssh_identity_ready && identity.public_private_fingerprint_match &&
      identity.all_ssh_components_share_identity && identity.global_known_hosts_used === false && runnerReady(),
    project_id: PROJECT_ID,
    remaining_segment_id: SEGMENT_1_ID,
    completed_images_reused: true,
    image_jobs_to_generate: 0,
    image_model_restore_required: false,
    segment_0_reused: true,
    segment_0_inference_required: false,
    segment_0_media_valid: state.mp4Valid,
    segment_0_last_frame_valid: state.lastFrameValid,
    segment_0_attempts: segment0.attemptsCount,
    segment_1_attempts: segment1.attemptsCount,
    segment_1_inference_required: true,
    wan_restore_required: true,
    video_segments_to_generate: resume.segments_to_generate.length,
    short_video_tests: 0,
    expected_provider_orders: 1,
    maximum_create_requests: 3,
    canonical_ssh_identity_ready: identity.canonical_ssh_identity_ready,
    runner_channel_fix_ready: runnerReady(),
    paid_execution_authorized: false,
    provider_mutations: 0,
  };
  const blockers = Object.entries(flags).flatMap(([name, value]) => {
    if (["image_jobs_to_generate", "segment_1_attempts", "short_video_tests", "provider_mutations"].includes(name)) return value === 0 ? [] : [name];
    if (["image_model_restore_required", "segment_0_inference_required", "paid_execution_authorized"].includes(name)) return value === false ? [] : [name];
    if (name === "video_segments_to_generate" || name === "expected_provider_orders" || name === "segment_0_attempts") return value === 1 ? [] : [name];
    if (name === "maximum_create_requests") return value === 3 ? [] : [name];
    if (name.endsWith("_id")) return [];
    return value === true ? [] : [name];
  });
  return { ...flags, segment_0_mp4_sha256: SEGMENT_0_MP4_SHA, segment_0_last_frame_sha256: SEGMENT_0_LAST_FRAME_SHA, resume_plan: resume, blockers };
}

function authorization(batch: Batch): LongVideoExecutionAuthorization {
  return {
    id: randomUUID(), projectId: PROJECT_ID, batchId: batch.batchId, resolutionNonce: batch.resolutionNonce,
    provider: "clore", gpuProfile: "rtx5090", oneUse: true,
    expiresAt: new Date(Date.now() + 120 * 60_000).toISOString(),
    maxSpendUsd: 1.25, walletDeltaCapUsd: 1.25, releaseHold: true,
    maxActiveOrders: 1, maxPreSshAttempts: 1, wallClockMinutes: 120, drainingAtMinutes: 105,
    maxSegments: 1, maxOrders: 1, maxCreateRequests: 3, maxSuccessfulOrders: 1,
    maxHourlyUsd: 0.65, orderType: "on-demand", noReplacementOrder: true,
    executionPurpose: "final_video_resume_resilient",
    allowedTaskIds: [PROJECT_ID, SEGMENT_1_ID], allowedSegmentIds: [SEGMENT_1_ID],
  };
}

function compliant(candidates: GpuCandidate[], excluded = new Set<string>()) {
  return candidates.filter((candidate) =>
    !excluded.has(candidate.id) && /RTX\s*5090/i.test(candidate.gpuType) &&
    candidate.gpuCount === 1 && candidate.minimumRamGb >= 32 && candidate.containerDiskGb >= 120 &&
    candidate.interruptible === false && candidate.hourlyUsd !== null && candidate.hourlyUsd <= 0.65
    && candidate.allowedCurrencies?.includes("USD-Blockchain") === true
  ).sort((left, right) => (left.hourlyUsd ?? Infinity) - (right.hourlyUsd ?? Infinity));
}

function restoreSegmentTask() {
  const project = getLongVideoProject(PROJECT_ID, STATE_PATH);
  if (!project || project.segments[1].attemptsCount !== 0) return;
  const task = createLongVideoSegmentTask(project, 1);
  if (task.id !== SEGMENT_1_JOB_ID) throw new Error("stage4j6_segment_task_id_changed");
  upsertGenerationTasks([task]);
}

function finalizeLocalVideo() {
  let project = getLongVideoProject(PROJECT_ID, STATE_PATH);
  if (!project) throw new Error("stage4j6_project_missing_after_inference");
  project = markLongVideoMergeStarted(project.id, project.version, STATE_PATH);
  try {
    const merged = mergeLongVideoProjectMedia({ project, libraryDir: LIBRARY_DIR });
    const paths = merged.paths;
    const master = path.join(paths.projectDir, "master-720p.mp4");
    copyFileSync(paths.finalVideo, master);
    const masterProbe = probeLongVideoMedia(master);
    const finalPart = `${paths.finalVideo}.stage4j6.part`;
    rmSync(finalPart, { force: true });
    requireCommand(spawnSync(FFMPEG_PATH, [
      "-y", "-i", master, "-vf", "scale=1920:1080:flags=lanczos", "-an", "-c:v", "libx264",
      "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", finalPart,
    ], { encoding: "utf8", timeout: 600_000 }), "stage4j6_1080p_failed");
    rmSync(paths.finalVideo, { force: true }); renameSync(finalPart, paths.finalVideo);
    const finalProbe = probeLongVideoMedia(paths.finalVideo);
    const thumbnailPart = `${paths.finalThumbnail}.stage4j6.part`;
    rmSync(thumbnailPart, { force: true });
    requireCommand(spawnSync(FFMPEG_PATH, [
      "-y", "-ss", "1", "-i", paths.finalVideo, "-frames:v", "1",
      "-vf", "scale=640:-2:force_original_aspect_ratio=decrease", "-q:v", "3", "-f", "image2", thumbnailPart,
    ], { encoding: "utf8", timeout: 120_000 }), "stage4j6_thumbnail_failed");
    rmSync(paths.finalThumbnail, { force: true }); renameSync(thumbnailPart, paths.finalThumbnail);
    const masterVideo = masterProbe.streams.find((stream) => stream.codec_type === "video");
    const finalVideo = finalProbe.streams.find((stream) => stream.codec_type === "video");
    if (masterVideo?.width !== 1280 || masterVideo.height !== 720 || finalVideo?.width !== 1920 || finalVideo.height !== 1080 || finalVideo.pix_fmt !== "yuv420p") {
      throw new Error("stage4j6_final_dimensions_invalid");
    }
    const finalization = {
      generation_resolution: "1280x720", final_resolution: "1920x1080", native_1080p: false,
      segment_order: [0, 1], tail_frame_sha_linkage: SEGMENT_0_LAST_FRAME_SHA,
      master_sha256: sha256(master), final_sha256: sha256(paths.finalVideo),
      finalization_method: "concat_then_deterministic_lanczos_h264_crf18_yuv420p_faststart",
      duration_seconds: Number(finalProbe.format.duration), created_at: new Date().toISOString(),
    };
    atomicJson(path.join(paths.projectDir, "finalization.json"), finalization);
    project = commitLongVideoMerge({
      projectId: project.id, expectedVersion: project.version, finalVideoRef: "output.mp4",
      finalThumbnailRef: "thumbnail.jpg", actualDurationSeconds: Number(finalProbe.format.duration), filePath: STATE_PATH,
    });
    return {
      mergeStrategy: merged.strategy, projectStatus: project.status,
      master720p: { path: master, sha256: finalization.master_sha256, probe: masterProbe },
      final1080p: { path: paths.finalVideo, sha256: finalization.final_sha256, probe: finalProbe },
      thumbnail: paths.finalThumbnail, finalization,
    };
  } catch (error) {
    const current = getLongVideoProject(PROJECT_ID, STATE_PATH);
    if (current?.status === "merging") try { markLongVideoMergeFailed(current.id, current.version, STATE_PATH); } catch { /* preserve original */ }
    throw error;
  }
}

async function execute() {
  const startedAt = new Date().toISOString();
  const state = preservedState();
  process.env.CLORE_ORDER_EXECUTION_ENABLED = "true";
  process.env.CLORE_FIRST_SESSION_MAX_BUDGET_USD = "1.25";
  process.env.CLORE_HARD_SESSION_LIMIT_MINUTES = "120";
  process.env.CLORE_MAX_GPU_PRICE_PER_HOUR = "0.65";
  const createBudget = readCreateBudget();
  let actualCreateRequests = createBudget.createRequestCount;
  let completedCreateRequests = createBudget.createRequestCount;
  const actualCreateStartedAt: string[] = [...createBudget.requestStartedAt];
  const gpu = getGpuProvider("clore");
  const adapter = new CloreLongVideoProviderAdapter({
    gpu, libraryDir: LIBRARY_DIR, statePath: STATE_PATH,
    videoNegativePrompt: state.batch.video.negativePrompt, videoSeedBase: state.batch.video.seed,
    beforeCreateRequest: () => {
      if (actualCreateRequests >= 3) throw new Error("stage4j6_create_request_cap_reached");
      actualCreateRequests += 1; actualCreateStartedAt.push(new Date().toISOString());
      atomicJson(CREATE_BUDGET_PATH, {
        ...createBudget,
        createRequestCount: actualCreateRequests,
        attemptedCandidateIds: [...new Set([...createBudget.attemptedCandidateIds, captured.selected?.id].filter((value): value is string => Boolean(value)))],
        requestStartedAt: actualCreateStartedAt,
      });
    },
    afterCreateRequestAttempt: () => { completedCreateRequests += 1; },
  });
  const gate = await buildPlan(adapter);
  if (!gate.final_video_resume_ready || gate.blockers.length) throw new Error(`stage4j6_plan_blocked:${gate.blockers.join(",")}`);
  const before = await readGpuBillingStatus();
  const walletBefore = await gpu.getBalance();
  if (before.clore.activeOrders !== 0 || before.runpod.activePods !== 0 || before.runpod.networkVolumes !== 0 ||
      !before.holds.clore || !before.holds.runpod || before.watchdogs.remoteArmed || before.watchdogs.scheduledTaskActive ||
      before.createLockPresent || walletBefore.availableUsd === null) throw new Error("stage4j6_zero_state_changed");
  const initial = compliant(await gpu.listCandidates({ forceRefresh: true }), new Set(createBudget.attemptedCandidateIds))[0];
  if (!initial || initial.hourlyUsd === null) throw new Error("stage4j6_no_compliant_rtx5090");
  const auth = authorization(state.batch);
  const authPath = path.join(AUTH_DIR, `${auth.id}.json`);
  atomicJson(authPath, auth);
  const captured: {
    providerSession: LongVideoProviderSession | null; selected: GpuCandidate | null; createAttempts: ResilientCreateAttempt[];
    ssh: unknown; blackwell: unknown; wanRestores: number; inferences: number; review: string | null; canceledAt: string | null;
  } = { providerSession: null, selected: null, createAttempts: [...createBudget.attempts], ssh: null, blackwell: null, wanRestores: 0, inferences: 0, review: null, canceledAt: null };
  let watchdogArmed = false;
  try {
    const delegated: LongVideoProvider = {
      listCandidates: async () => [{ serverId: initial.id, gpuProfile: "rtx5090", hourlyUsd: initial.hourlyUsd!, vramGb: initial.vramGb }],
      activeOrderCount: () => adapter.activeOrderCount(),
      createSession: async () => {
        const resilient = await resilientCreateOrder<GpuCandidate, LongVideoProviderSession>({
          maximumCreateRequests: 3 - createBudget.createRequestCount,
          selectFreshCandidate: async (attempted) => {
            const billing = await readGpuBillingStatus();
            const wallet = await gpu.getBalance();
            if (billing.clore.activeOrders !== 0 || wallet.availableUsd === null) throw new Error("stage4j6_active_order_or_wallet_changed");
            return compliant(await gpu.listCandidates({ forceRefresh: true }), new Set([...createBudget.attemptedCandidateIds, ...attempted]))[0] ?? null;
          },
          activeOrderCount: async () => (await readGpuBillingStatus()).clore.activeOrders,
          create: async (candidate) => {
            captured.selected = candidate;
            armWatchdogs(candidate.id); watchdogArmed = true;
            const selected: LongVideoProviderCandidate = { serverId: candidate.id, gpuProfile: "rtx5090", hourlyUsd: candidate.hourlyUsd!, vramGb: candidate.vramGb };
            const session = await adapter.createSession({ projectId: PROJECT_ID, authorization: auth, candidate: selected });
            captured.providerSession = session;
            captured.ssh = readCloreSshAuthEvidence();
            return { orderId: session.orderId, value: session };
          },
          reconcile: async () => {
            const recovered = await gpu.recoverExistingSession();
            if (!recovered) return null;
            const session: LongVideoProviderSession = {
              sessionId: `lv-${PROJECT_ID.slice(0, 8)}-reconciled`, orderId: recovered.id,
              serverId: captured.selected?.id ?? "", gpuProfile: "rtx5090",
              host: recovered.target?.host ?? "", port: recovered.target?.port ?? 0,
            };
            captured.providerSession = session;
            return { orderId: recovered.id, value: session };
          },
          onAttempt: async (attempt) => {
            captured.createAttempts.push(attempt);
            atomicJson(CREATE_BUDGET_PATH, {
              schemaVersion: 1,
              createRequestCount: actualCreateRequests,
              attemptedCandidateIds: [...new Set([...createBudget.attemptedCandidateIds, ...captured.createAttempts.map((item) => item.candidateId)])],
              requestStartedAt: actualCreateStartedAt,
              attempts: captured.createAttempts,
            });
            if (attempt.result === "failed_request") { disarmWatchdogs(); watchdogArmed = false; }
          },
        });
        if (resilient.successfulOrderCount !== 1 || resilient.activeOrderCount !== 1 || actualCreateRequests > 3) throw new Error("stage4j6_order_counter_invalid");
        return resilient.order.value as LongVideoProviderSession;
      },
      waitForSsh: (session) => adapter.waitForSsh(session),
      prepareWorkspace: (session) => adapter.prepareWorkspace(session),
      bootstrapRuntime: async (session) => {
        await adapter.bootstrapRuntime(session);
        captured.blackwell = JSON.parse(readFileSync(path.join(process.cwd(), ".secrets", "stage4j3-blackwell-evidence.json"), "utf8"));
      },
      runCanary: (session) => adapter.runCanary(session),
      restoreWan: async (session) => {
        captured.wanRestores += 1; if (captured.wanRestores > 1) throw new Error("stage4j6_duplicate_wan_restore");
        return adapter.restoreWan(session);
      },
      generateSegment: async (input) => {
        captured.inferences += 1;
        if (input.sequenceIndex !== 1 || captured.inferences > 1) throw new Error("stage4j6_unexpected_inference");
        return adapter.generateSegment(input);
      },
      awaitReview: async (input) => { const decision = await adapter.awaitReview(input); captured.review = decision; return decision; },
      cancelSession: async (session) => {
        try { await adapter.cancelSession(session); } finally {
          captured.canceledAt = new Date().toISOString();
          disarmWatchdogs(); watchdogArmed = false;
        }
      },
    };
    const coordinator = new LongVideoExecutionCoordinator({
      provider: delegated, policy: { maxSpendUsd: 1.25, maxSegmentsPerSession: 1, maxConsecutiveSegments: 1 },
      libraryDir: LIBRARY_DIR, statePath: STATE_PATH, sessionPath: SESSION_PATH,
    });
    const execution = await coordinator.execute(PROJECT_ID, auth, { resume: true });
    const inferred = getLongVideoProject(PROJECT_ID, STATE_PATH)!;
    const segment1 = inferred.segments[1];
    if (captured.wanRestores !== 1 || captured.inferences !== 1 || segment1.status !== "accepted" || segment1.attemptsCount !== 1 || !segment1.selectedAttemptId) {
      throw new Error("stage4j6_segment1_incomplete");
    }
    const zeroFirst = await readGpuBillingStatus();
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const zeroSecond = await readGpuBillingStatus();
    if (zeroFirst.clore.activeOrders !== 0 || zeroSecond.clore.activeOrders !== 0) throw new Error("stage4j6_cancel_not_confirmed");
    const walletAfter = await gpu.getBalance();
    const walletDelta = Number(((walletBefore.availableUsd ?? 0) - (walletAfter.availableUsd ?? 0)).toFixed(4));
    if (walletAfter.availableUsd === null || walletDelta > 1.25) throw new Error("stage4j6_wallet_cap_exceeded");
    const finalMedia = finalizeLocalVideo();
    const completed = getLongVideoProject(PROJECT_ID, STATE_PATH)!;
    const attempt = completed.segments[1].attempts.find((item) => item.id === completed.segments[1].selectedAttemptId)!;
    const evidence = {
      schemaVersion: 1, stage: "4J.6", startedAt, completedAt: new Date().toISOString(), gate,
      stage4j5Diagnostic: {
        httpStatus: 500, code: 6, error: null, message: null, details: null, requestId: null,
        classification: "unknown_code6", fullPayloadRecoverable: false,
        reason: "Stage 4J.5 client discarded provider error fields before persistence.",
      },
      authorization: {
        id: auth.id, projectId: auth.projectId, allowedSegmentIds: auth.allowedSegmentIds,
        maxCreateRequests: auth.maxCreateRequests, maxSuccessfulOrders: auth.maxSuccessfulOrders,
        maxActiveOrders: auth.maxActiveOrders, maxHourlyUsd: auth.maxHourlyUsd,
        walletDeltaCapUsd: auth.walletDeltaCapUsd, wallClockMinutes: auth.wallClockMinutes,
        drainingAtMinutes: auth.drainingAtMinutes,
      },
      create: {
        actualCreateRequests, completedCreateRequests, actualCreateStartedAt,
        candidateAttempts: captured.createAttempts, lastProviderEvidence: readLastCloreCreateEvidence(),
        successfulOrderCount: captured.providerSession ? 1 : 0,
      },
      wallet: { beforeUsd: walletBefore.availableUsd, afterUsd: walletAfter.availableUsd, deltaUsd: walletDelta },
      order: {
        orderId: captured.providerSession?.orderId, serverId: captured.providerSession?.serverId,
        endpoint: captured.providerSession ? `${captured.providerSession.host}:${captured.providerSession.port}` : null,
        hourlyUsd: captured.selected?.hourlyUsd, ramGb: captured.selected?.minimumRamGb,
        diskGb: captured.selected?.containerDiskGb, canceledAt: captured.canceledAt,
      },
      ssh: captured.ssh, blackwell: captured.blackwell,
      wan: { restores: captured.wanRestores, revision: execution.restoreRevision },
      segment1: {
        id: SEGMENT_1_ID, attemptId: attempt.id, inferenceSubmissions: captured.inferences, reviewDecision: captured.review,
        inputFrameSha256: attempt.evidenceSummary.inputFrameSha256,
        previousLastFrameSha256: attempt.evidenceSummary.previousLastFrameSha256,
        outputSha256: attempt.evidenceSummary.outputSha256, lastFrameSha256: attempt.evidenceSummary.lastFrameSha256,
        durationSeconds: attempt.evidenceSummary.durationSeconds,
      },
      finalMedia, cleanup: { first: zeroFirst, second: zeroSecond }, secretsPrinted: false,
    };
    atomicJson(EVIDENCE_PATH, evidence); rmSync(FAILURE_PATH, { force: true });
    console.log(JSON.stringify({
      ok: true, projectId: PROJECT_ID, createRequestCount: actualCreateRequests,
      successfulOrderCount: 1, orderId: captured.providerSession?.orderId, serverId: captured.providerSession?.serverId,
      endpoint: captured.providerSession ? `${captured.providerSession.host}:${captured.providerSession.port}` : null,
      hourlyUsd: captured.selected?.hourlyUsd, walletBefore: walletBefore.availableUsd, walletAfter: walletAfter.availableUsd,
      walletDelta, canceledAt: captured.canceledAt, master720p: finalMedia.master720p.path, output1080p: finalMedia.final1080p.path,
    }, null, 2));
  } catch (error) {
    restoreSegmentTask();
    atomicJson(FAILURE_PATH, {
      stage: "4J.6", at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      actualCreateRequests, completedCreateRequests, candidateAttempts: captured.createAttempts,
      lastProviderEvidence: readLastCloreCreateEvidence(), orderId: captured.providerSession?.orderId ?? null,
      serverId: captured.providerSession?.serverId ?? null, canceledAt: captured.canceledAt,
      wanRestores: captured.wanRestores, inferenceSubmissions: captured.inferences,
    });
    if (captured.providerSession && !captured.canceledAt) {
      try { await adapter.cancelSession(captured.providerSession); captured.canceledAt = new Date().toISOString(); } catch { /* billing audit reports residue */ }
    }
    throw error;
  } finally {
    if (watchdogArmed) disarmWatchdogs();
    disableLocalWatchdog(); clearManualParitySecrets();
    setCloreDeploymentHold(true, "stage4j6_final_cleanup");
    rmSync(authPath, { force: true });
  }
}

async function main() {
  const planMode = process.argv.includes("--plan");
  const executeMode = process.argv.includes("--execute");
  if (planMode === executeMode) throw new Error("Use exactly one of --plan or --execute.");
  if (planMode) {
    const plan = await buildPlan(); console.log(JSON.stringify(plan, null, 2));
    if (!plan.final_video_resume_ready || plan.blockers.length) process.exitCode = 1;
  } else await execute();
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
