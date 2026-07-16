import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { getGpuProvider } from "./gpu-providers";
import { FIXED_RUNTIME_DIGEST, sanitizeGpuTarget, scpFile, sleep, sshCommand } from "./gpu-providers/common";
import type { GpuCandidate, GpuSession, GpuTarget } from "./gpu-providers/types";
import { getCloreDeploymentHold, setCloreDeploymentHold } from "./clore/deployment-hold";
import { assertNoSecretOutput } from "./clore/client";
import { readSupportAcknowledgement, billingSafetyBlockers } from "./clore/support-acknowledgement";
import { LOCAL_WATCHDOG_TASK_NAME } from "./clore/watchdog-io";
import { readGpuBillingStatus } from "./gpu-billing-status";
import { fluxCacheStatus } from "./model-cache/flux4090-cache";
import { verify as verifyWanCache } from "./model-cache/wan-stage3m-cache";
import { buildFluxFirstImageWorkflow, validateFluxFirstImageWorkflow } from "./flux-first-image";
import { runRemoteFirstImage } from "./gpu-first-image";
import { buildStage3OWanWorkflow, validateStage3OWanWorkflow } from "./stage3o-wan-executor";
import { writeStage3OWanBundle } from "./stage3o-wan-bundle";
import { STAGE3O_BATCH_ID, STAGE3O_IMAGE_TASK_ID, STAGE3O_TASK_IDS, STAGE3O_VIDEO_TASK_ID } from "./stage3o-batch";
import { readGenerationPool, setGenerationTaskStatus, writeGenerationPool } from "../src/lib/generation/task-pool";
import { completeStage3OCheckpoint, nextStage3OCheckpoint, readStage3OState, writeStage3OState, type Stage3OLiveState } from "./stage3o-live-state";

const MAX_HOST_ATTEMPTS = 2;
const MAX_FAILED_DEPLOYMENT_SPEND_USD = 0.4;
const MAX_TOTAL_SPEND_USD = 2.5;
const MAX_RUNTIME_MINUTES = 150;

function argument(name: string) { const prefix = `--${name}=`; return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length); }
function requireSuccess(result: ReturnType<typeof spawnSync>, code: string) { if (result.status !== 0) throw new Error(`${code}:${String(result.stderr ?? result.stdout ?? "").trim().slice(-800)}`); return String(result.stdout ?? ""); }
function npmCommand(args: string[]) { return process.platform === "win32" ? { command: "cmd.exe", args: ["/c", "npm", ...args] } : { command: "npm", args }; }
function runNpm(args: string[], timeoutMs = 120_000) { const value = npmCommand(args); return spawnSync(value.command, value.args, { cwd: process.cwd(), encoding: "utf8", timeout: timeoutMs }); }
function disableLocalWatchdogTask() { return process.platform === "win32" ? spawnSync("schtasks.exe", ["/Change", "/TN", LOCAL_WATCHDOG_TASK_NAME, "/Disable"], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 }) : { status: 0 }; }

async function loopbackPort(start = 18240) {
  for (let port = start; port < start + 32; port += 1) {
    const free = await new Promise<boolean>((resolve) => { const server = net.createServer(); server.once("error", () => resolve(false)); server.listen(port, "127.0.0.1", () => server.close(() => resolve(true))); });
    if (free) return port;
  }
  throw new Error("stage3o_tunnel_port_unavailable");
}

function checkpointThroughFailure(state: Stage3OLiveState, error: unknown) {
  let next = state; const message = error instanceof Error ? error.message : "stage3o_failure";
  while (true) {
    const checkpoint = nextStage3OCheckpoint(next);
    if (!checkpoint || checkpoint === "runtime_stopped") break;
    next = completeStage3OCheckpoint(next, checkpoint, { success: false, skippedAfterError: true, errorClass: message.slice(0, 300) });
  }
  return next;
}

export function rankStage3OCandidates(candidates: GpuCandidate[], recommendedServerIds: string[]) {
  const recommended = new Map(recommendedServerIds.map((id, index) => [id, index]));
  return candidates.filter((candidate) => candidate.vramGb >= 20 && candidate.minimumRamGb >= 32 && candidate.containerDiskGb >= 150 && candidate.interruptible === false && candidate.hourlyUsd !== null && candidate.hourlyUsd <= 0.7 && candidate.hourlyUsd * (MAX_RUNTIME_MINUTES / 60) + 0.1 <= MAX_TOTAL_SPEND_USD).sort((left, right) => (recommended.get(left.id) ?? 999) - (recommended.get(right.id) ?? 999) || left.priority - right.priority || (left.hourlyUsd ?? Infinity) - (right.hourlyUsd ?? Infinity));
}

