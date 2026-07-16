import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { getGpuProvider } from "./gpu-providers";
import { FIXED_RUNTIME_DIGEST, sanitizeGpuTarget, scpFile, scpFromRemote, sleep, sshCommand } from "./gpu-providers/common";
import type { GpuCandidate, GpuSession, GpuTarget } from "./gpu-providers/types";
import { setCloreDeploymentHold } from "./clore/deployment-hold";
import { clearManualParitySecrets } from "./clore/manual-parity";
import { failedCloreOrders } from "./clore/support-export";
import { LOCAL_WATCHDOG_TASK_NAME } from "./clore/watchdog-io";
import { readGpuBillingStatus } from "./gpu-billing-status";
import { billingSafetyBlockers } from "./clore/support-acknowledgement";
import { verify as verifyWanCache } from "./model-cache/wan-stage3m-cache";
import { buildRuntimeOverlay } from "./runtime-overlay";
import { installRemoteComfyRunner, runRemoteComfyProbe, runRemoteComfyWorkflow, downloadRemoteRunnerOutputPersistent, removeRemoteRunnerOutput, websocketCapabilityEvidence, type RemoteRunnerResult } from "./comfy-remote-runner";
import { archiveStage3OWanVideo, buildStage3OWanWorkflow, probeMedia, validateStage3OWanWorkflow } from "./stage3o-wan-executor";
import { writeStage3OWanBundle } from "./stage3o-wan-bundle";
import { STAGE3O_VIDEO_TASK_ID } from "./stage3o-batch";
import { STAGE3W_BATCH_ID, STAGE3W_RETRY_TASK_ID, prepareStage3WWanRetry, setStage3WRetryStatus, stage3WTaskSummary, stage3WVerificationState, stage3WVideoJobDir, verifyStage3WImagePreserved } from "./stage3w-wan-retry";
import { readGenerationPool } from "../src/lib/generation/task-pool";

const LIMITS = { maxHostAttempts: 2, maxFailedDeploymentSpendUsd: 0.35, maxTotalSpendUsd: 2, wallClockMinutes: 150 } as const;
const CREATION_FEE_USD = 0.1;
const OVERRIDE_PATH = path.join(process.cwd(), ".secrets", "stage3w-operator-override.json");
const OVERRIDE_CONSUMING_PATH = path.join(process.cwd(), ".secrets", "stage3w-operator-override.consuming.json");
const OVERRIDE_CONSUMED_PATH = path.join(process.cwd(), ".secrets", "stage3w-operator-override.consumed.json");
const EVIDENCE_PATH = path.join(process.cwd(), ".secrets", "stage3w-session-evidence.json");
const VERIFICATION_PATH = path.join(process.cwd(), ".secrets", "stage3w-verification.json");
const FAILED_SERVER_IDS = new Set(failedCloreOrders.map((order) => order.server_id).filter((id): id is string => Boolean(id)));

type Evidence = Record<string, unknown> & { started_at: string; image_preserved: boolean; events: Array<Record<string, unknown>> };

