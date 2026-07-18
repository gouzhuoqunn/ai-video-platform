import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CloreLongVideoProviderAdapter } from "../src/lib/long-video/clore-adapter";
import { LongVideoExecutionCoordinator, type LongVideoExecutionAuthorization, type LongVideoProvider, type LongVideoProviderCandidate, type LongVideoProviderSession, type LongVideoSegmentMedia } from "../src/lib/long-video/execution";
import { archiveFluxFirstImage } from "./flux-first-image";
import { validatePngPixels } from "./flux-first-image-executor";
import { setGenerationTaskStatus, readGenerationPool } from "../src/lib/generation/task-pool";
import { buildLongVideoProjectPaths, mergeLongVideoProjectMedia, probeLongVideoMedia } from "../src/lib/long-video/media";
import { commitLongVideoMerge, getLongVideoProject, markLongVideoMergeStarted } from "../src/lib/long-video/store";
import { readDeploymentResolution, validateDeploymentResolution } from "./clore/deployment-resolution";
import { getCloreDeploymentHold } from "./clore/deployment-hold";

async function main() {
const batchPath = path.join(process.cwd(), ".secrets", "stage4j1-batch.json");
const authDir = path.join(process.cwd(), ".secrets", "long-video-authorizations");
const libraryDir = "D:\\AI-Video-Library";
const ffmpeg = (require("@ffmpeg-installer/ffmpeg") as { path: string }).path;
const batch = JSON.parse(readFileSync(batchPath, "utf8")) as { batchId: string; resolutionNonce: string; imageJobs: string[]; longVideoProjectId: string; video: { negativePrompt: string; seed: number } };
const resolution = readDeploymentResolution();
if (!getCloreDeploymentHold().enabled) throw new Error("clore_hold_must_remain_enabled_before_batch_execution");
if (!validateDeploymentResolution(resolution, batch.batchId, batch.resolutionNonce).valid) throw new Error("resolved_batch_record_invalid");
const authorization: LongVideoExecutionAuthorization = { id: randomUUID(), projectId: batch.longVideoProjectId, batchId: batch.batchId, resolutionNonce: batch.resolutionNonce, provider: "clore", gpuProfile: "rtx5090", oneUse: true, expiresAt: new Date(Date.now() + 300 * 60_000).toISOString(), maxSpendUsd: 3, walletDeltaCapUsd: 3, releaseHold: true, maxActiveOrders: 1, maxPreSshAttempts: 1, wallClockMinutes: 300, drainingAtMinutes: 270, maxSegments: 2, maxOrders: 1, maxHourlyUsd: 0.65, orderType: "on-demand", noReplacementOrder: true, allowedTaskIds: [...batch.imageJobs, batch.longVideoProjectId] };
const authorizationPath = path.join(authDir, `${authorization.id}.json`);
writeFileSync(authorizationPath, `${JSON.stringify(authorization, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

try {
const adapter = new CloreLongVideoProviderAdapter({ libraryDir, videoNegativePrompt: batch.video.negativePrompt, videoSeedBase: batch.video.seed });
const preflight = await adapter.listCandidates();
const candidate = preflight.find((item) => item.gpuProfile === "rtx5090" && item.hourlyUsd <= 0.65);
if (!candidate) throw new Error("no_compliant_rtx5090_under_065");
const session = await adapter.createSession({ projectId: batch.longVideoProjectId, authorization, candidate });
const evidence: Record<string, unknown> = { batchId: batch.batchId, authorizationId: authorization.id, candidate, startedAt: new Date().toISOString(), image: [], video: null };
let primary: unknown = null;
try {
  await adapter.waitForSsh(session);
  await adapter.prepareWorkspace(session);
  await adapter.bootstrapRuntime(session);
  await adapter.runCanary(session);
  const imageRestore = await adapter.restoreImage(session);
  const pool = readGenerationPool();
  const imageA = pool.tasks.find((task) => task.id === batch.imageJobs[0]);
  const imageB = pool.tasks.find((task) => task.id === batch.imageJobs[1]);
  if (!imageA || !imageB) throw new Error("prepared_image_tasks_missing");
  const generatedA = await adapter.generateImage({ session, taskId: imageA.id, prompt: imageA.prompt, negativePrompt: imageA.negativePrompt, width: 1536, height: 1024, seed: imageA.seed });
  const pixelsA = validatePngPixels(readFileSync(generatedA.localPath));
  const archivedA = archiveFluxFirstImage({ sourcePng: generatedA.localPath, sessionId: imageA.id, workflow: generatedA.workflow as never, metadata: { width: 1536, height: 1024, seed: imageA.seed, batch: 1, gpuProfile: "rtx5090", quality: "medium", performance: "faster", inferenceDurationMs: generatedA.result.elapsed_ms ?? null, outputFormat: "png" }, evidence: { restore: imageRestore, remote: generatedA.result, pixels: pixelsA } });
  setGenerationTaskStatus([imageA.id], "completed", { outputPath: archivedA.outputPath, outputSha256: archivedA.sha256, width: 1536, height: 1024, imagePreserved: true, inferenceVerified: true, gpuProfile: "rtx5090", quality: "medium" });
  const generatedB = await adapter.generateImage({ session, taskId: imageB.id, prompt: imageB.prompt, negativePrompt: imageB.negativePrompt, width: 1536, height: 1536, seed: imageB.seed });
  const finalB = path.join(path.dirname(generatedB.localPath), `${imageB.id}-2048.png`);
  const scaled = spawnSync(ffmpeg, ["-y", "-i", generatedB.localPath, "-vf", "scale=2048:2048:flags=lanczos", "-frames:v", "1", finalB], { encoding: "utf8", timeout: 300_000 });
  if (scaled.status !== 0 || !existsSync(finalB)) throw new Error("high_image_scaling_failed");
  const pixelsB = validatePngPixels(readFileSync(finalB));
  const archivedB = archiveFluxFirstImage({ sourcePng: finalB, sessionId: imageB.id, workflow: generatedB.workflow as never, metadata: { baseWidth: 1536, baseHeight: 1536, width: 2048, height: 2048, seed: imageB.seed, batch: 1, gpuProfile: "rtx5090", quality: "high", finalizationMethod: "deterministic_lanczos_upscale", native: false, inferenceDurationMs: generatedB.result.elapsed_ms ?? null, outputFormat: "png" }, evidence: { restore: imageRestore, remote: generatedB.result, pixels: pixelsB, baseSha256: createHash("sha256").update(readFileSync(generatedB.localPath)).digest("hex") } });
  setGenerationTaskStatus([imageB.id], "completed", { outputPath: archivedB.outputPath, outputSha256: archivedB.sha256, width: 2048, height: 2048, baseWidth: 1536, baseHeight: 1536, finalizationMethod: "deterministic_lanczos_upscale", native: false, imagePreserved: true, inferenceVerified: true, gpuProfile: "rtx5090", quality: "high" });
  evidence.image = [{ jobId: imageA.id, restore: imageRestore, output: archivedA }, { jobId: imageB.id, restore: imageRestore, output: archivedB }];
  rmSync(generatedA.localPath, { force: true }); rmSync(generatedB.localPath, { force: true }); rmSync(finalB, { force: true });
  await adapter.unloadImage(session);

  const delegated: LongVideoProvider = {
    listCandidates: async () => [{ serverId: candidate.serverId, gpuProfile: "rtx5090", hourlyUsd: candidate.hourlyUsd, vramGb: candidate.vramGb }],
    activeOrderCount: async () => 0,
    createSession: async () => session,
    waitForSsh: async () => undefined,
    prepareWorkspace: async () => undefined,
    bootstrapRuntime: async () => undefined,
    runCanary: async () => undefined,
    restoreWan: async () => adapter.restoreWan(session),
    generateSegment: async (input): Promise<LongVideoSegmentMedia> => adapter.generateSegment(input),
    awaitReview: async (input) => adapter.awaitReview(input),
    cancelSession: async () => undefined,
  };
  const coordinator = new LongVideoExecutionCoordinator({ provider: delegated, policy: { maxSpendUsd: 3, maxSegmentsPerSession: 2, maxConsecutiveSegments: 2 }, libraryDir });
  const plan = await coordinator.plan(batch.longVideoProjectId);
  if (!plan.real_project_plan_ready) throw new Error(`long_video_plan_blocked:${plan.blockers.join(",")}`);
  const videoSession = await coordinator.execute(batch.longVideoProjectId, authorization);
  evidence.video = { session: videoSession, wanRestore: videoSession.restoreRevision, expectedSegments: 2 };
  await adapter.cancelSession(session);
  let mergedProject = getLongVideoProject(batch.longVideoProjectId)!;
  mergedProject = markLongVideoMergeStarted(mergedProject.id, mergedProject.version);
  const merged = mergeLongVideoProjectMedia({ project: mergedProject, libraryDir });
  const paths = buildLongVideoProjectPaths(libraryDir, mergedProject.createdAt.slice(0, 10), mergedProject.id);
  const master = path.join(paths.projectDir, "master-720p.mp4");
  copyFileSync(paths.finalVideo, master);
  const scaledFinal = `${paths.finalVideo}.part`;
  const finalScale = spawnSync(ffmpeg, ["-y", "-i", master, "-vf", "scale=1920:1080:flags=lanczos", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", scaledFinal], { encoding: "utf8", timeout: 600_000 });
  if (finalScale.status !== 0) throw new Error("long_video_1080p_finalization_failed");
  renameSync(scaledFinal, paths.finalVideo);
  const thumbPart = `${paths.finalThumbnail}.part`;
  const thumb = spawnSync(ffmpeg, ["-y", "-ss", "1", "-i", paths.finalVideo, "-frames:v", "1", "-vf", "scale=640:-2:force_original_aspect_ratio=decrease", "-q:v", "3", thumbPart], { encoding: "utf8", timeout: 120_000 });
  if (thumb.status !== 0) throw new Error("long_video_1080p_thumbnail_failed");
  renameSync(thumbPart, paths.finalThumbnail);
  const sourceSha = createHash("sha256").update(readFileSync(master)).digest("hex");
  const finalSha = createHash("sha256").update(readFileSync(paths.finalVideo)).digest("hex");
  writeFileSync(path.join(paths.projectDir, "finalization.json"), `${JSON.stringify({ generationResolution: "1280x720", finalResolution: "1920x1080", native1080p: false, sourceMaster: "master-720p.mp4", sourceMasterSha256: sourceSha, finalSha256: finalSha, method: "deterministic_lanczos_h264_yuv420p_faststart", createdAt: new Date().toISOString() }, null, 2)}\n`);
  mergedProject = commitLongVideoMerge({ projectId: mergedProject.id, expectedVersion: mergedProject.version, finalVideoRef: "output.mp4", finalThumbnailRef: "thumbnail.jpg", actualDurationSeconds: Number(probeLongVideoMedia(paths.finalVideo).format.duration) });
  writeFileSync(path.join(process.cwd(), ".secrets", "stage4j1-session-evidence.json"), `${JSON.stringify({ ...evidence, cleanup: { activeOrderExpected: 0, holdRestored: true }, master720p: { path: master, sha256: sourceSha }, final1080p: { path: paths.finalVideo, sha256: finalSha } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ ok: true, batchId: batch.batchId, authorizationId: authorization.id, candidate, mediumImage: imageA.id, highImage: imageB.id, projectId: batch.longVideoProjectId, master720p: master, output1080p: paths.finalVideo, sourceMasterSha256: sourceSha, finalSha256: finalSha }, null, 2));
} catch (error) {
  primary = error;
  try { await adapter.cancelSession(session); } catch { /* preserve first error */ }
  throw error;
} finally {
  if (primary) writeFileSync(path.join(process.cwd(), ".secrets", "stage4j1-session-failure.json"), `${JSON.stringify({ batchId: batch.batchId, authorizationId: authorization.id, error: primary instanceof Error ? primary.message : String(primary), at: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
} finally {
  rmSync(authorizationPath, { force: true });
}

}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
