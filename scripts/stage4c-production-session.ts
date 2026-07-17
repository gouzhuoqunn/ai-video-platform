import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { getGpuProvider } from "./gpu-providers";
import { FIXED_RUNTIME_DIGEST, sanitizeGpuTarget, scpFile, scpFromRemote, sleep, sshCommand } from "./gpu-providers/common";
import type { GpuCandidate, GpuSession, GpuTarget } from "./gpu-providers/types";
import { setCloreDeploymentHold } from "./clore/deployment-hold";
import { clearManualParitySecrets } from "./clore/manual-parity";
import { LOCAL_WATCHDOG_TASK_NAME } from "./clore/watchdog-io";
import { readGpuBillingStatus } from "./gpu-billing-status";
import { billingSafetyBlockers } from "./clore/support-acknowledgement";
import { buildRuntimeOverlay } from "./runtime-overlay";
import { buildRestoreBundle } from "./model-cache/production-restore-bundle";
import { buildDetachedLaunchCommand, installDetachedWorker, inspectRemoteJob, launchDetachedJob, remoteJobDir, stopDetachedJob, waitForDetachedJob } from "./clore/detached-remote-job";
import { installRemoteComfyRunner, runRemoteComfyProbe, runRemoteComfyWorkflow, downloadRemoteRunnerOutputPersistent, removeRemoteRunnerOutput, type RemoteRunnerResult } from "./comfy-remote-runner";
import { validatePngPixels } from "./flux-first-image-executor";
import { archiveFluxFirstImage } from "./flux-first-image";
import { archiveStage3OWanVideo, probeMedia } from "./stage3o-wan-executor";
import { STAGE4A_BATCH_ID, STAGE4A_IMAGE_TASK_ID, STAGE4A_VIDEO_TASK_ID, prepareStage4AFinalBatch } from "./stage4a-final-batch";
import { readGenerationPool, setGenerationTaskStatus } from "../src/lib/generation/task-pool";

type Json = Record<string, unknown>;
type WorkflowNode = { class_type: string; inputs: Record<string, unknown> };
type Evidence = Json & { started_at: string; events: Json[] };

const LIMITS = { maxActiveOrders: 1, maxHostAttempts: 2, maxFailedDeploymentSpendUsd: 0.4, maxTotalSpendUsd: 2, wallClockMinutes: 180, drainingMinutes: 165, preserveSuccessfulImage: true } as const;
const CREATION_FEE_USD = 0.1;
const SECRET_DIR = path.join(process.cwd(), ".secrets");
const AUTH = path.join(SECRET_DIR, "stage4d-operator-authorization.json");
const AUTH_CONSUMING = path.join(SECRET_DIR, "stage4d-operator-authorization.consuming.json");
const AUTH_CONSUMED = path.join(SECRET_DIR, "stage4d-operator-authorization.consumed.json");
const EVIDENCE_PATH = path.join(SECRET_DIR, "stage4d-session-evidence.json");
const IMAGE_FAMILY = "ultrareal-flux1-dev-fp8";
const VIDEO_FAMILY = "wan22-remix-14b-i2v-fp8";
const IMAGE_LIBRARY = "D:\\AI-Creative-Library";
const VIDEO_LIBRARY = "D:\\AI-Video-Library";
const IMAGE_PROMPT = "A cinematic realistic view of a futuristic white research station beside a clear blue ocean at sunset, warm natural light, detailed clouds, clean architecture";
const VIDEO_PROMPT = "The generated research station remains consistent while gentle ocean waves move and clouds drift slowly, subtle cinematic camera movement, realistic lighting";