export async function validateStage3OPreflight() {
  const acknowledgement = readSupportAcknowledgement();
  if (!acknowledgement.valid || !acknowledgement.acknowledgement) throw new Error(acknowledgement.blockers.join("；"));
  const billing = await readGpuBillingStatus(); const blockers = billingSafetyBlockers(billing); if (blockers.length) throw new Error(blockers.join("；"));
  const pool = readGenerationPool(); const tasks = STAGE3O_TASK_IDS.map((id) => pool.tasks.find((task) => task.id === id));
  if (pool.scheduler.selectedBatchId !== STAGE3O_BATCH_ID || pool.scheduler.selectedTaskIds.length !== 2 || tasks.some((task) => !task || task.batchId !== STAGE3O_BATCH_ID || task.status !== "armed")) throw new Error("Stage 3O 图片与视频批次尚未按固定任务武装。");
  const flux = await fluxCacheStatus(); if (!flux.ready || flux.total_size_bytes !== 12_451_817_860) throw new Error("FLUX current.json 或对象校验未就绪。");
  const wan = await verifyWanCache(); if (!wan.wan_cache_ready || wan.total_size_bytes !== 18_144_966_705) throw new Error("Wan current.json 或对象校验未就绪。");
  const fluxErrors = validateFluxFirstImageWorkflow(buildFluxFirstImageWorkflow({ width: 1024, height: 1024, steps: 4, seed: 20260715 })); if (fluxErrors.length) throw new Error(`FLUX 工作流不可执行：${fluxErrors.join("；")}`);
  validateStage3OWanWorkflow(buildStage3OWanWorkflow());
  return { acknowledgement: acknowledgement.acknowledgement, billing, flux, wan, pool };
}

