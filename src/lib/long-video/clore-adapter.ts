import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getGpuProvider } from "../../../scripts/gpu-providers";
import { FIXED_RUNTIME_DIGEST, scpFile, scpFromRemote, sleep, sshCommand } from "../../../scripts/gpu-providers/common";
import type { GpuCandidate, GpuProvider, GpuSession, GpuTarget } from "../../../scripts/gpu-providers/types";
import { getCloreDeploymentHold, setCloreDeploymentHold } from "../../../scripts/clore/deployment-hold";
import { readLocalWatchdogArmState } from "../../../scripts/clore/watchdog-io";
import { buildRuntimeOverlay } from "../../../scripts/runtime-overlay";
import { prepareRemoteWorkspace, verifyWorkspaceRoundtrip } from "../../../scripts/clore/remote-workspace";
import { installDetachedWorker, launchDetachedJob, waitForDetachedJob } from "../../../scripts/clore/detached-remote-job";
import { buildRestoreBundle } from "../../../scripts/model-cache/production-restore-bundle";
import { installRemoteComfyRunner, runRemoteComfyProbe, runRemoteComfyWorkflow, downloadRemoteRunnerOutputPersistent, removeRemoteRunnerOutput } from "../../../scripts/comfy-remote-runner";
import { findLocalImageResultFile } from "@/lib/local-lab/local-results";
import { buildLongVideoProjectPaths } from "@/lib/long-video/media";
import { getLongVideoProject, processExpiredLongVideoReviews } from "@/lib/long-video/store";
import { createLongVideoSeed } from "@/lib/long-video/domain";
import type { LongVideoProject, LongVideoSegment } from "@/lib/long-video/domain";
import type { LongVideoExecutionAuthorization, LongVideoProvider, LongVideoProviderCandidate, LongVideoProviderSession, LongVideoReviewDecision, LongVideoSegmentMedia } from "@/lib/long-video/execution";

type Context = { gpu: GpuProvider; gpuSession: GpuSession; target: GpuTarget; candidate: GpuCandidate; projectId: string };

function requireOk(value: { status: number | null; stdout?: string | Buffer | null; stderr?: string | Buffer | null; error?: Error }, code: string) {
  if (value.status !== 0) throw new Error(`${code}:${String(value.error?.message ?? value.stderr ?? value.stdout ?? "").slice(-2000)}`);
  return String(value.stdout ?? "");
}

function sha256File(filePath: string) { return createHash("sha256").update(readFileSync(filePath)).digest("hex"); }

function mapCandidate(candidate: GpuCandidate): LongVideoProviderCandidate {
  const gpu = candidate.gpuType.toLowerCase();
  const gpuProfile = gpu.includes("5090") ? "rtx5090" : gpu.includes("4090") ? "rtx4090" : null;
  if (!gpuProfile || candidate.interruptible || candidate.hourlyUsd === null) throw new Error("clore_candidate_not_supported_gpu");
  if (candidate.minimumRamGb < 32 || candidate.containerDiskGb < 200 || candidate.hourlyUsd > (gpuProfile === "rtx5090" ? 0.65 : 0.7)) throw new Error("clore_candidate_policy_rejected");
  return { serverId: candidate.id, gpuProfile, hourlyUsd: candidate.hourlyUsd, vramGb: candidate.vramGb };
}

export class CloreLongVideoProviderAdapter implements LongVideoProvider {
  readonly adapterReady = true;
  readonly adapterName = "clore-long-video";
  private readonly gpu: GpuProvider;
  private readonly contexts = new Map<string, Context>();
  private readonly libraryDir: string;
  private readonly statePath: string;
  private readonly activeOrderReader?: () => Promise<number>;
  private readonly watchdogServerId: string | null;

  constructor(options: { gpu?: GpuProvider; libraryDir?: string; statePath?: string; activeOrderReader?: () => Promise<number>; watchdogServerId?: string | null } = {}) {
    this.gpu = options.gpu ?? getGpuProvider("clore");
    this.libraryDir = options.libraryDir ?? (process.env.LOCAL_VIDEO_LIBRARY_DIR?.trim() || "D:\\AI-Video-Library");
    this.statePath = options.statePath ?? path.join(process.cwd(), ".secrets", "long-video-state.json");
    this.activeOrderReader = options.activeOrderReader;
    const watchdog = options.gpu ? null : readLocalWatchdogArmState();
    this.watchdogServerId = options.watchdogServerId === undefined ? (watchdog?.armed ? watchdog.serverId : null) : options.watchdogServerId;
  }