function requireSuccess(result: { status: number | null; stderr?: string | Buffer | null; stdout?: string | Buffer | null; error?: Error }, code: string) {
  if (result.status !== 0) throw new Error(`${code}:${String(result.error?.message ?? result.stderr ?? result.stdout ?? `exit_${result.status}`).trim().slice(-4000)}`);
  return String(result.stdout ?? "");
}
function npmCommand(args: string[]) { return process.platform === "win32" ? { command: "cmd.exe", args: ["/c", "npm", ...args] } : { command: "npm", args }; }
function runNpm(args: string[], timeoutMs = 180_000) { const value = npmCommand(args); return spawnSync(value.command, value.args, { cwd: process.cwd(), encoding: "utf8", timeout: timeoutMs }); }
function safe(value: unknown) { return String(value ?? "").replace(/https:\/\/[^\s"]+\?[^\s"]+/g, "<redacted-url>").replace(/(token|secret|password|authorization)[=:][^\s]+/gi, "$1=<redacted>").slice(-12_000); }
function writeEvidence(evidence: Evidence) { mkdirSync(SECRET_DIR, { recursive: true }); const part = `${EVIDENCE_PATH}.part`; writeFileSync(part, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(part, EVIDENCE_PATH); }
function event(evidence: Evidence, name: string, detail: Json = {}) { evidence.events.push({ at: new Date().toISOString(), name, ...detail }); writeEvidence(evidence); }
function sha(filePath: string) { const bytes = readFileSync(filePath); return { size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; }
function jobDir(library: string, id: string) { return path.join(library, new Date().toISOString().slice(0, 10), id); }
function disableLocalWatchdog() { return process.platform === "win32" ? spawnSync("schtasks.exe", ["/Change", "/TN", LOCAL_WATCHDOG_TASK_NAME, "/Disable"], { encoding: "utf8", timeout: 30_000 }) : { status: 0 }; }

export function rankStage4CCandidates(candidates: GpuCandidate[]) {
  const preferred = new Map([["29167", 0], ["105178", 1]]);
  return candidates.filter((candidate) =>
    /RTX\s*(4090|5090)/i.test(candidate.gpuType) &&
    candidate.vramGb >= 23 &&
    candidate.minimumRamGb >= 32 &&
    candidate.containerDiskGb >= 200 &&
    candidate.interruptible === false &&
    candidate.hourlyUsd !== null &&
    candidate.hourlyUsd <= 0.7 &&
    candidate.hourlyUsd * 180 / 60 + CREATION_FEE_USD <= LIMITS.maxTotalSpendUsd
  ).sort((left, right) =>
    (preferred.get(left.id) ?? 99) - (preferred.get(right.id) ?? 99) ||
    Number(right.minimumRamGb >= 64) - Number(left.minimumRamGb >= 64) ||
    (right.reliability ?? -1) - (left.reliability ?? -1) ||
    ((right.downloadMbps ?? 0) + (right.uploadMbps ?? 0)) - ((left.downloadMbps ?? 0) + (left.uploadMbps ?? 0)) ||
    (left.hourlyUsd ?? Infinity) - (right.hourlyUsd ?? Infinity)
  );
}

export function createStage4CAuthorization(now = new Date()) {
  mkdirSync(SECRET_DIR, { recursive: true });
  for (const file of [AUTH, AUTH_CONSUMING, AUTH_CONSUMED]) rmSync(file, { force: true });
  const unsigned = { batch_id: STAGE4A_BATCH_ID, provider: "clore", one_use: true, created_at: now.toISOString(), expires_at: new Date(now.getTime() + LIMITS.wallClockMinutes * 60_000).toISOString(), limits: LIMITS, nonce: randomBytes(24).toString("base64url") };
  const value = { ...unsigned, integrity_sha256: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") };
  writeFileSync(`${AUTH}.part`, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(`${AUTH}.part`, AUTH);
  return value;
}
function consumeAuthorization() { if (!existsSync(AUTH)) throw new Error("stage4c_authorization_missing"); renameSync(AUTH, AUTH_CONSUMING); }
function finishAuthorization() { if (existsSync(AUTH_CONSUMING)) renameSync(AUTH_CONSUMING, AUTH_CONSUMED); }

function workflow(name: string) {
  return JSON.parse(readFileSync(path.join(process.cwd(), "comfy-runtime", "workflows", "production", name), "utf8")) as Record<string, WorkflowNode>;
}
function requiredNodes(value: Record<string, WorkflowNode>) { return [...new Set(Object.values(value).map((node) => node.class_type))]; }

async function preflight(evidence: Evidence) {
  const billing = await readGpuBillingStatus(); const blockers = billingSafetyBlockers(billing);
  if (blockers.length) throw new Error(`stage4c_preflight:${blockers.join(";")}`);
  if (billing.clore.activeOrders !== 0 || billing.runpod.activePods !== 0 || billing.runpod.networkVolumes !== 0) throw new Error("stage4c_resources_not_zero");
  if (!billing.holds.clore || !billing.holds.runpod) throw new Error("stage4c_holds_not_enabled");
  setGenerationTaskStatus([STAGE4A_IMAGE_TASK_ID, STAGE4A_VIDEO_TASK_ID], "armed", { stage4dRetry: true, inferenceVerified: false });
  const pool = prepareStage4AFinalBatch(); if (pool.completed) throw new Error("stage4d_tasks_already_completed");
  const ffmpeg = require("@ffmpeg-installer/ffmpeg") as { path: string }; const ffprobe = require("@ffprobe-installer/ffprobe") as { path: string };
  requireSuccess(spawnSync(ffmpeg.path, ["-version"], { encoding: "utf8", timeout: 30_000 }), "stage4c_ffmpeg_missing");
  requireSuccess(spawnSync(ffprobe.path, ["-version"], { encoding: "utf8", timeout: 30_000 }), "stage4c_ffprobe_missing");
  for (const library of [IMAGE_LIBRARY, VIDEO_LIBRARY]) {
    mkdirSync(library, { recursive: true }); const probe = path.join(library, `.stage4c-write-${process.pid}`); writeFileSync(probe, "ok"); rmSync(probe);
  }
  const imageWorkflow = workflow("ultrareal-flux1-dev-fp8-rtx4090-api.json");
  const videoWorkflow = workflow("wan22-remix-14b-i2v-fp8-rtx4090-api.json");
  const authorization = createStage4CAuthorization();
  event(evidence, "preflight", { billing, authorization: { one_use: true, expires_at: authorization.expires_at, limits: LIMITS }, task_ids: [STAGE4A_IMAGE_TASK_ID, STAGE4A_VIDEO_TASK_ID], ffmpeg: ffmpeg.path, ffprobe: ffprobe.path, image_workflow_nodes: requiredNodes(imageWorkflow), video_workflow_nodes: requiredNodes(videoWorkflow) });
}

function armWatchdogs(serverId: string) {
  requireSuccess(runNpm(["run", "clore:watchdog:local:install"]), "stage4c_watchdog_install_failed");
  requireSuccess(runNpm(["run", "clore:watchdog:remote:arm", "--", `--server-id=${serverId}`, "--hard-deadline-minutes=180", "--hard-budget-usd=2.0"], 180_000), "stage4c_watchdog_arm_failed");
}

async function acquire(evidence: Evidence) {
  process.env.CLORE_ORDER_EXECUTION_ENABLED = "true"; process.env.CLORE_FIRST_SESSION_MAX_BUDGET_USD = "2";
  process.env.CLORE_HARD_SESSION_LIMIT_MINUTES = "180"; process.env.CLORE_MAX_GPU_PRICE_PER_HOUR = "0.70";
  const provider = getGpuProvider("clore"); const candidates = rankStage4CCandidates(await provider.listCandidates());
  if (!candidates.length) throw new Error("stage4c_no_compliant_candidate");
  event(evidence, "candidates", { selected_order: candidates.slice(0, 8).map((item) => ({ id: item.id, gpu: item.gpuType, vram_gb: item.vramGb, ram_gb: item.minimumRamGb, disk_gb: item.containerDiskGb, hourly_usd: item.hourlyUsd, reliability: item.reliability, download_mbps: item.downloadMbps, upload_mbps: item.uploadMbps })) });
  let failedSpend = 0; let createStarted = false;
  for (let attempt = 0; attempt < Math.min(2, candidates.length); attempt += 1) {
    const candidate = candidates[attempt]; let session: GpuSession | null = null;
    if (failedSpend + CREATION_FEE_USD > LIMITS.maxFailedDeploymentSpendUsd) throw new Error("stage4c_failed_deployment_budget_exhausted");
    armWatchdogs(candidate.id); setCloreDeploymentHold(false, "stage4c_operator_authorized");
    try {
      session = await provider.createSession({ sessionId: STAGE4A_BATCH_ID, candidate, sshPublicKey: "managed-by-clore-provider", bootstrapImage: FIXED_RUNTIME_DIGEST, dryRun: false, cloreProfile: "clore_key_only", beforeCreateRequest: () => { if (!createStarted) consumeAuthorization(); createStarted = true; }, afterCreateRequestAttempt: () => finishAuthorization() });
      event(evidence, "order_created", { attempt: attempt + 1, order_id: session.id, server_id: candidate.id, gpu: candidate.gpuType, hourly_usd: candidate.hourlyUsd, state: session.status });
      const target = await provider.waitForSsh(session, 10 * 60_000);
      requireSuccess(sshCommand(target, "mkdir -p /workspace && printf key-ssh-ok", 60_000), "stage4c_key_ssh_failed");
      event(evidence, "ssh_ready", { endpoint: `${target.host}:${target.port}`, exact_target: sanitizeGpuTarget(target), key_only: true });
      return { provider, candidate, session, target, failedSpend };
    } catch (error) {
      session ??= await provider.recoverExistingSession(STAGE4A_BATCH_ID); let spend = createStarted ? CREATION_FEE_USD : 0;
      if (session) { try { spend += (await provider.getBilling(session)).estimatedSpendUsd ?? 0; } catch { /* wallet delta used later */ } await provider.terminateSession(session); }
      failedSpend = Number((failedSpend + spend).toFixed(4)); event(evidence, "pre_ssh_host_failed", { attempt: attempt + 1, server_id: candidate.id, spend_usd: spend, failed_spend_usd: failedSpend, error: safe(error instanceof Error ? error.message : error) });
      setCloreDeploymentHold(true, "stage4c_pre_ssh_failure"); runNpm(["run", "clore:watchdog:remote:disarm"]); disableLocalWatchdog(); clearManualParitySecrets();
      if (!createStarted || attempt + 1 >= 2 || failedSpend >= LIMITS.maxFailedDeploymentSpendUsd) throw error;
    }
  }
  throw new Error("stage4c_no_ssh_session");
}

function inspectHardware(target: GpuTarget) {
  const command = "set -e; mkdir -p /workspace; echo '=== gpu ==='; nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version --format=csv,noheader; echo '=== nvidia_smi ==='; nvidia-smi; echo '=== cpu_ram ==='; free -b; nproc; echo '=== disks ==='; df -B1 / /workspace; echo '=== python ==='; python3 --version; echo '=== docker ==='; if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo docker_available=true; docker version; else echo docker_available=false; fi; echo '=== network ==='; curl -L -sS --max-time 20 -o /dev/null -w 'download_bytes=%{size_download} speed_bytes_per_second=%{speed_download} http_code=%{http_code}\\n' 'https://speed.cloudflare.com/__down?bytes=1000000' || echo network_probe_failed";
  return requireSuccess(sshCommand(target, command, 180_000), "stage4c_hardware_inspection_failed");
}

async function bootstrap(target: GpuTarget, evidence: Evidence) {
  const overlay = buildRuntimeOverlay(); const script = path.join(process.cwd(), "scripts", "clore", "clore-light-bootstrap.sh");
  requireSuccess(scpFile(target, overlay.outputPath, "/workspace/runtime-overlay.tgz", 5 * 60_000), "stage4c_overlay_upload_failed");
  requireSuccess(scpFile(target, script, "/workspace/clore-light-bootstrap.sh", 2 * 60_000), "stage4c_bootstrap_upload_failed");
  const modeText = requireSuccess(sshCommand(target, "sed -i 's/\\r$//' /workspace/clore-light-bootstrap.sh; chmod 700 /workspace/clore-light-bootstrap.sh; /workspace/clore-light-bootstrap.sh prepare /workspace/runtime-overlay.tgz", 55 * 60_000), "stage4c_runtime_prepare_failed");
  requireSuccess(sshCommand(target, `/workspace/clore-light-bootstrap.sh start ${target.gpuProfile}`, 90_000), "stage4c_runtime_start_failed");
  const image = workflow("ultrareal-flux1-dev-fp8-rtx4090-api.json"); const video = workflow("wan22-remix-14b-i2v-fp8-rtx4090-api.json");
  const nodes = [...new Set([...requiredNodes(image), ...requiredNodes(video)])];
  const nodeProbe = Buffer.from(`import json,sys;d=json.load(sys.stdin);m=sorted(set(${JSON.stringify(nodes)})-set(d));print("missing="+",".join(m));raise SystemExit(1 if m else 0)`).toString("base64");
  const check = `set -e; curl -fsS http://127.0.0.1:8080/healthz >/dev/null; curl -fsS http://127.0.0.1:8188/system_stats >/dev/null; curl -fsS http://127.0.0.1:8188/object_info | python3 -c "import base64;exec(base64.b64decode('${nodeProbe}'))"; test -r /workspace/comfy-user/comfyui.db`;
  const deadline = Date.now() + 8 * 60_000; let healthy = false; while (Date.now() < deadline) { if (sshCommand(target, check, 30_000).status === 0) { healthy = true; break; } await sleep(5_000); }
  if (!healthy) throw new Error("stage4c_runtime_health_failed");
  const cuda = requireSuccess(sshCommand(target, "set -e; mode=$(cat /workspace/ai-runtime/bootstrap-mode); if [ \"$mode\" = docker ]; then docker exec stage3m-comfy-runtime python3 -c 'import torch,triton;print(\"python_torch=\"+torch.__version__);print(\"cuda=\"+str(torch.version.cuda));print(\"available=\"+str(torch.cuda.is_available()).lower());print(\"device=\"+torch.cuda.get_device_name(0));print(\"triton=\"+triton.__version__);assert torch.cuda.is_available()'; else /workspace/ai-runtime/venv/bin/python -c 'import torch,triton;print(\"python_torch=\"+torch.__version__);print(\"cuda=\"+str(torch.version.cuda));print(\"available=\"+str(torch.cuda.is_available()).lower());print(\"device=\"+torch.cuda.get_device_name(0));print(\"triton=\"+triton.__version__);assert torch.cuda.is_available()'; fi", 180_000), "stage4c_cuda_failed");
  installRemoteComfyRunner(target); const runner = runRemoteComfyProbe(target); const mode = modeText.trim().split(/\r?\n/).at(-1) ?? "unknown";
  event(evidence, "runtime_healthy", { bootstrap_mode: mode, cuda_torch_triton: cuda, controller: true, comfyui: true, sqlite: true, object_info: true, required_nodes: nodes, runner });
  return { mode, cuda, runner };
}

async function detachedCanary(target: GpuTarget, evidence: Evidence) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const jobId = `stage4d-canary-${randomUUID().slice(0, 8)}`;
    try {
      await installDetachedWorker(target);
      const launch = await launchDetachedJob(target, { jobId, mode: "canary" });
      event(evidence, "canary_launched", { attempt, job_id: jobId, returned_ms: launch.returnedMs, transport_timed_out: launch.transportTimedOut });
      if (launch.returnedMs > 15_000) throw new Error("canary_launcher_exceeded_15_seconds");
      await sleep(12_000);
      const first = inspectRemoteJob(target, jobId);
      if (!first.reachable || !first.state || !first.alive || first.state.phase !== "running") throw new Error("canary_not_observable_after_disconnect");
      const firstHeartbeat = first.state.last_heartbeat_at;
      await sleep(12_000);
      const second = inspectRemoteJob(target, jobId);
      if (!second.reachable || !second.state || second.state.last_heartbeat_at <= firstHeartbeat) throw new Error("canary_heartbeat_did_not_advance");
      const completed = await waitForDetachedJob(target, jobId, 120_000);
      if (!completed.reachable || !completed.result || completed.state?.phase !== "completed") throw new Error("canary_result_invalid");
      event(evidence, "canary_completed", { attempt, job_id: jobId, survived_disconnect: true, second_connection_observed_running: true, heartbeat_advanced: true, result: completed.result });
      sshCommand(target, `rm -rf ${remoteJobDir(jobId)}`, 30_000);
      return { jobId, launch, completed };
    } catch (error) {
      stopDetachedJob(target, jobId);
      event(evidence, "canary_attempt_failed", { attempt, job_id: jobId, error: safe(error instanceof Error ? error.message : error) });
      if (attempt === 1) event(evidence, "canary_in_place_repair", { action: "recreate_tools_directory_and_reinstall_worker", next_attempt: 2 });
    }
  }
  const handoff = await manualHandoff(target, evidence, `stage4d-canary-${randomUUID().slice(0, 8)}`, "canary");
  const completed = handoff.state?.phase === "completed" ? handoff : await waitForDetachedJob(target, handoff.state!.job_id, 120_000);
  return { jobId: handoff.state!.job_id, launch: { returnedMs: 0, transportTimedOut: false, stdout: "manual_handoff" }, completed };
}

async function manualHandoff(target: GpuTarget, evidence: Evidence, jobId: string, mode: "canary" | "restore", bundlePath?: string) {
  const artifactDir = path.join(process.cwd(), "artifacts", "stage4d"); mkdirSync(artifactDir, { recursive: true });
  const remoteScript = path.join(artifactDir, "manual-restore-remote.sh");
  const localScript = path.join(artifactDir, "manual-restore.ps1");
  const statusFile = path.join(artifactDir, "manual-status.txt");
  const remoteCommand = buildDetachedLaunchCommand({ jobId, mode, bundlePath });
  writeFileSync(remoteScript, `#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p /workspace/tools\nchmod 700 /workspace/tools/detached-job-worker.py\n${remoteCommand}\n`, "utf8");
  const host = target.host.replace(/'/g, "''"); const username = target.username.replace(/'/g, "''");
  writeFileSync(localScript, `param([Parameter(Mandatory=$true)][string]$KeyPath)\n$ErrorActionPreference = 'Stop'\n$root = (Resolve-Path (Join-Path $PSScriptRoot '..\\..')).Path\n$sshBase = @('-i',$KeyPath,'-o','StrictHostKeyChecking=accept-new','-o','PasswordAuthentication=no','-o','BatchMode=yes','-o','ConnectTimeout=15','-p','${target.port}','${username}@${host}')\n& ssh @sshBase 'mkdir -p /workspace/tools'\nif ($LASTEXITCODE -ne 0) { throw 'manual remote directory failed' }\n& scp -i $KeyPath -o StrictHostKeyChecking=accept-new -o PasswordAuthentication=no -o BatchMode=yes -P ${target.port} (Join-Path $root 'scripts\\clore\\detached-job-worker.py') '${username}@${host}:/workspace/tools/detached-job-worker.py'\nif ($LASTEXITCODE -ne 0) { throw 'manual worker upload failed' }\n& scp -i $KeyPath -o StrictHostKeyChecking=accept-new -o PasswordAuthentication=no -o BatchMode=yes -P ${target.port} (Join-Path $PSScriptRoot 'manual-restore-remote.sh') '${username}@${host}:/workspace/tools/manual-restore-remote.sh'\nif ($LASTEXITCODE -ne 0) { throw 'manual launcher upload failed' }\n& ssh @sshBase 'chmod 700 /workspace/tools/manual-restore-remote.sh && /workspace/tools/manual-restore-remote.sh'\nif ($LASTEXITCODE -ne 0) { throw 'manual launch failed' }\n`, "utf8");
  const safeCommand = `powershell -NoProfile -ExecutionPolicy Bypass -File "${localScript}" -KeyPath $env:CLORE_SSH_KEY_PATH`;
  writeFileSync(statusFile, `MANUAL_HANDOFF_REQUIRED\ncreated_at=${new Date().toISOString()}\nendpoint=${target.host}:${target.port}\njob_id=${jobId}\nmode=${mode}\ncommand=${safeCommand}\n`, "utf8");
  console.log("MANUAL_HANDOFF_REQUIRED"); console.log(safeCommand);
  event(evidence, "manual_handoff_required", { endpoint: `${target.host}:${target.port}`, job_id: jobId, mode, command: safeCommand, secrets_in_artifacts: false });
  const handoffStarted = Date.now() / 1000; const deadline = Math.min(Date.now() + 15 * 60_000, Date.parse(evidence.started_at) + LIMITS.drainingMinutes * 60_000);
  while (Date.now() < deadline) {
    const observed = inspectRemoteJob(target, jobId);
    if (observed.reachable && observed.state && observed.state.started_at >= handoffStarted && ["running", "completed"].includes(observed.state.phase)) {
      event(evidence, "manual_handoff_detected", { job_id: jobId, phase: observed.state.phase, pid: observed.pid });
      return observed;
    }
    await sleep(20_000);
  }
  throw new Error(`manual_handoff_timeout:${jobId}`);
}

async function restoreFamily(target: GpuTarget, family: string, evidence: Evidence, parallel = 3) {
  const bundle = await buildRestoreBundle(family, 7200); bundle.parallelDownloads = parallel;
  const local = path.join(os.tmpdir(), `stage4c-${family}-${randomUUID()}.json`); writeFileSync(local, `${JSON.stringify(bundle)}\n`, { mode: 0o600 });
  const jobId = `stage4d-${family}-${randomUUID().slice(0, 8)}`; const dir = remoteJobDir(jobId); const remoteBundle = `${dir}/bundle.json`;
  try {
    requireSuccess(sshCommand(target, `mkdir -p /workspace/tools /workspace/logs ${dir}`, 30_000), "stage4d_restore_dirs_failed");
    await installDetachedWorker(target);
    requireSuccess(scpFile(target, path.join(process.cwd(), "scripts", "clore", "restore-production-r2.py"), "/workspace/tools/restore-production-r2.py", 2 * 60_000), "stage4c_restore_tool_upload_failed");
    requireSuccess(scpFile(target, local, remoteBundle, 2 * 60_000), "stage4d_restore_bundle_upload_failed");
    const started = Date.now();
    let launch = { returnedMs: 0, transportTimedOut: false, stdout: "" };
    let initial: ReturnType<typeof inspectRemoteJob> | null = null;
    for (let attempt = 1; attempt <= 2 && !(initial?.reachable && initial.state); attempt += 1) {
      try {
        if (attempt > 1) {
          const existing = inspectRemoteJob(target, jobId);
          if (existing.reachable && existing.state) { initial = existing; break; }
          await installDetachedWorker(target);
          event(evidence, "restore_launcher_in_place_repair", { family, job_id: jobId, attempt });
        }
        launch = await launchDetachedJob(target, { jobId, mode: "restore", bundlePath: remoteBundle });
        initial = inspectRemoteJob(target, jobId);
        if (launch.transportTimedOut) {
          event(evidence, "restore_launch_transport_timeout", { family, job_id: jobId, attempt, reclassified_from_fresh_observation: initial.reachable ? initial.state?.phase ?? "not_created" : "ssh_temporarily_unreachable" });
          for (let reconnect = 0; reconnect < 3 && (!initial.reachable || !initial.state); reconnect += 1) { await sleep(10_000); initial = inspectRemoteJob(target, jobId); }
        }
        if (!initial.reachable || !initial.state) throw new Error(`remote_job_not_created:${family}`);
      } catch (error) {
        event(evidence, "restore_launcher_attempt_failed", { family, job_id: jobId, attempt, error: safe(error instanceof Error ? error.message : error) });
        initial = null;
      }
    }
    if (!initial?.reachable || !initial.state) initial = await manualHandoff(target, evidence, jobId, "restore", remoteBundle);
    if (!initial.reachable || !initial.state) throw new Error(`stage4d_restore_launch_state_missing:${family}`);
    event(evidence, "restore_started", { family, job_id: jobId, pid: initial.pid, launcher_returned_ms: launch.returnedMs, transport_timed_out: launch.transportTimedOut, parallel_downloads: parallel, restore_bytes: bundle.restoreBytes, shared_object_keys: bundle.sharedObjectKeys });
    const completed = initial.state.phase === "completed" ? initial : await waitForDetachedJob(target, jobId, 100 * 60_000, (status, classification) => {
      if (status.reachable && status.state) event(evidence, "restore_poll", { family, job_id: jobId, classification, phase: status.state.phase, completed_bytes: status.state.completed_bytes, total_bytes: status.state.total_bytes, current_object: status.state.current_object, heartbeat_at: status.state.last_heartbeat_at });
    });
    if (!completed.reachable || !completed.state) throw new Error(`stage4d_restore_completion_state_missing:${family}`);
    const text = requireSuccess(sshCommand(target, `cat /workspace/logs/restore-${family}.json`, 30_000), "stage4d_restore_progress_read_failed").trim();
    const last = JSON.parse(text) as Json;
    requireSuccess(sshCommand(target, `rm -f ${remoteBundle}`, 30_000), "stage4d_restore_bundle_cleanup_failed");
    const result = { family, job_id: jobId, elapsed_ms: Date.now() - started, lifecycle: completed.state, progress: last, direct_r2: true, admin_credentials_on_gpu: false, parallel_downloads: parallel };
    event(evidence, "restore_completed", result); return result;
  } finally { rmSync(local, { force: true }); }
}

function downloadImage(target: GpuTarget, result: RemoteRunnerResult) {
  const remote = result.staged_path; if (typeof remote !== "string" || !remote.startsWith("/workspace/runtime-tools/results/")) throw new Error("stage4c_image_remote_path_invalid");
  const local = path.join(os.tmpdir(), `stage4c-${randomUUID()}.png`); const part = `${local}.part`;
  requireSuccess(scpFromRemote(target, remote, part, 30 * 60_000), "stage4c_image_download_failed"); renameSync(part, local);
  const pixels = validatePngPixels(readFileSync(local)); return { local, pixels };
}

async function imagePhase(target: GpuTarget, runtime: Json, evidence: Evidence) {
  const restore = await restoreFamily(target, IMAGE_FAMILY, evidence, 3);
  let value = workflow("ultrareal-flux1-dev-fp8-rtx4090-api.json"); value["3"].inputs.text = IMAGE_PROMPT; let oom = false; const started = Date.now();
  let result: RemoteRunnerResult;
  try { result = runRemoteComfyWorkflow({ target, workflow: value as unknown as Record<string, unknown>, clientId: STAGE4A_IMAGE_TASK_ID, kind: "image", timeoutSeconds: 60 * 60 }); }
  catch (error) {
    if (!/out of memory|cuda.*memory|\boom\b/i.test(safe(error instanceof Error ? error.message : error))) throw error;
    requireSuccess(sshCommand(target, "curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"unload_models\":true,\"free_memory\":true}' http://127.0.0.1:8188/free >/dev/null", 60_000), "stage4c_image_oom_clear_failed");
    value = workflow("ultrareal-flux1-dev-fp8-rtx4090-api.json"); value["3"].inputs.text = IMAGE_PROMPT; value["6"].inputs.width = 768; value["6"].inputs.height = 768; oom = true;
    result = runRemoteComfyWorkflow({ target, workflow: value as unknown as Record<string, unknown>, clientId: `${STAGE4A_IMAGE_TASK_ID}-768`, kind: "image", timeoutSeconds: 60 * 60 });
  }
  const downloaded = downloadImage(target, result); const inferenceMs = Date.now() - started;
  const archived = archiveFluxFirstImage({ sourcePng: downloaded.local, sessionId: STAGE4A_IMAGE_TASK_ID, workflow: value as never, metadata: { job_id: STAGE4A_IMAGE_TASK_ID, prompt_id: result.prompt_id, model: IMAGE_FAMILY, width: value["6"].inputs.width, height: value["6"].inputs.height, steps: 50, seed: 20260715, batch: 1, oom_fallback_used: oom, png_validation: downloaded.pixels }, evidence: { stage: "4C", runtime, restore, inference_elapsed_ms: inferenceMs, remote_runner: result } });
  rmSync(downloaded.local, { force: true }); removeRemoteRunnerOutput(target, result);
  writeFileSync(path.join(archived.archiveDir, "provider-session.json"), `${JSON.stringify({ order_id: evidence.order_id, endpoint: evidence.ssh_endpoint, candidate: evidence.candidate }, null, 2)}\n`);
  writeFileSync(path.join(archived.archiveDir, "restore-evidence.json"), `${JSON.stringify(restore, null, 2)}\n`);
  setGenerationTaskStatus([STAGE4A_IMAGE_TASK_ID], "completed", { outputPath: archived.outputPath, outputSha256: archived.sha256, inferenceVerified: true, oomFallbackUsed: oom });
  event(evidence, "image_completed", { ...archived, inference_ms: inferenceMs, oom_fallback_used: oom, png_validation: downloaded.pixels });
  return { ...archived, workflow: value, inferenceMs, restore, oom };
}

function unload(target: GpuTarget, evidence: Evidence) {
  requireSuccess(sshCommand(target, "set -e; curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"unload_models\":true,\"free_memory\":true}' http://127.0.0.1:8188/free >/dev/null; mode=$(cat /workspace/ai-runtime/bootstrap-mode); if [ \"$mode\" = docker ]; then docker exec stage3m-comfy-runtime python3 -c 'import gc,torch;gc.collect();torch.cuda.empty_cache()'; else /workspace/ai-runtime/venv/bin/python -c 'import gc,torch;gc.collect();torch.cuda.empty_cache()'; fi; nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader; free -b", 180_000), "stage4c_unload_failed");
  event(evidence, "image_models_unloaded", { cuda_cache_cleared: true });
}

function remoteMp4Fallback(target: GpuTarget, result: RemoteRunnerResult, destinationDir: string) {
  const source = result.staged_path; if (typeof source !== "string" || !source.startsWith("/workspace/runtime-tools/results/")) throw new Error("stage4c_video_remote_path_invalid");
  const remote = "/workspace/runtime-tools/results/stage4c-browser.mp4";
  const command = `set -e; rm -f ${remote}.part ${remote}; if command -v ffmpeg >/dev/null 2>&1; then ffmpeg -y -i ${source} -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart -f mp4 ${remote}.part; else docker exec stage3m-comfy-runtime ffmpeg -y -i ${source} -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart -f mp4 ${remote}.part; fi; test -s ${remote}.part; mv ${remote}.part ${remote}`;
  requireSuccess(sshCommand(target, command, 20 * 60_000), "stage4c_remote_mp4_failed");
  const local = path.join(destinationDir, "output.mp4.remote.part"); requireSuccess(scpFromRemote(target, remote, local, 30 * 60_000), "stage4c_remote_mp4_download_failed"); probeMedia(local); return local;
}

async function videoPhase(target: GpuTarget, image: Awaited<ReturnType<typeof imagePhase>>, runtime: Json, evidence: Evidence) {
  const restore = await restoreFamily(target, VIDEO_FAMILY, evidence, 3);
  requireSuccess(scpFile(target, image.outputPath, "/workspace/comfy-input/stage4c-ultrareal-input.png", 10 * 60_000), "stage4c_input_image_upload_failed");
  let value = workflow("wan22-remix-14b-i2v-fp8-rtx4090-api.json"); value["5"].inputs.image = "stage4c-ultrareal-input.png"; value["6"].inputs.text = VIDEO_PROMPT; let oom = false; const started = Date.now();
  let result: RemoteRunnerResult;
  try { result = runRemoteComfyWorkflow({ target, workflow: value as unknown as Record<string, unknown>, clientId: STAGE4A_VIDEO_TASK_ID, kind: "video", timeoutSeconds: 90 * 60 }); }
  catch (error) {
    if (!/out of memory|cuda.*memory|\boom\b/i.test(safe(error instanceof Error ? error.message : error))) throw error;
    requireSuccess(sshCommand(target, "curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"unload_models\":true,\"free_memory\":true}' http://127.0.0.1:8188/free >/dev/null", 60_000), "stage4c_video_oom_clear_failed");
    value = workflow("wan22-remix-14b-i2v-fp8-rtx4090-api.json"); value["5"].inputs.image = "stage4c-ultrareal-input.png"; value["6"].inputs.text = VIDEO_PROMPT; value["8"].inputs.width = 640; value["8"].inputs.height = 368; oom = true;
    result = runRemoteComfyWorkflow({ target, workflow: value as unknown as Record<string, unknown>, clientId: `${STAGE4A_VIDEO_TASK_ID}-low`, kind: "video", timeoutSeconds: 90 * 60 });
  }
  const inferenceMs = Date.now() - started; const dir = jobDir(VIDEO_LIBRARY, STAGE4A_VIDEO_TASK_ID); const downloaded = downloadRemoteRunnerOutputPersistent(target, result, dir);
  const validation = { valid: true, requiredNodes: requiredNodes(value), durationSeconds: 33 / 16, width: Number(value["8"].inputs.width), height: Number(value["8"].inputs.height) };
  const runtimeEvidence = { stage: "4C", runtime, restore, inference_elapsed_ms: inferenceMs, remote_runner: result, image_input: sha(image.outputPath) };
  let archived;
  try { archived = archiveStage3OWanVideo({ sourceWebm: downloaded.sourcePath, workflow: value, promptId: String(result.prompt_id ?? ""), validation, oomFallbackUsed: oom, runtimeEvidence, libraryDir: VIDEO_LIBRARY, jobId: STAGE4A_VIDEO_TASK_ID, seed: 20260715 }); }
  catch (localError) {
    event(evidence, "local_video_conversion_failed", { source_preserved: existsSync(downloaded.sourcePath), error: safe(localError instanceof Error ? localError.message : localError) });
    const remote = remoteMp4Fallback(target, result, dir);
    try { archived = archiveStage3OWanVideo({ sourceWebm: downloaded.sourcePath, preconvertedMp4: remote, workflow: value, promptId: String(result.prompt_id ?? ""), validation, oomFallbackUsed: oom, runtimeEvidence: { ...runtimeEvidence, remote_conversion_fallback: true }, libraryDir: VIDEO_LIBRARY, jobId: STAGE4A_VIDEO_TASK_ID, seed: 20260715 }); }
    finally { rmSync(remote, { force: true }); }
  }
  removeRemoteRunnerOutput(target, result);
  writeFileSync(path.join(dir, "provider-session.json"), `${JSON.stringify({ order_id: evidence.order_id, endpoint: evidence.ssh_endpoint, candidate: evidence.candidate }, null, 2)}\n`);
  writeFileSync(path.join(dir, "restore-evidence.json"), `${JSON.stringify(restore, null, 2)}\n`);
  setGenerationTaskStatus([STAGE4A_VIDEO_TASK_ID], "completed", { outputPath: archived.outputPath, sourcePath: archived.sourcePath, thumbnailPath: archived.thumbnailPath, outputSha256: archived.sha256, inferenceVerified: true, oomFallbackUsed: oom });
  event(evidence, "video_completed", { ...archived, inference_ms: inferenceMs, oom_fallback_used: oom });
  return archived;
}

async function cleanup(session: GpuSession | null, target: GpuTarget | null, provider: ReturnType<typeof getGpuProvider>, evidence: Evidence) {
  if (target) sshCommand(target, "for p in /workspace/jobs/*/worker.pid; do test -s \"$p\" && kill -TERM $(cat \"$p\") 2>/dev/null || true; done; /workspace/clore-light-bootstrap.sh stop || true", 120_000);
  let billing = null; if (session) { try { billing = await provider.getBilling(session); } catch { /* wallet delta below */ } try { await provider.terminateSession(session); } catch (error) { event(evidence, "order_cancel_error", { error: safe(error instanceof Error ? error.message : error) }); } }
  runNpm(["run", "clore:watchdog:remote:disarm"]); disableLocalWatchdog(); setCloreDeploymentHold(true, "stage4c_cleanup"); clearManualParitySecrets();
  rmSync(AUTH, { force: true }); rmSync(AUTH_CONSUMING, { force: true });
  const confirmations: Json[] = []; let previous: number | null = null; let stable = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const status = await readGpuBillingStatus(); const balance = (await provider.getBalance()).availableUsd;
    confirmations.push({ at: new Date().toISOString(), active_orders: status.clore.activeOrders, runpod_pods: status.runpod.activePods, runpod_volumes: status.runpod.networkVolumes, holds: status.holds, balance });
    if (status.clore.activeOrders === 0 && previous !== null && balance !== null && previous - balance < 0.0001 && confirmations.filter((item) => item.active_orders === 0).length >= 2) { stable = true; break; }
    previous = balance; await sleep(5_000);
  }
  const final = confirmations.at(-1)!; if (final.active_orders !== 0 || final.runpod_pods !== 0 || final.runpod_volumes !== 0 || !(final.holds as Json).clore || !(final.holds as Json).runpod || confirmations.filter((item) => item.active_orders === 0).length < 2) throw new Error("stage4c_cleanup_not_verified");
  event(evidence, "cleanup", { runtime_stopped: true, order_cancelled: true, billing, zero_resource_confirmations: confirmations, balance_stable: stable, holds_restored: true }); return { billing, confirmations, stable };
}

async function main() {
  const evidence: Evidence = { started_at: new Date().toISOString(), batch_id: STAGE4A_BATCH_ID, limits: LIMITS, events: [] }; writeEvidence(evidence);
  const provider = getGpuProvider("clore"); let session: GpuSession | null = null; let target: GpuTarget | null = null; let primary: unknown = null;
  const before = await provider.getBalance(); evidence.balance_before_usd = before.availableUsd;
  try {
    await preflight(evidence);
    const acquired = await acquire(evidence); session = acquired.session; target = acquired.target;
    evidence.candidate = { id: acquired.candidate.id, gpu: acquired.candidate.gpuType, hourly_usd: acquired.candidate.hourlyUsd, ram_gb: acquired.candidate.minimumRamGb, disk_gb: acquired.candidate.containerDiskGb };
    evidence.order_id = session.id; evidence.ssh_endpoint = `${target.host}:${target.port}`; evidence.failed_deployment_spend_usd = acquired.failedSpend; writeEvidence(evidence);
    event(evidence, "hardware_inspection", { output: inspectHardware(target) });
    const runtime = await bootstrap(target, evidence); const canary = await detachedCanary(target, evidence);
    evidence.detached_canary = { job_id: canary.jobId, launcher_returned_ms: canary.launch.returnedMs, passed: true }; writeEvidence(evidence);
    const image = await imagePhase(target, runtime, evidence); unload(target, evidence);
    try { await videoPhase(target, image, runtime, evidence); } catch (error) { setGenerationTaskStatus([STAGE4A_VIDEO_TASK_ID], "failed", { errorClass: safe(error instanceof Error ? error.message : error), imagePreserved: true }); throw error; }
  } catch (error) {
    primary = error;
    const errorClass = safe(error instanceof Error ? error.message : error);
    const imagePreserved = existsSync(path.join(jobDir(IMAGE_LIBRARY, STAGE4A_IMAGE_TASK_ID), "output.png"));
    if (!imagePreserved) {
      setGenerationTaskStatus([STAGE4A_IMAGE_TASK_ID], "failed", { errorClass, inferenceVerified: false });
      setGenerationTaskStatus([STAGE4A_VIDEO_TASK_ID], "failed", { errorClass: `upstream_image_failed:${errorClass}`, inferenceVerified: false, imagePreserved: false });
    }
    event(evidence, "session_failed", { error: errorClass, image_preserved: imagePreserved });
  }
  finally {
    const cleaned = await cleanup(session, target, provider, evidence).catch((error) => { if (!primary) primary = error; event(evidence, "cleanup_failed", { error: safe(error instanceof Error ? error.message : error) }); return null; });
    const after = await provider.getBalance(); evidence.completed_at = new Date().toISOString(); evidence.balance_after_usd = after.availableUsd;
    evidence.total_session_spend_usd = before.availableUsd !== null && after.availableUsd !== null ? Number((before.availableUsd - after.availableUsd).toFixed(4)) : cleaned?.billing?.estimatedSpendUsd ?? null;
    evidence.task_state = readGenerationPool().tasks.filter((task) => [STAGE4A_IMAGE_TASK_ID, STAGE4A_VIDEO_TASK_ID].includes(task.id)); writeEvidence(evidence);
  }
  if (primary) throw primary;
  console.log(JSON.stringify({ stage4c_complete: true, evidence: EVIDENCE_PATH, tasks: (evidence.task_state as unknown[]) }, null, 2));
}

if (process.argv[1]?.endsWith("stage4c-production-session.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "stage4c_failed"); process.exitCode = 1; });