function requireSuccess(result: { status: number | null; stderr?: string | Buffer | null; stdout?: string | Buffer | null; error?: Error }, code: string) {
  if (result.status !== 0) throw new Error(`${code}:${String(result.error?.message ?? result.stderr ?? result.stdout ?? `exit_${result.status}`).trim().slice(-3000)}`);
  return String(result.stdout ?? "");
}
function npmCommand(args: string[]) { return process.platform === "win32" ? { command: "cmd.exe", args: ["/c", "npm", ...args] } : { command: "npm", args }; }
function runNpm(args: string[], timeoutMs = 180_000) { const value = npmCommand(args); return spawnSync(value.command, value.args, { cwd: process.cwd(), encoding: "utf8", timeout: timeoutMs }); }
function disableLocalWatchdog() { return process.platform === "win32" ? spawnSync("schtasks.exe", ["/Change", "/TN", LOCAL_WATCHDOG_TASK_NAME, "/Disable"], { encoding: "utf8", timeout: 30_000 }) : { status: 0 }; }
function safeText(value: unknown) { return String(value ?? "").replace(/(password|token|secret|authorization)\s*[:=]\s*[^\s]+/gi, "$1=<redacted>").replace(/https:\/\/[^\s?]+\?[^\s]+/g, "<redacted-presigned-url>").slice(-10_000); }
function writeEvidence(evidence: Evidence) { mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true }); const partial = `${EVIDENCE_PATH}.part`; writeFileSync(partial, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(partial, EVIDENCE_PATH); }
function event(evidence: Evidence, name: string, detail: Record<string, unknown> = {}) { evidence.events.push({ at: new Date().toISOString(), name, ...detail }); writeEvidence(evidence); }
function fileSha(filePath: string) { const bytes = readFileSync(filePath); return { size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; }

export function buildStage3WOverride(now = new Date()) {
  const unsigned = { created_at: now.toISOString(), expires_at: new Date(now.getTime() + LIMITS.wallClockMinutes * 60_000).toISOString(), one_use: true, limits: LIMITS, nonce: randomBytes(24).toString("base64url") };
  return { ...unsigned, integrity_sha256: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") };
}
export function createFreshStage3WOverride(now = new Date()) {
  const value = buildStage3WOverride(now); mkdirSync(path.dirname(OVERRIDE_PATH), { recursive: true });
  rmSync(OVERRIDE_PATH, { force: true }); rmSync(OVERRIDE_CONSUMING_PATH, { force: true }); rmSync(OVERRIDE_CONSUMED_PATH, { force: true });
  const partial = `${OVERRIDE_PATH}.part`; writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(partial, OVERRIDE_PATH); return value;
}
function consumeOverride() { if (!existsSync(OVERRIDE_PATH)) throw new Error("stage3w_operator_override_missing"); renameSync(OVERRIDE_PATH, OVERRIDE_CONSUMING_PATH); }
function markOverrideConsumed() { if (existsSync(OVERRIDE_CONSUMING_PATH)) renameSync(OVERRIDE_CONSUMING_PATH, OVERRIDE_CONSUMED_PATH); }

export function rankStage3WCandidates(candidates: GpuCandidate[]) {
  const preferred = new Map([["29167", 0], ["105178", 1]]);
  return candidates.filter((candidate) => !FAILED_SERVER_IDS.has(candidate.id) && /RTX\s*(4090|5090)/i.test(candidate.gpuType) && candidate.vramGb >= 23 && candidate.minimumRamGb >= 32 && candidate.containerDiskGb >= 180 && candidate.interruptible === false && candidate.hourlyUsd !== null && candidate.hourlyUsd <= 0.7 && candidate.hourlyUsd * 2.5 + CREATION_FEE_USD <= LIMITS.maxTotalSpendUsd)
    .sort((left, right) => (preferred.get(left.id) ?? 999) - (preferred.get(right.id) ?? 999) || Number(/4090/i.test(right.gpuType)) - Number(/4090/i.test(left.gpuType)) || (right.reliability ?? -1) - (left.reliability ?? -1) || (right.rating ?? -1) - (left.rating ?? -1) || ((right.downloadMbps ?? 0) + (right.uploadMbps ?? 0)) - ((left.downloadMbps ?? 0) + (left.uploadMbps ?? 0)) || (left.hourlyUsd ?? Infinity) - (right.hourlyUsd ?? Infinity));
}

async function preflight(evidence: Evidence) {
  const billing = await readGpuBillingStatus(); const blockers = billingSafetyBlockers(billing); if (blockers.length) throw new Error(`stage3w_preflight:${blockers.join(";")}`);
  const image = verifyStage3WImagePreserved(); const wan = await verifyWanCache(); if (!wan.wan_cache_ready || wan.total_size_bytes !== 18_144_966_705) throw new Error("stage3w_wan_cache_not_ready");
  const validation = validateStage3OWanWorkflow(buildStage3OWanWorkflow()); const retry = prepareStage3WWanRetry(); const override = createFreshStage3WOverride();
  event(evidence, "preflight", { billing, image, wan_bytes: wan.total_size_bytes, workflow: validation, retry_task_id: retry.retryTask.id, session_plan: retry.sessionPlan, override: { expires_at: override.expires_at, one_use: true, limits: override.limits } });
  return { billing, image, wan, retry, override };
}

function armWatchdogs(serverId: string) {
  requireSuccess(runNpm(["run", "clore:watchdog:local:install"]), "stage3w_watchdog_install_failed");
  requireSuccess(runNpm(["run", "clore:watchdog:remote:arm", "--", `--server-id=${serverId}`, "--hard-deadline-minutes=150", "--hard-budget-usd=2.0"], 180_000), "stage3w_watchdog_arm_failed");
}

async function acquireSession(evidence: Evidence) {
  process.env.CLORE_ORDER_EXECUTION_ENABLED = "true";
  process.env.CLORE_FIRST_SESSION_MAX_BUDGET_USD = String(LIMITS.maxTotalSpendUsd);
  process.env.CLORE_HARD_SESSION_LIMIT_MINUTES = String(LIMITS.wallClockMinutes);
  process.env.CLORE_MAX_GPU_PRICE_PER_HOUR = "0.70";
  const provider = getGpuProvider("clore"); const candidates = rankStage3WCandidates(await provider.listCandidates());
  if (!candidates.length) throw new Error("stage3w_no_compliant_clore_candidate");
  event(evidence, "candidates", { selected_order: candidates.slice(0, 5).map((candidate) => ({ id: candidate.id, gpu: candidate.gpuType, vram_gb: candidate.vramGb, ram_gb: candidate.minimumRamGb, disk_gb: candidate.containerDiskGb, hourly_usd: candidate.hourlyUsd, reliability: candidate.reliability, rating: candidate.rating, download_mbps: candidate.downloadMbps, upload_mbps: candidate.uploadMbps })) });
  let failedSpend = 0; let createAttempted = false;
  for (let attempt = 0; attempt < Math.min(LIMITS.maxHostAttempts, candidates.length); attempt += 1) {
    const candidate = candidates[attempt]; let session: GpuSession | null = null;
    if (failedSpend + CREATION_FEE_USD > LIMITS.maxFailedDeploymentSpendUsd) throw new Error("stage3w_failed_deployment_budget_exhausted");
    armWatchdogs(candidate.id); setCloreDeploymentHold(false, "stage3w_operator_authorized_wan_retry"); setStage3WRetryStatus("deploying");
    try {
      session = await provider.createSession({ sessionId: STAGE3W_BATCH_ID, candidate, sshPublicKey: "managed-by-clore-provider", bootstrapImage: FIXED_RUNTIME_DIGEST, dryRun: false, cloreProfile: "clore_key_only", beforeCreateRequest: () => { if (!createAttempted) consumeOverride(); createAttempted = true; }, afterCreateRequestAttempt: () => { if (createAttempted) markOverrideConsumed(); } });
      event(evidence, "order_created", { attempt: attempt + 1, candidate: { id: candidate.id, gpu: candidate.gpuType, hourly_usd: candidate.hourlyUsd }, order_id: session.id, state: session.status });
      const remaining = LIMITS.maxFailedDeploymentSpendUsd - failedSpend - CREATION_FEE_USD; const timeoutMs = Math.max(60_000, Math.min(10 * 60_000, Math.floor((remaining / Math.max(session.hourlyUsd ?? 0.7, 0.01)) * 3600_000)));
      const target = await provider.waitForSsh(session, timeoutMs); event(evidence, "ssh_ready", { endpoint: `${target.host}:${target.port}`, target: sanitizeGpuTarget(target), key_only: true });
      return { provider, candidate, session, target, failedSpend };
    } catch (error) {
      session ??= await provider.recoverExistingSession(STAGE3W_BATCH_ID); let spend = createAttempted ? CREATION_FEE_USD : 0;
      if (session) { const billing = await provider.getBilling(session); spend += billing.estimatedSpendUsd ?? 0; await provider.terminateSession(session); }
      failedSpend = Number((failedSpend + spend).toFixed(4)); event(evidence, "pre_ssh_host_failed", { attempt: attempt + 1, server_id: candidate.id, spend_usd: spend, failed_spend_usd: failedSpend, error: safeText(error instanceof Error ? error.message : error) });
      setCloreDeploymentHold(true, "stage3w_pre_ssh_failure"); runNpm(["run", "clore:watchdog:remote:disarm"]); disableLocalWatchdog(); clearManualParitySecrets();
      if (!createAttempted) throw error;
      if (attempt + 1 >= LIMITS.maxHostAttempts || failedSpend >= LIMITS.maxFailedDeploymentSpendUsd) throw error;
    }
  }
  throw new Error("stage3w_no_ssh_session");
}

function hardwareInspection(target: GpuTarget) {
  const command = "set -e; mkdir -p /workspace; echo '=== gpu ==='; nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version --format=csv,noheader; echo '=== cuda ==='; nvidia-smi; echo '=== ram_cpu ==='; free -b; nproc; echo '=== disks ==='; df -B1 / /workspace; echo '=== python_torch ==='; python3 --version; python3 -c 'import importlib.util; s=importlib.util.find_spec(\"torch\"); print(\"torch_present=\"+str(s is not None).lower())'; echo '=== docker ==='; if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo docker_available=true; docker version; else echo docker_available=false; fi; echo '=== network ==='; curl -L -sS --max-time 20 -o /dev/null -w 'download_bytes=%{size_download} speed_bytes_per_second=%{speed_download} http_code=%{http_code}\\n' 'https://speed.cloudflare.com/__down?bytes=1000000' || echo network_probe_failed";
  return requireSuccess(sshCommand(target, command, 180_000), "stage3w_hardware_inspection_failed");
}

async function bootstrapRuntime(target: GpuTarget, evidence: Evidence) {
  const overlay = buildRuntimeOverlay(); const bootstrap = path.join(process.cwd(), "scripts", "clore", "clore-light-bootstrap.sh");
  requireSuccess(scpFile(target, overlay.outputPath, "/workspace/runtime-overlay.tgz", 5 * 60_000), "stage3w_overlay_copy_failed"); requireSuccess(scpFile(target, bootstrap, "/workspace/clore-light-bootstrap.sh", 2 * 60_000), "stage3w_bootstrap_copy_failed");
  const prepared = requireSuccess(sshCommand(target, "set -e; mkdir -p /workspace; sed -i 's/\\r$//' /workspace/clore-light-bootstrap.sh; chmod 700 /workspace/clore-light-bootstrap.sh; /workspace/clore-light-bootstrap.sh prepare /workspace/runtime-overlay.tgz", 50 * 60_000), "stage3w_runtime_prepare_failed").trim();
  requireSuccess(sshCommand(target, `/workspace/clore-light-bootstrap.sh start ${target.gpuProfile}`, 60_000), "stage3w_runtime_start_failed");
  const deadline = Date.now() + 7 * 60_000; let health = "";
  const required = validateStage3OWanWorkflow(buildStage3OWanWorkflow()).requiredNodes;
  const nodesScript = Buffer.from(`import json,sys; d=json.load(sys.stdin); required=${JSON.stringify(required)}; missing=sorted(set(required)-set(d)); print("missing="+",".join(missing)); raise SystemExit(1 if missing else 0)`).toString("base64");
  const healthCommand = `set -e; curl -fsS --max-time 5 http://127.0.0.1:8080/healthz >/dev/null; curl -fsS --max-time 5 http://127.0.0.1:8188/system_stats >/dev/null; curl -fsS --max-time 5 http://127.0.0.1:8188/object_info | python3 -c "import base64;exec(base64.b64decode('${nodesScript}'))"; test -r /workspace/comfy-user/comfyui.db`;
  while (Date.now() < deadline) { const check = sshCommand(target, healthCommand, 30_000); if (check.status === 0) { health = String(check.stdout); break; } await sleep(5_000); }
  if (!health && sshCommand(target, healthCommand, 30_000).status !== 0) throw new Error("stage3w_runtime_health_failed");
  const cudaTriton = "set -e; mode=$(cat /workspace/ai-runtime/bootstrap-mode); if [ \"$mode\" = docker ]; then docker exec stage3m-comfy-runtime python3 -c 'import torch,triton; print(\"torch=\"+torch.__version__); print(\"cuda=\"+str(torch.version.cuda)); print(\"available=\"+str(torch.cuda.is_available()).lower()); print(\"gpu=\"+torch.cuda.get_device_name(0)); print(\"triton=\"+triton.__version__); assert torch.cuda.is_available()'; else /workspace/ai-runtime/venv/bin/python -c 'import torch,triton; print(\"torch=\"+torch.__version__); print(\"cuda=\"+str(torch.version.cuda)); print(\"available=\"+str(torch.cuda.is_available()).lower()); print(\"gpu=\"+torch.cuda.get_device_name(0)); print(\"triton=\"+triton.__version__); assert torch.cuda.is_available()'; fi";
  const torchTriton = requireSuccess(sshCommand(target, cudaTriton, 180_000), "stage3w_cuda_triton_probe_failed"); installRemoteComfyRunner(target); const runnerProbe = runRemoteComfyProbe(target);
  event(evidence, "runtime_healthy", { bootstrap_mode: prepared.split(/\r?\n/).at(-1), health, torch_cuda_triton: torchTriton, runner_probe: runnerProbe }); return { bootstrapMode: prepared.split(/\r?\n/).at(-1), torchTriton, runnerProbe };
}

async function restoreAndInfer(target: GpuTarget, evidence: Evidence) {
  const bundle = writeStage3OWanBundle(); const restoreScript = path.join(process.cwd(), "scripts", "clore", "restore-stage3o-r2.py");
  requireSuccess(scpFile(target, bundle.filePath, "/workspace/stage3o-wan-r2-bundle.json", 5 * 60_000), "stage3w_wan_bundle_copy_failed"); requireSuccess(scpFile(target, restoreScript, "/workspace/restore-stage3o-r2.py", 2 * 60_000), "stage3w_wan_restore_script_copy_failed");
  setStage3WRetryStatus("restoring_models"); const restoreStarted = Date.now(); const restoreText = requireSuccess(sshCommand(target, "set -e; test $(df --output=avail -B1 /workspace | tail -1) -ge 50000000000; STAGE3O_R2_RESTORE_MANIFEST=/workspace/stage3o-wan-r2-bundle.json python3 /workspace/restore-stage3o-r2.py", 90 * 60_000), "stage3w_wan_restore_failed"); const restoreMs = Date.now() - restoreStarted;
  const restore = JSON.parse(restoreText.trim()) as Record<string, unknown>; event(evidence, "wan_restored", { elapsed_ms: restoreMs, restore });
  let workflow = buildStage3OWanWorkflow(); let validation = validateStage3OWanWorkflow(workflow); let oomFallbackUsed = false; setStage3WRetryStatus("generating");
  let remoteResult: RemoteRunnerResult; const inferenceStarted = Date.now();
  try { remoteResult = runRemoteComfyWorkflow({ target, workflow: workflow as unknown as Record<string, unknown>, clientId: STAGE3W_RETRY_TASK_ID, kind: "video", timeoutSeconds: 90 * 60 }); }
  catch (error) { if (!/out of memory|cuda.*memory|oom/i.test(error instanceof Error ? error.message : String(error))) throw error; requireSuccess(sshCommand(target, "curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"unload_models\":false,\"free_memory\":true}' http://127.0.0.1:8188/free >/dev/null", 60_000), "stage3w_oom_clear_failed"); workflow = buildStage3OWanWorkflow({ width: 640, height: 368 }); validation = validateStage3OWanWorkflow(workflow); oomFallbackUsed = true; remoteResult = runRemoteComfyWorkflow({ target, workflow: workflow as unknown as Record<string, unknown>, clientId: `${STAGE3W_RETRY_TASK_ID}-low`, kind: "video", timeoutSeconds: 90 * 60 }); }
  const inferenceMs = Date.now() - inferenceStarted; event(evidence, "wan_remote_inference", { elapsed_ms: inferenceMs, prompt_id: remoteResult.prompt_id, output_size_bytes: remoteResult.output_size_bytes, output_sha256: remoteResult.output_sha256, oom_fallback_used: oomFallbackUsed, websocket: remoteResult.websocket_remote_local });
  return { restore, restoreMs, workflow, validation, oomFallbackUsed, remoteResult, inferenceMs };
}

function remoteFallback(target: GpuTarget, result: RemoteRunnerResult, jobDir: string, evidence: Evidence) {
  const source = result.staged_path; if (typeof source !== "string" || !/^\/workspace\/runtime-tools\/results\/[a-f0-9-]+\.[a-z0-9]+$/i.test(source)) throw new Error("stage3w_remote_source_invalid");
  const remotePart = "/workspace/runtime-tools/results/stage3w-browser.mp4.part"; const remoteFinal = "/workspace/runtime-tools/results/stage3w-browser.mp4";
  const command = `set -e; rm -f ${remotePart} ${remoteFinal}; if command -v ffmpeg >/dev/null 2>&1; then ffmpeg -y -i ${source} -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart -f mp4 ${remotePart}; ffprobe -v error -show_streams -show_format -of json ${remotePart}; else docker exec stage3m-comfy-runtime ffmpeg -y -i ${source} -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart -f mp4 ${remotePart}; docker exec stage3m-comfy-runtime ffprobe -v error -show_streams -show_format -of json ${remotePart}; fi; test -s ${remotePart}; mv ${remotePart} ${remoteFinal}`;
  const converted = sshCommand(target, command, 20 * 60_000); if (converted.status !== 0) { writeFileSync(path.join(jobDir, "remote-ffmpeg.stderr.txt"), safeText(converted.error?.message ?? converted.stderr ?? converted.stdout), "utf8"); throw new Error(`stage3w_remote_conversion_failed:${safeText(converted.stderr ?? converted.stdout)}`); }
  const localPart = path.join(jobDir, "output.mp4.remote.part"); rmSync(localPart, { force: true }); requireSuccess(scpFromRemote(target, remoteFinal, localPart, 30 * 60_000), "stage3w_remote_mp4_download_failed"); probeMedia(localPart); event(evidence, "remote_conversion_fallback", { used: true, probe_stdout: safeText(converted.stdout), local_part: fileSha(localPart) }); return localPart;
}

async function syncMedia(target: GpuTarget, inferred: Awaited<ReturnType<typeof restoreAndInfer>>, runtime: Record<string, unknown>, evidence: Evidence) {
  const jobDir = stage3WVideoJobDir(); setStage3WRetryStatus("syncing"); const downloaded = downloadRemoteRunnerOutputPersistent(target, inferred.remoteResult, jobDir); event(evidence, "source_webm_synced", downloaded);
  const runtimeEvidence = { stage: "3W", restore: inferred.restore, restore_elapsed_ms: inferred.restoreMs, inference_elapsed_ms: inferred.inferenceMs, system_stats: inferred.remoteResult.system_stats, required_nodes_verified: inferred.remoteResult.required_nodes_verified, history_verified: inferred.remoteResult.history_verified, runner: runtime, ...websocketCapabilityEvidence(inferred.remoteResult.websocket_remote_local, { attempted: false, connected: false, reason: "optional_tunnel_not_required" }) };
  try {
    const archived = archiveStage3OWanVideo({ sourceWebm: downloaded.sourcePath, workflow: inferred.workflow, promptId: String(inferred.remoteResult.prompt_id ?? ""), validation: inferred.validation, oomFallbackUsed: inferred.oomFallbackUsed, runtimeEvidence }); event(evidence, "local_media_verified", { conversion: "local_bundled", archived }); removeRemoteRunnerOutput(target, inferred.remoteResult); return archived;
  } catch (localError) {
    event(evidence, "local_conversion_failed", { source_preserved: existsSync(downloaded.sourcePath), error: safeText(localError instanceof Error ? localError.message : localError) });
    let remotePart: string | null = null;
    try { remotePart = remoteFallback(target, inferred.remoteResult, jobDir, evidence); const archived = archiveStage3OWanVideo({ sourceWebm: downloaded.sourcePath, preconvertedMp4: remotePart, workflow: inferred.workflow, promptId: String(inferred.remoteResult.prompt_id ?? ""), validation: inferred.validation, oomFallbackUsed: inferred.oomFallbackUsed, runtimeEvidence: { ...runtimeEvidence, local_conversion_error: safeText(localError instanceof Error ? localError.message : localError), remote_conversion_fallback: true } }); event(evidence, "local_media_verified", { conversion: "remote_fallback", archived }); removeRemoteRunnerOutput(target, inferred.remoteResult); return archived; }
    catch (remoteError) { event(evidence, "both_conversions_failed", { source_preserved: existsSync(downloaded.sourcePath), local_error: safeText(localError instanceof Error ? localError.message : localError), remote_error: safeText(remoteError instanceof Error ? remoteError.message : remoteError) }); removeRemoteRunnerOutput(target, inferred.remoteResult); throw remoteError; }
    finally { if (remotePart) rmSync(remotePart, { force: true }); }
  }
}

async function cleanup(session: GpuSession | null, target: GpuTarget | null, provider: ReturnType<typeof getGpuProvider>, evidence: Evidence) {
  if (target) sshCommand(target, "/workspace/clore-light-bootstrap.sh stop || true", 120_000);
  let billing = null; if (session) { try { billing = await provider.getBilling(session); } catch { /* wallet delta remains authoritative */ } try { await provider.terminateSession(session); } catch (error) { event(evidence, "order_cancel_error", { error: safeText(error instanceof Error ? error.message : error) }); } }
  runNpm(["run", "clore:watchdog:remote:disarm"]); disableLocalWatchdog(); setCloreDeploymentHold(true, "stage3w_cleanup"); clearManualParitySecrets();
  rmSync(OVERRIDE_PATH, { force: true }); rmSync(OVERRIDE_CONSUMING_PATH, { force: true });
  const confirmations = []; let previousBalance: number | null = null; let balanceStable = false;
  for (let i = 0; i < 4; i += 1) { const status = await readGpuBillingStatus(); const balance = (await provider.getBalance()).availableUsd; confirmations.push({ at: new Date().toISOString(), active_orders: status.clore.activeOrders, runpod_pods: status.runpod.activePods, runpod_volumes: status.runpod.networkVolumes, holds: status.holds, balance }); if (status.clore.activeOrders === 0 && previousBalance !== null && balance !== null && previousBalance - balance < 0.0001) { balanceStable = true; break; } previousBalance = balance; await sleep(5_000); }
  const final = confirmations.at(-1)!; if (final.active_orders !== 0 || final.runpod_pods !== 0 || final.runpod_volumes !== 0 || !final.holds.clore || !final.holds.runpod || confirmations.filter((item) => item.active_orders === 0).length < 2) throw new Error("stage3w_cleanup_not_verified");
  event(evidence, "cleanup", { runtime_stopped: true, order_cancelled: true, billing, zero_resource_confirmations: confirmations, balance_stable: balanceStable, holds_restored: true }); return { billing, confirmations, balanceStable };
}

async function main() {
  const evidence: Evidence = { started_at: new Date().toISOString(), image_preserved: true, limits: LIMITS, events: [] }; writeEvidence(evidence);
  const provider = getGpuProvider("clore"); let session: GpuSession | null = null; let target: GpuTarget | null = null; let primaryError: unknown = null; const balanceBefore = await provider.getBalance();
  try {
    await preflight(evidence); const jobDir = stage3WVideoJobDir(); const source = path.join(jobDir, "source.webm"); const output = path.join(jobDir, "output.mp4");
    if (existsSync(source) && !existsSync(output)) { try { const workflow = buildStage3OWanWorkflow(); const validation = validateStage3OWanWorkflow(workflow); const archived = archiveStage3OWanVideo({ sourceWebm: source, workflow, promptId: "stage3w-resume", validation, oomFallbackUsed: validation.width !== 832, runtimeEvidence: { resumed_without_regeneration: true } }); setStage3WRetryStatus("completed", { outputPath: archived.outputPath, thumbnailPath: archived.thumbnailPath, sourcePath: archived.sourcePath }); const verification = stage3WVerificationState({ wanRemote: true, wanLocal: true }); writeFileSync(VERIFICATION_PATH, `${JSON.stringify(verification, null, 2)}\n`, "utf8"); event(evidence, "resumed_without_regeneration", { archived }); return; } catch (error) { event(evidence, "persistent_source_local_resume_failed", { error: safeText(error instanceof Error ? error.message : error), source_preserved: true }); } }
    const acquired = await acquireSession(evidence); session = acquired.session; target = acquired.target; evidence.failed_deployment_spend_usd = acquired.failedSpend; evidence.candidate = { id: acquired.candidate.id, gpu: acquired.candidate.gpuType, hourly_usd: acquired.candidate.hourlyUsd }; evidence.order_id = session.id; evidence.ssh_endpoint = `${target.host}:${target.port}`; writeEvidence(evidence);
    const inspection = hardwareInspection(target); event(evidence, "hardware_inspection", { output: inspection }); const runtime = await bootstrapRuntime(target, evidence); const inferred = await restoreAndInfer(target, evidence); const archived = await syncMedia(target, inferred, runtime, evidence);
    setStage3WRetryStatus("completed", { outputPath: archived.outputPath, thumbnailPath: archived.thumbnailPath, sourcePath: archived.sourcePath, outputSha256: archived.sha256, sourceSha256: archived.sourceSha256, thumbnailSha256: archived.thumbnailSha256 }); const verification = stage3WVerificationState({ wanRemote: true, wanLocal: true }); writeFileSync(VERIFICATION_PATH, `${JSON.stringify(verification, null, 2)}\n`, "utf8"); event(evidence, "video_task_completed", { verification, tasks: stage3WTaskSummary(readGenerationPool()) });
  } catch (error) { primaryError = error; try { setStage3WRetryStatus("failed", { errorClass: safeText(error instanceof Error ? error.message : error), retryable: true, imagePreserved: true }); } catch { /* preflight can fail before task creation */ } event(evidence, "session_failed", { error: safeText(error instanceof Error ? error.message : error), image_preserved: true }); }
  finally { const cleaned = await cleanup(session, target, provider, evidence).catch((error) => { if (!primaryError) primaryError = error; event(evidence, "cleanup_failed", { error: safeText(error instanceof Error ? error.message : error) }); return null; }); const balanceAfter = await provider.getBalance(); evidence.completed_at = new Date().toISOString(); evidence.balance_before_usd = balanceBefore.availableUsd; evidence.balance_after_usd = balanceAfter.availableUsd; evidence.total_session_spend_usd = balanceBefore.availableUsd !== null && balanceAfter.availableUsd !== null ? Number((balanceBefore.availableUsd - balanceAfter.availableUsd).toFixed(4)) : cleaned?.billing?.estimatedSpendUsd ?? null; evidence.image_preserved_final = verifyStage3WImagePreserved(); writeEvidence(evidence); }
  if (primaryError) throw primaryError; console.log(JSON.stringify({ stage3w_complete: true, verification: JSON.parse(readFileSync(VERIFICATION_PATH, "utf8")), evidence: EVIDENCE_PATH, tasks: stage3WTaskSummary(readGenerationPool()) }, null, 2));
}

if (process.argv[1]?.endsWith("stage3w-wan-retry-session.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "stage3w_session_failed"); process.exitCode = 1; });