  async inspectProviderState() {
    const [credentials, activeOrderCount] = await Promise.all([this.gpu.inspectCredentials(), this.activeOrderCount()]);
    return { credentials, activeOrderCount, deploymentHold: getCloreDeploymentHold().enabled };
  }

  async activeOrderCount() {
    if (this.activeOrderReader) return this.activeOrderReader();
    const status = await import("../../../scripts/gpu-billing-status").then((module) => module.readGpuBillingStatus());
    return status.clore.activeOrders;
  }

  async listCandidates() {
    const candidates = await this.gpu.listCandidates();
    const eligible = candidates.filter((candidate) => {
      try { mapCandidate(candidate); return true; } catch { return false; }
    }).map(mapCandidate).sort((left, right) => left.hourlyUsd - right.hourlyUsd);
    return this.watchdogServerId ? eligible.filter((candidate) => candidate.serverId === this.watchdogServerId) : eligible;
  }

  private async context(session: LongVideoProviderSession) {
    const existing = this.contexts.get(session.sessionId);
    if (existing) return existing;
    const gpuSession = await this.gpu.getSession(session.orderId);
    if (!gpuSession) throw new Error("clore_bound_order_missing");
    const target = gpuSession.target ?? await this.gpu.waitForSsh(gpuSession, 10 * 60_000);
    const candidate: GpuCandidate = { id: session.serverId, gpuType: `NVIDIA GeForce ${session.gpuProfile === "rtx5090" ? "RTX 5090" : "RTX 4090"}`, priority: 0, vramGb: session.gpuProfile === "rtx5090" ? 32 : 24, gpuCount: 1, minimumRamGb: 32, containerDiskGb: 200, volumeGb: 0, hourlyUsd: session.gpuProfile === "rtx5090" ? 0.65 : 0.7, interruptible: false };
    const value = { gpu: this.gpu, gpuSession, target, candidate, projectId: session.sessionId };
    this.contexts.set(session.sessionId, value);
    return value;
  }

