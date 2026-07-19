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
import { parseTritonProbeOutput, stage3UHostCompilerProbes } from "../../../scripts/clore/host-compiler-probes";
import { buildRuntimeOverlay } from "../../../scripts/runtime-overlay";
import { prepareRemoteWorkspace, verifyWorkspaceRoundtrip } from "../../../scripts/clore/remote-workspace";
import { installDetachedWorker, launchDetachedJob, waitForDetachedJob } from "../../../scripts/clore/detached-remote-job";
import { buildRestoreBundle } from "../../../scripts/model-cache/production-restore-bundle";
import { installRemoteComfyRunner, runRemoteComfyProbe, runRemoteComfyWorkflow, downloadRemoteRunnerOutputPersistent, removeRemoteRunnerOutput } from "../../../scripts/comfy-remote-runner";
import { findLocalImageResultFile } from "@/lib/local-lab/local-results";
import { buildLongVideoProjectPaths, probeLongVideoMedia } from "@/lib/long-video/media";
import { getLongVideoProject, processExpiredLongVideoReviews } from "@/lib/long-video/store";
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
  private readonly restoreQualifications = new Map<string, Record<string, unknown>>();
  private readonly libraryDir: string;
  private readonly statePath: string;
  private readonly activeOrderReader?: () => Promise<number>;
  private readonly watchdogServerId: string | null;
  private readonly videoNegativePrompt: string;
  private readonly videoSeedBase: number;
  private readonly beforeCreateRequest?: () => Promise<void> | void;
  private readonly afterCreateRequestAttempt?: () => Promise<void> | void;
  private readonly preserveCreatedOrderForReconciliation: boolean;
  private authorizedProjectId: string | null = null;

  constructor(options: { gpu?: GpuProvider; libraryDir?: string; statePath?: string; activeOrderReader?: () => Promise<number>; watchdogServerId?: string | null; videoNegativePrompt?: string; videoSeedBase?: number; beforeCreateRequest?: () => Promise<void> | void; afterCreateRequestAttempt?: () => Promise<void> | void; preserveCreatedOrderForReconciliation?: boolean } = {}) {
    this.gpu = options.gpu ?? getGpuProvider("clore");
    this.libraryDir = options.libraryDir ?? (process.env.LOCAL_VIDEO_LIBRARY_DIR?.trim() || "D:\\AI-Video-Library");
    this.statePath = options.statePath ?? path.join(process.cwd(), ".secrets", "long-video-state.json");
    this.activeOrderReader = options.activeOrderReader;
    const watchdog = options.gpu ? null : readLocalWatchdogArmState();
    this.watchdogServerId = options.watchdogServerId === undefined ? (watchdog?.armed ? watchdog.serverId : null) : options.watchdogServerId;
    this.videoNegativePrompt = options.videoNegativePrompt?.trim() ?? "";
    this.videoSeedBase = options.videoSeedBase ?? 50902001;
    this.beforeCreateRequest = options.beforeCreateRequest;
    this.afterCreateRequestAttempt = options.afterCreateRequestAttempt;
    this.preserveCreatedOrderForReconciliation = options.preserveCreatedOrderForReconciliation === true;
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
    if (!this.authorizedProjectId) throw new Error("clore_reconciled_project_scope_missing");
    const target = gpuSession.target ?? await this.gpu.waitForSsh(gpuSession, 10 * 60_000);
    const candidate: GpuCandidate = { id: session.serverId, gpuType: `NVIDIA GeForce ${session.gpuProfile === "rtx5090" ? "RTX 5090" : "RTX 4090"}`, priority: 0, vramGb: session.gpuProfile === "rtx5090" ? 32 : 24, gpuCount: 1, minimumRamGb: 32, containerDiskGb: 200, volumeGb: 0, hourlyUsd: session.gpuProfile === "rtx5090" ? 0.65 : 0.7, interruptible: false };
    const value = { gpu: this.gpu, gpuSession, target, candidate, projectId: this.authorizedProjectId };
    this.contexts.set(session.sessionId, value);
    return value;
  }

  async createSession(input: { projectId: string; authorization: LongVideoExecutionAuthorization; candidate: LongVideoProviderCandidate }) {
    if (input.authorization.projectId !== input.projectId || !["rtx4090", "rtx5090"].includes(input.authorization.gpuProfile)) throw new Error("clore_project_authorization_mismatch");
    if (await this.activeOrderCount() !== 0) throw new Error("clore_active_order_limit");
    if (this.contexts.size > 0) throw new Error("clore_adapter_session_already_bound");
    if (getCloreDeploymentHold().enabled && !input.authorization.releaseHold) throw new Error("clore_hold_requires_explicit_authorization");
    if (input.authorization.gpuProfile === "rtx5090" && (!input.authorization.batchId || !input.authorization.resolutionNonce)) throw new Error("clore_resolved_batch_authorization_missing");
    if (input.authorization.gpuProfile === "rtx5090") {
      const common =
        input.authorization.maxActiveOrders === 1 &&
        input.authorization.maxPreSshAttempts === 1 &&
        input.authorization.orderType === "on-demand" &&
        input.authorization.maxHourlyUsd === 0.65;
      const fullAcceptance =
        input.authorization.executionPurpose === undefined &&
        input.authorization.maxOrders === 1 &&
        input.authorization.noReplacementOrder === true &&
        input.authorization.maxSpendUsd <= 3 &&
        input.authorization.walletDeltaCapUsd === 3 &&
        input.authorization.wallClockMinutes === 300 &&
        input.authorization.drainingAtMinutes === 270;
      const resilientResume =
        input.authorization.executionPurpose === "final_video_resume_resilient" &&
        input.authorization.maxOrders === 1 &&
        input.authorization.noReplacementOrder === true &&
        input.authorization.maxSpendUsd === 1.25 &&
        input.authorization.walletDeltaCapUsd === 1.25 &&
        input.authorization.wallClockMinutes === 120 &&
        input.authorization.drainingAtMinutes === 105 &&
        input.authorization.maxSegments === 1 &&
        input.authorization.maxCreateRequests === 3 &&
        input.authorization.maxSuccessfulOrders === 1 &&
        input.authorization.allowedSegmentIds?.length === 1 &&
        input.authorization.allowedTaskIds?.length === 2 &&
        input.authorization.allowedTaskIds[0] === input.projectId &&
        input.authorization.allowedTaskIds[1] === input.authorization.allowedSegmentIds[0];
      const throughputQualifiedResume =
        input.authorization.executionPurpose === "final_video_resume_resilient" &&
        input.authorization.maxOrders === 2 &&
        input.authorization.maxProductionOrders === 1 &&
        input.authorization.maxQualificationOrders === 2 &&
        input.authorization.noReplacementOrder === false &&
        input.authorization.maxSpendUsd === 1.25 &&
        input.authorization.walletDeltaCapUsd === 1.25 &&
        input.authorization.wallClockMinutes === 240 &&
        input.authorization.drainingAtMinutes === 220 &&
        input.authorization.maxSegments === 1 &&
        input.authorization.maxCreateRequests === 3 &&
        input.authorization.maxSuccessfulOrders === 2 &&
        input.authorization.allowedSegmentIds?.length === 1 &&
        input.authorization.allowedTaskIds?.length === 2 &&
        input.authorization.allowedTaskIds[0] === input.projectId &&
        input.authorization.allowedTaskIds[1] === input.authorization.allowedSegmentIds[0];
      if (!common || (!fullAcceptance && !resilientResume && !throughputQualifiedResume)) {
        throw new Error("clore_final_5090_authorization_policy_mismatch");
      }
    }
    this.authorizedProjectId = input.projectId;
    if (getCloreDeploymentHold().enabled && input.authorization.gpuProfile === "rtx4090") setCloreDeploymentHold(false, `long_video:${input.projectId}`);
    const candidates = await this.gpu.listCandidates();
    const candidate = candidates.find((value) => value.id === input.candidate.serverId);
    if (!candidate) throw new Error("clore_selected_candidate_missing");
    const sessionId = `lv-${input.projectId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    let created: GpuSession | null = null;
    try {
      created = await this.gpu.createSession({ sessionId, candidate, sshPublicKey: "managed-by-clore-provider", bootstrapImage: FIXED_RUNTIME_DIGEST, dryRun: false, cloreProfile: "clore_key_with_password_fallback", resolvedBatchRelease: input.authorization.gpuProfile === "rtx5090" ? { batchId: input.authorization.batchId!, resolutionNonce: input.authorization.resolutionNonce!, gpuProfile: "rtx5090" } : undefined, beforeCreateRequest: this.beforeCreateRequest, afterCreateRequestAttempt: this.afterCreateRequestAttempt });
      if (!created.target && !created.id) throw new Error("clore_session_binding_invalid");
      const target = created.target ?? await this.gpu.waitForSsh(created, 10 * 60_000);
      this.contexts.set(sessionId, { gpu: this.gpu, gpuSession: created, target, candidate, projectId: input.projectId });
      return { sessionId, orderId: created.id, serverId: candidate.id, gpuProfile: input.authorization.gpuProfile, host: target.host, port: target.port };
    } catch (error) {
      if (created && !this.preserveCreatedOrderForReconciliation) {
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
    requireOk(sshCommand(target, `sed -i 's/\\r$//' /workspace/clore-light-bootstrap.sh; chmod 700 /workspace/clore-light-bootstrap.sh; /workspace/clore-light-bootstrap.sh prepare /workspace/runtime-overlay.tgz ${session.gpuProfile}`, 55 * 60_000), "clore_runtime_prepare_failed");

    const startAndHealth = async () => {
      requireOk(sshCommand(target, `/workspace/clore-light-bootstrap.sh start ${session.gpuProfile}`, 90_000), "clore_runtime_start_failed");
      const deadline = Date.now() + 8 * 60_000;
      while (Date.now() < deadline) {
        const health = sshCommand(target, "curl -fsS http://127.0.0.1:8080/healthz >/dev/null && curl -fsS http://127.0.0.1:8188/system_stats >/dev/null && curl -fsS http://127.0.0.1:8188/object_info >/dev/null", 30_000);
        if (health.status === 0) break;
        await sleep(5_000);
      }
      requireOk(sshCommand(target, "curl -fsS http://127.0.0.1:8080/healthz >/dev/null; curl -fsS http://127.0.0.1:8188/system_stats >/dev/null; curl -fsS http://127.0.0.1:8188/object_info >/dev/null", 30_000), "clore_runtime_health_failed");
    };

    const runBlackwellGate = () => {
      const python = [
        "import json,torch,triton",
        "assert torch.cuda.is_available()",
        "name=torch.cuda.get_device_name(0)",
        "cap=torch.cuda.get_device_capability(0)",
        "arches=torch.cuda.get_arch_list()",
        "vram=torch.cuda.get_device_properties(0).total_memory",
        "x=torch.arange(4096,device='cuda',dtype=torch.float32)",
        "assert float((x*x).sum().item())>0",
        "assert 'RTX 5090' in name",
        "assert cap==(12,0)",
        "assert 'sm_120' in arches",
        "assert 30*1024**3 <= vram <= 40*1024**3",
        "assert not str(torch.__version__).startswith('2.6.0')",
        "print(json.dumps({'gpu':name,'capability':cap,'vram_bytes':vram,'arches':arches,'torch':torch.__version__,'cuda':torch.version.cuda,'triton':triton.__version__}))",
      ].join(";");
      const pythonBase64 = Buffer.from(python, "utf8").toString("base64");
      const cudaEvidence = requireOk(sshCommand(target, `printf '%s' '${pythonBase64}' | base64 -d | /workspace/ai-runtime/venv/bin/python -`, 180_000), "clore_blackwell_cuda_probe_failed").trim();
      const tritonProbe = stage3UHostCompilerProbes().find((probe) => probe.label === "triton_vector_add");
      if (!tritonProbe) throw new Error("clore_triton_probe_definition_missing");
      const tritonEvidence = requireOk(sshCommand(target, tritonProbe.command, 180_000), "clore_blackwell_triton_probe_failed").trim();
      if (!parseTritonProbeOutput(tritonEvidence).valid) throw new Error("clore_blackwell_triton_probe_invalid");
      const workflowPaths = [
        path.join(process.cwd(), "comfy-runtime", "workflows", "production", "ultrareal-flux1-dev-fp8-rtx5090-api.json"),
        path.join(process.cwd(), "comfy-runtime", "workflows", "production", "wan22-remix-14b-i2v-fp8-rtx5090-api.json"),
      ];
      const requiredNodes = [...new Set(workflowPaths.flatMap((workflowPath) => {
        const workflow = JSON.parse(readFileSync(workflowPath, "utf8")) as Record<string, { class_type?: string }>;
        return Object.values(workflow).map((node) => node.class_type).filter((value): value is string => Boolean(value));
      }))].sort();
      const nodeProbe = [
        "import base64,json,urllib.request",
        `required=json.loads(base64.b64decode('${Buffer.from(JSON.stringify(requiredNodes), "utf8").toString("base64")}'))`,
        "info=json.load(urllib.request.urlopen('http://127.0.0.1:8188/object_info',timeout=20))",
        "missing=[name for name in required if name not in info]",
        "print(json.dumps({'required_nodes':required,'missing_nodes':missing}))",
        "assert not missing",
      ].join(";");
      const nodeEvidence = requireOk(sshCommand(target, `printf '%s' '${Buffer.from(nodeProbe, "utf8").toString("base64")}' | base64 -d | python3 -`, 60_000), "clore_blackwell_required_nodes_failed").trim();
      const hostEvidence = requireOk(sshCommand(target, "set -e; nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader; ram=$(awk '/MemTotal/{print $2*1024}' /proc/meminfo); disk=$(df -B1 --output=avail /workspace | tail -1 | tr -d ' '); test \"$ram\" -ge 32000000000; test \"$disk\" -ge 200000000000; ffmpeg -version | head -1; ffprobe -version | head -1; printf 'ram_bytes=%s\\ndisk_available_bytes=%s\\n' \"$ram\" \"$disk\"; ! grep -Eai 'not compatible with the current PyTorch installation|unsupported.{0,40}(architecture|sm_120)|sm_120.{0,40}not supported' /workspace/logs/runtime-stage3m.log", 90_000), "clore_blackwell_host_gate_failed").trim();
      return { cudaEvidence, tritonEvidence, nodeEvidence, hostEvidence };
    };

    let blackwellEvidence: ReturnType<typeof runBlackwellGate> | null = null;
    try {
      await startAndHealth();
      if (session.gpuProfile === "rtx5090") blackwellEvidence = runBlackwellGate();
    } catch (firstError) {
      if (session.gpuProfile !== "rtx5090") throw firstError;
      requireOk(sshCommand(target, "/workspace/clore-light-bootstrap.sh stop || true; /workspace/ai-runtime/venv/bin/python -m pip install --upgrade --force-reinstall --index-url https://download.pytorch.org/whl/cu128 'torch==2.7.1' 'torchvision==0.22.1' 'torchaudio==2.7.1'", 25 * 60_000), "clore_blackwell_focused_repair_failed");
      try {
        await startAndHealth();
        blackwellEvidence = runBlackwellGate();
      } catch (repairError) {
        const handoffPath = path.join(process.cwd(), ".secrets", "stage4j3-manual-handoff.json");
        const handoff = {
          status: "MANUAL_HANDOFF_REQUIRED",
          orderId: session.orderId,
          serverId: session.serverId,
          endpoint: { host: session.host, port: session.port, user: "root" },
          firstFailure: firstError instanceof Error ? firstError.message : String(firstError),
          repairFailure: repairError instanceof Error ? repairError.message : String(repairError),
          commands: [
            "/workspace/ai-runtime/venv/bin/python -c \"import torch; print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0), torch.cuda.get_device_capability(0), torch.cuda.get_arch_list())\"",
            "/workspace/clore-light-bootstrap.sh stop",
            "/workspace/clore-light-bootstrap.sh start rtx5090",
          ],
          waitUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
        };
        writeFileSync(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        console.log("MANUAL_HANDOFF_REQUIRED");
        const deadline = Date.now() + 15 * 60_000;
        while (Date.now() < deadline) {
          await sleep(30_000);
          try {
            blackwellEvidence = runBlackwellGate();
            break;
          } catch { /* allow one bounded manual in-place repair on this order */ }
        }
        if (!blackwellEvidence) throw repairError;
      }
    }
    if (blackwellEvidence) {
      writeFileSync(path.join(process.cwd(), ".secrets", "stage4j3-blackwell-evidence.json"), `${JSON.stringify({ schemaVersion: 1, orderId: session.orderId, serverId: session.serverId, endpoint: { host: session.host, port: session.port, user: "root" }, ...blackwellEvidence, verifiedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
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

  async generateImage(input: { session: LongVideoProviderSession; taskId: string; prompt: string; negativePrompt: string; width: number; height: number; seed: number }) {
    const { target } = await this.context(input.session);
    const workflowPath = path.join(process.cwd(), "comfy-runtime", "workflows", "production", `ultrareal-flux1-dev-fp8-${input.session.gpuProfile}-api.json`);
    const workflow = JSON.parse(readFileSync(workflowPath, "utf8")) as Record<string, { inputs?: Record<string, unknown> }>;
    workflow["3"].inputs = { ...(workflow["3"].inputs ?? {}), text: input.prompt };
    workflow["4"].inputs = { ...(workflow["4"].inputs ?? {}), text: input.negativePrompt };
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
    const idle = requireOk(sshCommand(target, "curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"unload_models\":true,\"free_memory\":true}' http://127.0.0.1:8188/free >/dev/null; mode=$(cat /workspace/ai-runtime/bootstrap-mode); if [ \"$mode\" = docker ]; then docker exec stage3m-comfy-runtime python3 -c 'import gc,torch;gc.collect();torch.cuda.empty_cache()'; else /workspace/ai-runtime/venv/bin/python -c 'import gc,torch;gc.collect();torch.cuda.empty_cache()'; fi; nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader,nounits", 180_000), "clore_image_unload_failed").trim();
    writeFileSync(path.join(process.cwd(), ".secrets", "stage4j3-image-unload-evidence.json"), `${JSON.stringify({ schemaVersion: 1, orderId: session.orderId, imageModelsUnloaded: true, cudaCacheCleared: true, idleVramMiB: idle, recordedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private async restoreFamily(target: GpuTarget, family: string) {
    const bundle = await buildRestoreBundle(family, 7200);
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
      const result = completed.result as { restore?: Record<string, unknown> } | null;
      if (!result?.restore || result.restore.status !== "completed") throw new Error("clore_restore_result_missing");
      const files = result.restore.files as Record<string, { reusedBytes?: number; transferredBytes?: number }> | undefined;
      const reusedProbeBytes = Object.values(files ?? {}).reduce((total, file) => total + Number(file.reusedBytes ?? 0), 0);
      const transferredBytes = Object.values(files ?? {}).reduce((total, file) => total + Number(file.transferredBytes ?? 0), 0);
      const evidencePath = path.join(process.cwd(), ".secrets", "restore-throughput-final-evidence.json");
      const evidencePart = `${evidencePath}.${process.pid}.part`;
      writeFileSync(evidencePart, `${JSON.stringify({
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        signedUrlsPersisted: false,
        credentialsPersisted: false,
        reusedProbeBytes,
        transferredBytes,
        restore: result.restore,
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(evidencePart, evidencePath);
      return {
        revision: bundle.expectedCurrentKey,
        verifiedObjects: Object.keys(bundle.objectUrls).length,
        reusedProbeBytes,
        transferredBytes,
        progress: result.restore,
      };
    } finally { rmSync(local, { force: true }); sshCommand(target, `rm -f ${remoteBundle}`, 30_000); }
  }

  async probeWanRestoreThroughput(session: LongVideoProviderSession, budget: { cumulativeWalletDeltaUsd?: number; elapsedSeconds?: number } = {}) {
    const { target, candidate, gpu, gpuSession } = await this.context(session);
    const bundle = await buildRestoreBundle("wan22-remix-14b-i2v-fp8", 900);
    const billing = await gpu.getBilling(gpuSession).catch(() => null);
    bundle.qualificationGate.hourlyUsd = candidate.hourlyUsd;
    bundle.qualificationGate.elapsedSeconds = budget.elapsedSeconds ?? billing?.elapsedSeconds ?? 0;
    bundle.qualificationGate.walletSpentUsd = Math.max(
      budget.cumulativeWalletDeltaUsd ?? 0,
      billing?.estimatedSpendUsd ?? 0,
    );
    const local = path.join(os.tmpdir(), `long-video-restore-probe-${randomUUID()}.json`);
    const jobId = `lv-probe-${randomUUID().slice(0, 12)}`;
    const remoteDir = `/workspace/jobs/${jobId}`;
    const remoteBundle = `${remoteDir}/bundle.json`;
    writeFileSync(local, `${JSON.stringify(bundle)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      requireOk(sshCommand(target, `mkdir -p /workspace/tools /workspace/logs ${remoteDir}`, 30_000), "clore_restore_probe_dirs_failed");
      await installDetachedWorker(target);
      requireOk(scpFile(target, path.join(process.cwd(), "scripts", "clore", "restore-production-r2.py"), "/workspace/tools/restore-production-r2.py", 2 * 60_000), "clore_restore_probe_tool_upload_failed");
      requireOk(scpFile(target, local, remoteBundle, 2 * 60_000), "clore_restore_probe_bundle_upload_failed");
      const launched = await launchDetachedJob(target, { jobId, mode: "probe", bundlePath: remoteBundle });
      if (launched.returnedMs > 15_000) throw new Error("clore_restore_probe_launch_timeout");
      const completed = await waitForDetachedJob(target, jobId, 120_000);
      if (!completed.reachable || completed.state?.phase !== "completed") throw new Error("clore_restore_probe_failed");
      const result = completed.result as { probe?: Record<string, unknown> } | null;
      if (!result?.probe || result.probe.source !== "presigned_readonly_r2_model_objects") {
        throw new Error("clore_restore_probe_result_invalid");
      }
      const evidencePath = path.join(process.cwd(), ".secrets", "restore-throughput-probe-evidence.json");
      const evidencePart = `${evidencePath}.${process.pid}.part`;
      writeFileSync(evidencePart, `${JSON.stringify({
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        candidateId: candidate.id,
        signedUrlsPersisted: false,
        credentialsPersisted: false,
        probe: result.probe,
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(evidencePart, evidencePath);
      const qualification = result.probe.qualification as { passed?: boolean; reason?: string } | undefined;
      if (qualification?.passed !== true) {
        throw new Error(`clore_restore_probe_rejected:${String(qualification?.reason ?? "unknown")}`);
      }
      this.restoreQualifications.set(session.sessionId, result.probe);
      return result.probe;
    } finally {
      rmSync(local, { force: true });
      sshCommand(target, `rm -f ${remoteBundle}`, 30_000);
    }
  }

  async discardWanRestoreProbe(session: LongVideoProviderSession) {
    const { target } = await this.context(session);
    requireOk(sshCommand(
      target,
      "find /workspace/models -type d -name .restore-chunks -prune -exec rm -rf -- {} + 2>/dev/null || true; rm -f /workspace/logs/restore-probe-wan22-remix-14b-i2v-fp8.json",
      60_000,
    ), "clore_restore_probe_cleanup_failed");
    this.restoreQualifications.delete(session.sessionId);
  }

  async prepareFinalVideoInputs(session: LongVideoProviderSession) {
    const { target, projectId } = await this.context(session);
    const resolvedProject = getLongVideoProject(projectId, this.statePath);
    if (!resolvedProject) throw new Error("clore_finalization_project_missing");
    const segment0 = resolvedProject.segments[0];
    if (segment0.attemptsCount !== 1 || !segment0.selectedAttemptId) throw new Error("clore_segment0_boundary_invalid");
    const paths = buildLongVideoProjectPaths(this.libraryDir, resolvedProject.createdAt.slice(0, 10), resolvedProject.id);
    const attemptDir = path.join(paths.projectDir, "segments", "000", "attempts", segment0.selectedAttemptId);
    const mp4 = path.join(attemptDir, "output.mp4");
    const lastFrame = path.join(attemptDir, "last-frame.png");
    if (!existsSync(mp4) || !existsSync(lastFrame)) throw new Error("clore_segment0_media_missing");
    const remoteDir = `/workspace/finalize/${resolvedProject.id}`;
    requireOk(sshCommand(target, `mkdir -p ${remoteDir}`, 30_000), "clore_finalization_remote_dir_failed");
    requireOk(scpFile(target, mp4, `${remoteDir}/segment-0.mp4`, 10 * 60_000), "clore_segment0_upload_failed");
    requireOk(scpFile(target, lastFrame, `${remoteDir}/segment-0-last-frame.png`, 5 * 60_000), "clore_segment0_last_frame_upload_failed");
    const workflowPath = path.join(process.cwd(), "comfy-runtime", "workflows", "production", `wan22-remix-14b-i2v-fp8-${session.gpuProfile}-api.json`);
    requireOk(scpFile(target, workflowPath, `${remoteDir}/segment-1-workflow.json`, 2 * 60_000), "clore_segment1_workflow_upload_failed");
    const expectedMp4 = sha256File(mp4);
    const expectedLastFrame = sha256File(lastFrame);
    const proof = requireOk(sshCommand(
      target,
      `set -e; test "$(sha256sum ${remoteDir}/segment-0.mp4 | cut -d' ' -f1)" = "${expectedMp4}"; ` +
      `test "$(sha256sum ${remoteDir}/segment-0-last-frame.png | cut -d' ' -f1)" = "${expectedLastFrame}"; ` +
      `ffmpeg -version >/dev/null; ffprobe -version >/dev/null; ffmpeg -hide_banner -encoders 2>/dev/null | grep -E 'libx264|h264_nvenc' >/dev/null || true; ` +
      `printf '{"segment0Mp4Sha256":"${expectedMp4}","segment0LastFrameSha256":"${expectedLastFrame}","remoteDir":"${remoteDir}"}\\n'`,
      120_000,
    ), "clore_finalization_input_validation_failed");
    return JSON.parse(proof.trim()) as { segment0Mp4Sha256: string; segment0LastFrameSha256: string; remoteDir: string };
  }

  async restoreWan(session: LongVideoProviderSession) {
    if (session.gpuProfile === "rtx5090" && !this.restoreQualifications.has(session.sessionId)) {
      throw new Error("clore_rtx5090_restore_requires_actual_source_qualification");
    }
    const { target } = await this.context(session);
    return this.restoreFamily(target, "wan22-remix-14b-i2v-fp8");
  }

  async finalizeLongVideoRemote(session: LongVideoProviderSession, project: LongVideoProject) {
    const { target } = await this.context(session);
    if (project.id !== this.contexts.get(session.sessionId)?.projectId) throw new Error("clore_finalization_project_scope_mismatch");
    const segment0 = project.segments[0];
    const segment1 = project.segments[1];
    if (segment0.attemptsCount !== 1 || segment1.attemptsCount !== 1 || !segment0.selectedAttemptId || !segment1.selectedAttemptId) {
      throw new Error("clore_finalization_attempt_boundary_invalid");
    }
    const paths = buildLongVideoProjectPaths(this.libraryDir, project.createdAt.slice(0, 10), project.id);
    const segment0Mp4 = path.join(paths.projectDir, "segments", "000", "attempts", segment0.selectedAttemptId, "output.mp4");
    const segment1Mp4 = path.join(paths.projectDir, "segments", "001", "attempts", segment1.selectedAttemptId, "output.mp4");
    const remoteDir = `/workspace/finalize/${project.id}`;
    requireOk(sshCommand(target, `mkdir -p ${remoteDir}`, 30_000), "clore_finalization_remote_dir_failed");
    requireOk(scpFile(target, segment0Mp4, `${remoteDir}/segment-0.mp4`, 10 * 60_000), "clore_final_segment0_upload_failed");
    requireOk(scpFile(target, segment1Mp4, `${remoteDir}/segment-1.mp4`, 10 * 60_000), "clore_final_segment1_upload_failed");
    const concat = Buffer.from("file 'segment-0.mp4'\nfile 'segment-1.mp4'\n", "utf8").toString("base64");
    const command =
      `set -e; cd ${remoteDir}; echo ${concat} | base64 -d > concat.txt; ` +
      `rm -f master-720p.mp4 output.mp4 thumbnail.jpg merge-method.txt final-method.txt; ` +
      `if ffmpeg -y -v error -f concat -safe 0 -i concat.txt -c copy -movflags +faststart master-720p.mp4 && ` +
      `test "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,pix_fmt -of csv=p=0 master-720p.mp4)" = "h264,1280,720,yuv420p" && ` +
      `copy_duration="$(ffprobe -v error -show_entries format=duration -of csv=p=0 master-720p.mp4)" && ` +
      `awk -v d="$copy_duration" 'BEGIN { exit !(d >= 9.5 && d <= 11.0) }'; then echo concat_copy > merge-method.txt; ` +
      `else rm -f master-720p.mp4; ffmpeg -y -v error -f concat -safe 0 -i concat.txt -an -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart master-720p.mp4; echo concat_h264_fallback > merge-method.txt; fi; ` +
      `if ffmpeg -y -v error -hwaccel cuda -hwaccel_output_format cuda -i master-720p.mp4 -vf "scale_cuda=1920:1080:format=yuv420p" -an -c:v h264_nvenc -preset p7 -tune hq -cq 18 -b:v 0 -movflags +faststart output.mp4; ` +
      `then echo cuda_scale_h264_nvenc_p7_cq18 > final-method.txt; ` +
      `elif ffmpeg -y -v error -i master-720p.mp4 -vf "scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" -an -c:v h264_nvenc -preset p7 -tune hq -cq 18 -b:v 0 -pix_fmt yuv420p -movflags +faststart output.mp4; ` +
      `then echo lanczos_h264_nvenc_p7_cq18 > final-method.txt; ` +
      `else rm -f output.mp4; ffmpeg -y -v error -i master-720p.mp4 -vf "scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" -an -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart output.mp4; echo lanczos_libx264_crf18 > final-method.txt; fi; ` +
      `ffmpeg -y -v error -ss 1 -i output.mp4 -frames:v 1 -vf "scale=640:-2:force_original_aspect_ratio=decrease" -q:v 3 thumbnail.jpg; ` +
      `ffmpeg -v error -ss 1 -i master-720p.mp4 -frames:v 1 -f null -; ` +
      `ffmpeg -v error -ss 1 -i output.mp4 -frames:v 1 -f null -; ` +
      `ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt -show_entries format=duration,size -of json master-720p.mp4 > master-probe.json; ` +
      `ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt -show_entries format=duration,size -of json output.mp4 > output-probe.json; ` +
      `sha256sum master-720p.mp4 output.mp4 thumbnail.jpg > sha256.txt`;
    requireOk(sshCommand(target, command, 60 * 60_000), "clore_remote_finalization_failed");
    const masterPart = path.join(paths.projectDir, "master-720p.mp4.part");
    const finalPart = `${paths.finalVideo}.part`;
    const thumbnailPart = `${paths.finalThumbnail}.part`;
    rmSync(masterPart, { force: true }); rmSync(finalPart, { force: true }); rmSync(thumbnailPart, { force: true });
    requireOk(scpFromRemote(target, `${remoteDir}/master-720p.mp4`, masterPart, 20 * 60_000), "clore_master_download_failed");
    requireOk(scpFromRemote(target, `${remoteDir}/output.mp4`, finalPart, 20 * 60_000), "clore_final_download_failed");
    requireOk(scpFromRemote(target, `${remoteDir}/thumbnail.jpg`, thumbnailPart, 5 * 60_000), "clore_final_thumbnail_download_failed");
    const master = path.join(paths.projectDir, "master-720p.mp4");
    rmSync(master, { force: true }); rmSync(paths.finalVideo, { force: true }); rmSync(paths.finalThumbnail, { force: true });
    renameSync(masterPart, master); renameSync(finalPart, paths.finalVideo); renameSync(thumbnailPart, paths.finalThumbnail);
    const masterProbe = probeLongVideoMedia(master);
    const finalProbe = probeLongVideoMedia(paths.finalVideo);
    const masterVideo = masterProbe.streams.find((stream) => stream.codec_type === "video");
    const finalVideo = finalProbe.streams.find((stream) => stream.codec_type === "video");
    const masterDuration = Number(masterProbe.format.duration);
    const finalDuration = Number(finalProbe.format.duration);
    if (masterVideo?.width !== 1280 || masterVideo.height !== 720 || masterVideo.codec_name !== "h264" || masterVideo.pix_fmt !== "yuv420p" ||
        finalVideo?.width !== 1920 || finalVideo.height !== 1080 || finalVideo.codec_name !== "h264" || finalVideo.pix_fmt !== "yuv420p" ||
        !Number.isFinite(masterDuration) || masterDuration < 9.5 || masterDuration > 11 ||
        !Number.isFinite(finalDuration) || Math.abs(finalDuration - masterDuration) > 0.15) {
      throw new Error("clore_remote_finalization_media_invalid");
    }
    const methodsRaw = requireOk(sshCommand(target, `cat ${remoteDir}/merge-method.txt; cat ${remoteDir}/final-method.txt`, 30_000), "clore_finalization_method_read_failed").trim().split(/\r?\n/);
    const evidence = {
      schemaVersion: 1,
      generation_resolution: "1280x720",
      final_resolution: "1920x1080",
      native_1080p: false,
      segment_order: [0, 1],
      tail_frame_sha_linkage: segment0.attempts.find((attempt) => attempt.id === segment0.selectedAttemptId)?.evidenceSummary.lastFrameSha256,
      merge_method: methodsRaw[0] ?? "unknown",
      scaling_encoding_method: methodsRaw[1] ?? "unknown",
      master_sha256: sha256File(master),
      final_sha256: sha256File(paths.finalVideo),
      thumbnail_sha256: sha256File(paths.finalThumbnail),
      master_probe: masterProbe,
      final_probe: finalProbe,
      remote_finalization: true,
      created_at: new Date().toISOString(),
    };
    writeFileSync(path.join(paths.projectDir, "remote-finalization.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    return evidence;
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
    if (this.videoNegativePrompt) workflow["7"].inputs = { ...(workflow["7"].inputs ?? {}), text: this.videoNegativePrompt };
    workflow["8"].inputs = { ...(workflow["8"].inputs ?? {}), width: input.session.gpuProfile === "rtx5090" ? 1280 : 832, height: input.session.gpuProfile === "rtx5090" ? 720 : 480, length: 81, batch_size: 1 };
    workflow["11"].inputs = { ...(workflow["11"].inputs ?? {}), noise_seed: this.videoSeedBase + input.sequenceIndex };
    const result = runRemoteComfyWorkflow({ target, workflow, clientId: `lv-${input.attemptId.slice(0, 12)}`, kind: "video", timeoutSeconds: 90 * 60, executionId: input.attemptId });
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
    this.restoreQualifications.delete(session.sessionId);
    this.contexts.delete(session.sessionId);
    if (this.contexts.size === 0) this.authorizedProjectId = null;
    void billing;
  }
}