async function runWan(target: GpuTarget) {
  const bundle = writeStage3OWanBundle(); const restoreScript = path.join(process.cwd(), "scripts", "clore", "restore-stage3o-r2.py");
  requireSuccess(scpFile(target, bundle.filePath, "/workspace/stage3o-wan-r2-bundle.json", 5 * 60_000), "wan_bundle_copy_failed");
  requireSuccess(scpFile(target, restoreScript, "/workspace/restore-stage3o-r2.py", 2 * 60_000), "wan_restore_script_copy_failed");
  const restore = requireSuccess(sshCommand(target, "set -e; test $(df --output=avail -B1 /workspace | tail -1) -ge 50000000000; STAGE3O_R2_RESTORE_MANIFEST=/workspace/stage3o-wan-r2-bundle.json python3 /workspace/restore-stage3o-r2.py", 90 * 60_000), "wan_restore_failed");
  const port = await loopbackPort(); const tunnel = spawn("ssh", ["-N", "-i", target.sshKeyPath, "-o", "StrictHostKeyChecking=accept-new", "-o", "PasswordAuthentication=no", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-p", String(target.port), "-L", `127.0.0.1:${port}:127.0.0.1:8188`, `${target.username}@${target.host}`], { stdio: "ignore" });
  try {
    await sleep(1500); if (tunnel.exitCode !== null) throw new Error("wan_tunnel_failed");
    const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const generated = spawnSync(process.execPath, [tsx, "scripts/stage3o-wan-executor.ts", `--base-url=http://127.0.0.1:${port}`], { cwd: process.cwd(), encoding: "utf8", timeout: 100 * 60_000 });
    return { restore: JSON.parse(restore), generated: JSON.parse(requireSuccess(generated, "wan_generation_failed")) as Record<string, unknown> };
  } finally { tunnel.kill(); }
}

async function cleanup(session: GpuSession | null, target: GpuTarget | null, provider: ReturnType<typeof getGpuProvider>, state: Stage3OLiveState) {
  let next = state;
  if (target) sshCommand(target, "/workspace/clore-light-bootstrap.sh stop || true; rm -f /workspace/stage3o-*-bundle.json", 60_000);
  if (!next.completed.includes("runtime_stopped")) next = completeStage3OCheckpoint(next, "runtime_stopped", { stopped: Boolean(target) });
  if (session) await provider.terminateSession(session);
  if (!next.completed.includes("order_cancelled")) next = completeStage3OCheckpoint(next, "order_cancelled", { terminated: Boolean(session) });
  const disarm = runNpm(["run", "clore:watchdog:remote:disarm"]); // Failure is checked by final billing status.
  const disableTask = disableLocalWatchdogTask();
  setCloreDeploymentHold(true, "stage3o_session_cleanup");
  const finalBilling = await readGpuBillingStatus(); const blockers = billingSafetyBlockers(finalBilling);
  if (blockers.length) throw new Error(`stage3o_cleanup_incomplete:${blockers.join("；")}`);
  if (!next.completed.includes("cleanup_verified")) next = completeStage3OCheckpoint(next, "cleanup_verified", { activeOrders: 0, holdsRestored: true, watchdogDisarmExitCode: disarm.status, watchdogTaskDisableExitCode: disableTask.status });
  const pool = readGenerationPool(); pool.scheduler.state = "completed"; writeGenerationPool(pool);
  return next;
}

async function main() {
  if (argument("provider") !== "clore" || argument("batch") !== STAGE3O_BATCH_ID) throw new Error("只允许 --provider=clore --batch=stage3o。");
  const preflight = await validateStage3OPreflight(); let state = readStage3OState();
  if (!state.completed.includes("preflight_validated")) state = completeStage3OCheckpoint(state, "preflight_validated", { ticketId: preflight.acknowledgement.ticketId, fluxBytes: preflight.flux.total_size_bytes, wanBytes: preflight.wan.total_size_bytes });
  const provider = getGpuProvider("clore"); let session = await provider.recoverExistingSession(STAGE3O_BATCH_ID); let target: GpuTarget | null = session?.target ?? null;
  try {
    if (!session) {
      const candidates = rankStage3OCandidates(await provider.listCandidates(), preflight.acknowledgement.recommendedServerIds);
      while (!session && state.attemptCount < MAX_HOST_ATTEMPTS) {
        const candidate = candidates[state.attemptCount]; if (!candidate) throw new Error("当前没有满足 Stage 3O 显存、内存、150GB 磁盘和预算的 Clore 主机。");
        state = writeStage3OState({ ...state, attemptCount: state.attemptCount + 1, serverId: candidate.id });
        requireSuccess(runNpm(["run", "clore:watchdog:local:install"]), "watchdog_task_install_failed");
        requireSuccess(runNpm(["run", "clore:watchdog:remote:arm", "--", `--server-id=${candidate.id}`, "--hard-deadline-minutes=150", "--hard-budget-usd=2.5"], 180_000), "watchdog_arm_failed");
        if (!state.completed.includes("watchdog_armed")) state = completeStage3OCheckpoint(state, "watchdog_armed", { serverId: candidate.id, hardDeadlineMinutes: 150, hardBudgetUsd: 2.5 });
        setCloreDeploymentHold(false, "stage3o_valid_support_acknowledgement");
        try {
          setGenerationTaskStatus([...STAGE3O_TASK_IDS], "deploying");
          session = await provider.createSession({ sessionId: STAGE3O_BATCH_ID, candidate, sshPublicKey: "managed-by-clore-provider", bootstrapImage: FIXED_RUNTIME_DIGEST, dryRun: false });
          state = writeStage3OState({ ...state, orderId: session.id }); if (!state.completed.includes("order_created")) state = completeStage3OCheckpoint(state, "order_created", { orderId: session.id, serverId: candidate.id, hourlyUsd: session.hourlyUsd });
          target = await provider.waitForSsh(session, 10 * 60_000); if (!state.completed.includes("ssh_ready")) state = completeStage3OCheckpoint(state, "ssh_ready", { target: sanitizeGpuTarget(target) });
        } catch (error) {
          session ??= await provider.recoverExistingSession(STAGE3O_BATCH_ID);
          if (session) { const billing = await provider.getBilling(session); await provider.terminateSession(session); state = writeStage3OState({ ...state, failedDeploymentSpendUsd: Number((state.failedDeploymentSpendUsd + (billing.estimatedSpendUsd ?? 0) + 0.1).toFixed(4)), orderId: null, completed: state.completed.filter((item) => !["watchdog_armed", "order_created", "ssh_ready"].includes(item)) }); session = null; }
          setCloreDeploymentHold(true, "stage3o_failed_host_attempt"); runNpm(["run", "clore:watchdog:remote:disarm"]); disableLocalWatchdogTask();
          if (state.failedDeploymentSpendUsd >= MAX_FAILED_DEPLOYMENT_SPEND_USD || state.attemptCount >= MAX_HOST_ATTEMPTS) throw error;
        }
      }
    }
    if (!session) throw new Error("Stage 3O 未获得可用 Clore 会话。"); target ??= await provider.waitForSsh(session, 10 * 60_000);
    if (!state.completed.includes("ssh_ready")) state = completeStage3OCheckpoint(state, "ssh_ready", { target: sanitizeGpuTarget(target) });
    if (!state.completed.includes("hardware_inspected")) { const inspection = requireSuccess(sshCommand(target, "set -e; nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader; nvidia-smi; free -b; nproc; df -B1 /workspace; python3 -c 'import torch; print(torch.__version__); print(torch.version.cuda); print(torch.cuda.is_available())'; (docker version || true)", 120_000), "hardware_inspection_failed"); state = completeStage3OCheckpoint(state, "hardware_inspected", { fullOutput: inspection }); }
    if (!state.completed.includes("image_synced")) {
      setGenerationTaskStatus([STAGE3O_IMAGE_TASK_ID], "restoring_models"); const result = await runRemoteFirstImage(target, "clore", STAGE3O_IMAGE_TASK_ID, session.gpuType ?? "unknown", { warmRun: false });
      state = completeStage3OCheckpoint(state, "flux_restored", { elapsedMs: result.restoreElapsedMs, verified: true }); setGenerationTaskStatus([STAGE3O_IMAGE_TASK_ID], "generating"); state = completeStage3OCheckpoint(state, "image_generated", result.generated); setGenerationTaskStatus([STAGE3O_IMAGE_TASK_ID], "syncing"); state = completeStage3OCheckpoint(state, "image_synced", { localArchive: true }); setGenerationTaskStatus([STAGE3O_IMAGE_TASK_ID], "completed", { outputPath: String((result.generated.archive as Record<string, unknown> | undefined)?.outputPath ?? "") });
    }
    if (!state.completed.includes("flux_unloaded")) { requireSuccess(sshCommand(target, "curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"unload_models\":true,\"free_memory\":true}' http://127.0.0.1:8188/free >/dev/null", 60_000), "flux_unload_failed"); state = completeStage3OCheckpoint(state, "flux_unloaded", { cudaCacheCleared: true }); }
    try {
      if (!state.completed.includes("outputs_synced")) { setGenerationTaskStatus([STAGE3O_VIDEO_TASK_ID], "restoring_models"); const wan = await runWan(target); state = completeStage3OCheckpoint(state, "wan_restored", wan.restore as Record<string, unknown>); setGenerationTaskStatus([STAGE3O_VIDEO_TASK_ID], "generating"); state = completeStage3OCheckpoint(state, "video_generated", wan.generated); setGenerationTaskStatus([STAGE3O_VIDEO_TASK_ID], "syncing"); state = completeStage3OCheckpoint(state, "outputs_synced", { imagePreserved: true, videoSynced: true }); setGenerationTaskStatus([STAGE3O_VIDEO_TASK_ID], "completed", { outputPath: String(wan.generated.outputPath ?? ""), thumbnailPath: String(wan.generated.thumbnailPath ?? "") }); }
    } catch (error) { setGenerationTaskStatus([STAGE3O_VIDEO_TASK_ID], "failed", { errorClass: error instanceof Error ? error.message.slice(0, 300) : "wan_failure", imagePreserved: true }); state = checkpointThroughFailure(state, error); }
    state = await cleanup(session, target, provider, state); session = null;
    const output = { completed: true, batch: STAGE3O_BATCH_ID, checkpoints: state.completed, imageStatus: readGenerationPool().tasks.find((task) => task.id === STAGE3O_IMAGE_TASK_ID)?.status, videoStatus: readGenerationPool().tasks.find((task) => task.id === STAGE3O_VIDEO_TASK_ID)?.status, hold: getCloreDeploymentHold() };
    const text = JSON.stringify(output, null, 2); assertNoSecretOutput(text); console.log(text);
  } catch (error) {
    state = checkpointThroughFailure(state, error); state = await cleanup(session, target, provider, state).catch(() => writeStage3OState({ ...state, lastError: error instanceof Error ? error.message : "stage3o_failure" }));
    throw error;
  } finally { setCloreDeploymentHold(true, "stage3o_finally"); }
}

if (process.argv[1]?.endsWith("generation-live-session.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "stage3o_live_session_failed"); process.exitCode = 1; });