  async createSession(input: { projectId: string; authorization: LongVideoExecutionAuthorization; candidate: LongVideoProviderCandidate }) {
    if (input.authorization.projectId !== input.projectId || !["rtx4090", "rtx5090"].includes(input.authorization.gpuProfile)) throw new Error("clore_project_authorization_mismatch");
    if (await this.activeOrderCount() !== 0) throw new Error("clore_active_order_limit");
    if (this.contexts.size > 0) throw new Error("clore_adapter_session_already_bound");
    if (getCloreDeploymentHold().enabled && !input.authorization.releaseHold) throw new Error("clore_hold_requires_explicit_authorization");
    if (input.authorization.gpuProfile === "rtx5090" && (!input.authorization.batchId || !input.authorization.resolutionNonce)) throw new Error("clore_resolved_batch_authorization_missing");
    if (getCloreDeploymentHold().enabled && input.authorization.gpuProfile === "rtx4090") setCloreDeploymentHold(false, `long_video:${input.projectId}`);
    const candidates = await this.gpu.listCandidates();
    const candidate = candidates.find((value) => value.id === input.candidate.serverId);
    if (!candidate) throw new Error("clore_selected_candidate_missing");
    const sessionId = `lv-${input.projectId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    let created: GpuSession | null = null;
    try {
      created = await this.gpu.createSession({ sessionId, candidate, sshPublicKey: "managed-by-clore-provider", bootstrapImage: FIXED_RUNTIME_DIGEST, dryRun: false, cloreProfile: "clore_key_with_password_fallback", resolvedBatchRelease: input.authorization.gpuProfile === "rtx5090" ? { batchId: input.authorization.batchId!, resolutionNonce: input.authorization.resolutionNonce!, gpuProfile: "rtx5090" } : undefined });
      if (!created.target && !created.id) throw new Error("clore_session_binding_invalid");
      const target = created.target ?? await this.gpu.waitForSsh(created, 10 * 60_000);
      this.contexts.set(sessionId, { gpu: this.gpu, gpuSession: created, target, candidate, projectId: input.projectId });
      return { sessionId, orderId: created.id, serverId: candidate.id, gpuProfile: input.authorization.gpuProfile, host: target.host, port: target.port };
    } catch (error) {
      if (created) {
        try { await this.gpu.terminateSession(created); } catch { /* cleanup is retried by the outer session path */ }
      }
      setCloreDeploymentHold(true, "long_video_create_failed");
      throw error;
    }
  }

  async waitForSsh(session: LongVideoProviderSession) { await this.context(session); }

  async prepareWorkspace(session: LongVideoProviderSession) {
    const { target } = await this.context(session);
    await prepareRemoteWorkspace(target, 3);
    await verifyWorkspaceRoundtrip(target);
  }

  async bootstrapRuntime(session: LongVideoProviderSession) {
    const { target } = await this.context(session);
    const overlay = buildRuntimeOverlay();
    const script = path.join(process.cwd(), "scripts", "clore", "clore-light-bootstrap.sh");
    requireOk(scpFile(target, overlay.outputPath, "/workspace/runtime-overlay.tgz", 5 * 60_000), "clore_overlay_upload_failed");
    requireOk(scpFile(target, script, "/workspace/clore-light-bootstrap.sh", 2 * 60_000), "clore_bootstrap_upload_failed");
    requireOk(sshCommand(target, "sed -i 's/\\r$//' /workspace/clore-light-bootstrap.sh; chmod 700 /workspace/clore-light-bootstrap.sh; /workspace/clore-light-bootstrap.sh prepare /workspace/runtime-overlay.tgz", 55 * 60_000), "clore_runtime_prepare_failed");
    requireOk(sshCommand(target, `/workspace/clore-light-bootstrap.sh start ${session.gpuProfile}`, 90_000), "clore_runtime_start_failed");
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      const health = sshCommand(target, "curl -fsS http://127.0.0.1:8080/healthz >/dev/null && curl -fsS http://127.0.0.1:8188/system_stats >/dev/null && curl -fsS http://127.0.0.1:8188/object_info >/dev/null", 30_000);
      if (health.status === 0) break;
      await sleep(5_000);
    }
    requireOk(sshCommand(target, "curl -fsS http://127.0.0.1:8080/healthz >/dev/null; curl -fsS http://127.0.0.1:8188/system_stats >/dev/null; curl -fsS http://127.0.0.1:8188/object_info >/dev/null", 30_000), "clore_runtime_health_failed");
    const python = "import torch,triton;assert torch.cuda.is_available();name=torch.cuda.get_device_name(0);cap=torch.cuda.get_device_capability(0);arch=torch.cuda.get_arch_list();x=torch.arange(4096,device=\"cuda\");assert int((x*x).sum().item())>0;print({\"gpu\":name,\"capability\":cap,\"arches\":arch,\"torch\":torch.__version__,\"cuda\":torch.version.cuda,\"triton\":triton.__version__});";
    const gate = session.gpuProfile === "rtx5090" ? `${python}assert \"RTX 5090\" in name;assert cap==(12,0);assert \"sm_120\" in arch` : python;
    requireOk(sshCommand(target, `mode=$(cat /workspace/ai-runtime/bootstrap-mode); if [ "$mode" = docker ]; then docker exec stage3m-comfy-runtime python3 -c '${gate}'; else /workspace/ai-runtime/venv/bin/python -c '${gate}'; fi`, 180_000), "clore_cuda_probe_failed");
    installRemoteComfyRunner(target);
    runRemoteComfyProbe(target);
  }

  async runCanary(session: LongVideoProviderSession) {
    const { target } = await this.context(session);
    await installDetachedWorker(target);
    const jobId = `lv-canary-${randomUUID().slice(0, 12)}`;
    const launched = await launchDetachedJob(target, { jobId, mode: "canary" });
    if (launched.returnedMs > 15_000) throw new Error("clore_canary_launch_timeout");
    const result = await waitForDetachedJob(target, jobId, 120_000);
    if (!result.reachable || result.state?.phase !== "completed") throw new Error("clore_canary_failed");
  }

  async restoreImage(session: LongVideoProviderSession) {
    const { target } = await this.context(session);
    return this.restoreFamily(target, "ultrareal-flux1-dev-fp8");
  }

  async generateImage(input: { session: LongVideoProviderSession; taskId: string; prompt: string; width: number; height: number; seed: number }) {
    const { target } = await this.context(input.session);
    const workflowPath = path.join(process.cwd(), "comfy-runtime", "workflows", "production", `ultrareal-flux1-dev-fp8-${input.session.gpuProfile}-api.json`);
    const workflow = JSON.parse(readFileSync(workflowPath, "utf8")) as Record<string, { inputs?: Record<string, unknown> }>;
    workflow["3"].inputs = { ...(workflow["3"].inputs ?? {}), text: input.prompt };
    workflow["6"].inputs = { ...(workflow["6"].inputs ?? {}), width: input.width, height: input.height, batch_size: 1 };
    workflow["7"].inputs = { ...(workflow["7"].inputs ?? {}), seed: input.seed };
    const result = runRemoteComfyWorkflow({ target, workflow, clientId: `img-${input.taskId.slice(0, 12)}`, kind: "image", timeoutSeconds: 60 * 60 });
    const remote = String(result.staged_path ?? "");
    if (!remote.startsWith("/workspace/runtime-tools/results/")) throw new Error("clore_image_remote_path_invalid");
    const local = path.join(os.tmpdir(), `stage4j1-${input.taskId}.png`);
    const partial = `${local}.part`;
    rmSync(partial, { force: true });
    requireOk(scpFromRemote(target, remote, partial, 30 * 60_000), "clore_image_download_failed");
    renameSync(partial, local);
    removeRemoteRunnerOutput(target, result);
    return { localPath: local, workflow, result };
  }

  async unloadImage(session: LongVideoProviderSession) {
    const { target } = await this.context(session);
    requireOk(sshCommand(target, "curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"unload_models\":true,\"free_memory\":true}' http://127.0.0.1:8188/free >/dev/null; mode=$(cat /workspace/ai-runtime/bootstrap-mode); if [ \"$mode\" = docker ]; then docker exec stage3m-comfy-runtime python3 -c 'import gc,torch;gc.collect();torch.cuda.empty_cache()'; else /workspace/ai-runtime/venv/bin/python -c 'import gc,torch;gc.collect();torch.cuda.empty_cache()'; fi", 180_000), "clore_image_unload_failed");
  }

  private async restoreFamily(target: GpuTarget, family: string) {
    const bundle = await buildRestoreBundle(family, 7200);
    bundle.parallelDownloads = 3;
    const local = path.join(os.tmpdir(), `long-video-restore-${randomUUID()}.json`);
    const jobId = `lv-restore-${randomUUID().slice(0, 12)}`;
    const remoteDir = `/workspace/jobs/${jobId}`;
    const remoteBundle = `${remoteDir}/bundle.json`;
    writeFileSync(local, `${JSON.stringify(bundle)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      requireOk(sshCommand(target, `mkdir -p /workspace/tools /workspace/logs ${remoteDir}`, 30_000), "clore_restore_dirs_failed");
      await installDetachedWorker(target);
      requireOk(scpFile(target, path.join(process.cwd(), "scripts", "clore", "restore-production-r2.py"), "/workspace/tools/restore-production-r2.py", 2 * 60_000), "clore_restore_tool_upload_failed");
      requireOk(scpFile(target, local, remoteBundle, 2 * 60_000), "clore_restore_bundle_upload_failed");
      const launched = await launchDetachedJob(target, { jobId, mode: "restore", bundlePath: remoteBundle });
      if (launched.returnedMs > 15_000) throw new Error("clore_restore_launch_timeout");
      const completed = await waitForDetachedJob(target, jobId, 100 * 60_000);
      if (!completed.reachable || completed.state?.phase !== "completed") throw new Error("clore_restore_failed");
      return { revision: bundle.expectedCurrentKey, verifiedObjects: Object.keys(bundle.objectUrls).length };
    } finally { rmSync(local, { force: true }); sshCommand(target, `rm -f ${remoteBundle}`, 30_000); }
  }

  async restoreWan(session: LongVideoProviderSession) {
    const { target } = await this.context(session);
    return this.restoreFamily(target, "wan22-remix-14b-i2v-fp8");
  }

  private resolveInputFrame(project: LongVideoProject, segment: LongVideoSegment) {
    if (segment.sequenceIndex === 0) {
      const match = project.firstFrameRef?.match(/^image:([A-Za-z0-9_-]{6,120})$/);
      const result = match ? findLocalImageResultFile(match[1]) : null;
      if (!result) throw new Error("clore_existing_image_file_missing");
      return result.filePath;
    }
    if (!segment.inputFrameRef) throw new Error("clore_tail_frame_missing");
    const paths = buildLongVideoProjectPaths(this.libraryDir, project.createdAt.slice(0, 10), project.id);
    const resolved = path.resolve(paths.projectDir, segment.inputFrameRef);
    const relative = path.relative(path.resolve(paths.projectDir), resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(resolved)) throw new Error("clore_tail_frame_reference_invalid");
    return resolved;
  }

  async generateSegment(input: { session: LongVideoProviderSession; project: LongVideoProject; sequenceIndex: number; attemptId: string; prompt: string; inputFrameRef: string; previousSegmentId: string | null; previousAttemptId: string | null; previousLastFrameSha256: string | null }): Promise<LongVideoSegmentMedia> {
    const { target } = await this.context(input.session);
    const segment = input.project.segments[input.sequenceIndex];
    if (!segment) throw new Error("clore_segment_missing");
    const source = this.resolveInputFrame(input.project, segment);
    const inputSha = sha256File(source);
    const remoteName = `long-video-${input.attemptId}.png`;
    requireOk(sshCommand(target, "mkdir -p /workspace/comfy-input", 30_000), "clore_comfy_input_dir_failed");
    requireOk(scpFile(target, source, `/workspace/comfy-input/${remoteName}`, 10 * 60_000), "clore_input_upload_failed");
    const workflowPath = path.join(process.cwd(), "comfy-runtime", "workflows", "production", `wan22-remix-14b-i2v-fp8-${input.session.gpuProfile}-api.json`);
    const workflow = JSON.parse(readFileSync(workflowPath, "utf8")) as Record<string, { inputs?: Record<string, unknown> }>;
    workflow["5"].inputs = { ...(workflow["5"].inputs ?? {}), image: remoteName };
    workflow["6"].inputs = { ...(workflow["6"].inputs ?? {}), text: input.prompt };
    workflow["8"].inputs = { ...(workflow["8"].inputs ?? {}), width: input.session.gpuProfile === "rtx5090" ? 1280 : 832, height: input.session.gpuProfile === "rtx5090" ? 720 : 480, length: 81, batch_size: 1 };
    workflow["11"].inputs = { ...(workflow["11"].inputs ?? {}), noise_seed: createLongVideoSeed() };
    const result = runRemoteComfyWorkflow({ target, workflow, clientId: `lv-${input.attemptId.slice(0, 12)}`, kind: "video", timeoutSeconds: 90 * 60 });
    const temporaryDir = path.join(os.tmpdir(), `long-video-${input.attemptId}`);
    mkdirSync(temporaryDir, { recursive: true });
    const downloaded = downloadRemoteRunnerOutputPersistent(target, result, temporaryDir);
    removeRemoteRunnerOutput(target, result);
    return { sourceVideo: downloaded.sourcePath, workflow, inputFrameSha256: inputSha, previousSegmentId: input.previousSegmentId, previousAttemptId: input.previousAttemptId, previousLastFrameSha256: input.previousLastFrameSha256 };
  }

  async awaitReview(input: { projectId: string; sequenceIndex: number; deadline: string }): Promise<LongVideoReviewDecision> {
    while (Date.now() < Date.parse(input.deadline)) {
      processExpiredLongVideoReviews(new Date(), this.statePath);
      const project = getLongVideoProject(input.projectId, this.statePath);
      const segment = project?.segments[input.sequenceIndex];
      if (segment?.status === "accepted") return "accept";
      if (segment?.status === "paused") return "pause";
      await sleep(1_000);
    }
    return "timeout_accept";
  }

  async cancelSession(session: LongVideoProviderSession) {
    const context = await this.context(session);
    sshCommand(context.target, "for p in /workspace/jobs/*/worker.pid; do test -s \"$p\" && kill -TERM $(cat \"$p\") 2>/dev/null || true; done; /workspace/clore-light-bootstrap.sh stop || true", 120_000);
    const billing = await context.gpu.getBilling(context.gpuSession).catch(() => null);
    await context.gpu.terminateSession(context.gpuSession);
    setCloreDeploymentHold(true, "long_video_cleanup");
    const confirmations: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      confirmations.push(await this.activeOrderCount());
      if (confirmations.filter((value) => value === 0).length >= 2) break;
      await sleep(5_000);
    }
    if (confirmations.filter((value) => value === 0).length < 2) throw new Error("clore_zero_resource_confirmation_failed");
    this.contexts.delete(session.sessionId);
    void billing;
  }
}
