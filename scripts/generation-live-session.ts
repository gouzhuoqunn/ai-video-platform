import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { getGpuProvider } from "./gpu-providers";
import { FIXED_RUNTIME_DIGEST, sanitizeGpuTarget, scpFile, sleep, sshCommand } from "./gpu-providers/common";
import type { GpuCandidate, GpuSession, GpuTarget } from "./gpu-providers/types";
import { getCloreDeploymentHold, setCloreDeploymentHold } from "./clore/deployment-hold";
import { clearManualParitySecrets } from "./clore/manual-parity";
import { assertNoSecretOutput } from "./clore/client";
import { readSupportAcknowledgement, billingSafetyBlockers, SUPPORT_ACK_PATH } from "./clore/support-acknowledgement";
import { consumeOperatorRetryOverride, markOperatorRetryConsumed, operatorRetryPaths, readConsumedOperatorRetryOverride, readOperatorRetryOverride, type OperatorRetryPaths } from "./clore/operator-retry-override";
import { readActiveOrder } from "./clore/order-state";
import { failedCloreOrders } from "./clore/support-export";
import { LOCAL_WATCHDOG_TASK_NAME } from "./clore/watchdog-io";
import { assertWatchdogsReadyForCreate } from "./clore/watchdog-preflight";
import { readCloreSshAuthEvidence } from "./gpu-providers/clore";
import { readGpuBillingStatus } from "./gpu-billing-status";
import { fluxCacheStatus } from "./model-cache/flux4090-cache";
import { verify as verifyWanCache } from "./model-cache/wan-stage3m-cache";
import { buildFluxFirstImageWorkflow, validateFluxFirstImageWorkflow } from "./flux-first-image";
import { runRemoteFirstImage } from "./gpu-first-image";
import { buildStage3OWanWorkflow, validateStage3OWanWorkflow } from "./stage3o-wan-executor";
import { writeStage3OWanBundle } from "./stage3o-wan-bundle";
import { STAGE3O_BATCH_ID, STAGE3O_IMAGE_TASK_ID, STAGE3O_TASK_IDS, STAGE3O_VIDEO_TASK_ID } from "./stage3o-batch";
import { readGenerationPool, setGenerationTaskStatus, writeGenerationPool } from "../src/lib/generation/task-pool";
import { completeStage3OCheckpoint, initialStage3OState, nextStage3OCheckpoint, readStage3OState, writeStage3OState, type Stage3OLiveState } from "./stage3o-live-state";

export const MAX_HOST_ATTEMPTS = 2;
export const MAX_FAILED_DEPLOYMENT_SPEND_USD = 0.4;
const MAX_TOTAL_SPEND_USD = 2.5;
const MAX_RUNTIME_MINUTES = 180;
const MAX_SSH_WAIT_MINUTES = 10;
const CLORE_CREATION_FEE_USD = 0.1;
const FAILED_SERVER_IDS = new Set(failedCloreOrders.map((order) => order.server_id).filter((id): id is string => Boolean(id)));
const MANUAL_GOLDEN_SERVER_IDS = new Set(["28726"]);

function argument(name: string) { const prefix = `--${name}=`; return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length); }
function requireSuccess(result: { status: number | null; stderr?: string | Buffer | null; stdout?: string | Buffer | null }, code: string) { if (result.status !== 0) throw new Error(`${code}:${String(result.stderr ?? result.stdout ?? "").trim().slice(-800)}`); return String(result.stdout ?? ""); }
function npmCommand(args: string[]) { return process.platform === "win32" ? { command: "cmd.exe", args: ["/c", "npm", ...args] } : { command: "npm", args }; }
function runNpm(args: string[], timeoutMs = 120_000) { const value = npmCommand(args); return spawnSync(value.command, value.args, { cwd: process.cwd(), encoding: "utf8", timeout: timeoutMs }); }
function disableLocalWatchdogTask() { return process.platform === "win32" ? spawnSync("schtasks.exe", ["/Change", "/TN", LOCAL_WATCHDOG_TASK_NAME, "/Disable"], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 }) : { status: 0 }; }

async function readGpuBillingStatusWithTransientRetry() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await readGpuBillingStatus(); }
    catch (error) {
      lastError = error;
      if (!/fetch failed|network|socket|TLS|ECONN|ETIMEDOUT/i.test(error instanceof Error ? error.message : String(error)) || attempt === 2) throw error;
      await sleep(3_000);
    }
  }
  throw lastError;
}

function armRemoteWatchdogWithTransientRetry(serverId: string) {
  try { assertWatchdogsReadyForCreate(serverId); return { status: 0, stdout: "watchdog_already_healthy", stderr: "" }; } catch { /* A fresh arm is required. */ }
  let result = runNpm(["run", "clore:watchdog:remote:arm", "--", `--server-id=${serverId}`, "--hard-deadline-minutes=180", "--hard-budget-usd=2.5"], 180_000);
  for (let retry = 0; result.status !== 0 && retry < 2; retry += 1) {
    const output = `${String(result.stderr ?? "")}\n${String(result.stdout ?? "")}`;
    if (!/fetch failed|connectivity issue|network connection|ECONN|ETIMEDOUT/i.test(output)) return result;
    runNpm(["run", "clore:watchdog:remote:disarm"]);
    result = runNpm(["run", "clore:watchdog:remote:arm", "--", `--server-id=${serverId}`, "--hard-deadline-minutes=180", "--hard-budget-usd=2.5"], 180_000);
    if (result.status !== 0) { try { assertWatchdogsReadyForCreate(serverId); return { status: 0, stdout: "watchdog_became_healthy_after_transient_error", stderr: "" }; } catch { /* Preserve the failed result. */ } }
  }
  return result;
}

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
  return candidates
    .filter((candidate) => !FAILED_SERVER_IDS.has(candidate.id) && !MANUAL_GOLDEN_SERVER_IDS.has(candidate.id) && /RTX\s*(4090|5090)/i.test(candidate.gpuType) && candidate.vramGb >= 23 && candidate.minimumRamGb >= 32 && candidate.containerDiskGb >= 180 && candidate.interruptible === false && candidate.hourlyUsd !== null && candidate.hourlyUsd <= 0.7 && candidate.hourlyUsd * (MAX_RUNTIME_MINUTES / 60) + CLORE_CREATION_FEE_USD <= MAX_TOTAL_SPEND_USD)
    .sort((left, right) =>
      (recommended.get(left.id) ?? 999) - (recommended.get(right.id) ?? 999) ||
      left.priority - right.priority ||
      (right.reliability ?? -1) - (left.reliability ?? -1) ||
      (right.rating ?? -1) - (left.rating ?? -1) ||
      ((right.downloadMbps ?? 0) + (right.uploadMbps ?? 0)) - ((left.downloadMbps ?? 0) + (left.uploadMbps ?? 0)) ||
      (left.hourlyUsd ?? Infinity) - (right.hourlyUsd ?? Infinity));
}

export type Stage3PAuthorization =
  | { method: "support_acknowledgement"; recommendedServerIds: string[]; ticketId: string; limits: { maxAttempts: 2; maxFailedSpendUsd: 0.4; maxSessionSpendUsd: 2.5 } }
  | { method: "operator_retry" | "operator_retry_continue"; recommendedServerIds: []; nonce: string; expiresAt: string; paths: OperatorRetryPaths; limits: { maxAttempts: 1 | 2; maxFailedSpendUsd: 0.2 | 0.4; maxSessionSpendUsd: 2.5 } }
  | { method: "operator_retry_resume"; recommendedServerIds: []; nonce: string; expiresAt: string; paths: OperatorRetryPaths; orderId: string; limits: { maxAttempts: 1 | 2; maxFailedSpendUsd: 0.2 | 0.4; maxSessionSpendUsd: 2.5 } };

export function resolveStage3PAuthorization(input: { now?: number; supportPath?: string; overridePaths?: OperatorRetryPaths } = {}): Stage3PAuthorization {
  const now = input.now ?? Date.now();
  const acknowledgement = readSupportAcknowledgement(input.supportPath ?? SUPPORT_ACK_PATH, now);
  if (acknowledgement.valid && acknowledgement.acknowledgement) {
    return { method: "support_acknowledgement", recommendedServerIds: acknowledgement.acknowledgement.recommendedServerIds, ticketId: acknowledgement.acknowledgement.ticketId, limits: { maxAttempts: 2, maxFailedSpendUsd: 0.4, maxSessionSpendUsd: 2.5 } };
  }
  const paths = input.overridePaths ?? operatorRetryPaths();
  const override = readOperatorRetryOverride(paths, now);
  if (override.valid && override.override) return { method: "operator_retry", recommendedServerIds: [], nonce: override.override.nonce, expiresAt: override.override.expiresAt, paths, limits: override.override.limits };
  throw new Error([...acknowledgement.blockers, ...override.blockers].join(";"));
}

export async function validateStage3OPreflight() {
  const liveState = readStage3OState(); const activeOrder = readActiveOrder(); const paths = operatorRetryPaths();
  const consumed = readConsumedOperatorRetryOverride(paths);
  let authorization: Stage3PAuthorization;
  if (activeOrder && liveState.attemptCount > 0 && liveState.orderId === activeOrder.order_id && consumed.valid && consumed.override && liveState.attemptCount <= consumed.override.limits.maxAttempts) {
    authorization = { method: "operator_retry_resume", recommendedServerIds: [], nonce: consumed.override.nonce, expiresAt: consumed.override.expiresAt, paths, orderId: activeOrder.order_id, limits: consumed.override.limits };
  } else if (!activeOrder && liveState.attemptCount > 0 && consumed.valid && consumed.override && liveState.attemptCount < consumed.override.limits.maxAttempts && liveState.failedDeploymentSpendUsd < consumed.override.limits.maxFailedSpendUsd) {
    authorization = { method: "operator_retry_continue", recommendedServerIds: [], nonce: consumed.override.nonce, expiresAt: consumed.override.expiresAt, paths, limits: consumed.override.limits };
  } else authorization = resolveStage3PAuthorization();
  const billing = await readGpuBillingStatusWithTransientRetry();
  if (authorization.method === "operator_retry_resume") {
    const blockers: string[] = [];
    if (billing.clore.activeOrders !== 1) blockers.push("stage3p_resume_requires_exactly_one_clore_order");
    if (billing.runpod.activePods !== 0 || billing.runpod.networkVolumes !== 0) blockers.push("stage3p_resume_runpod_resources_present");
    if (billing.createLockPresent) blockers.push("stage3p_resume_create_lock_present");
    if (!billing.holds.runpod) blockers.push("stage3p_resume_runpod_hold_disabled");
    if (!billing.watchdogs.remoteArmed || !billing.watchdogs.scheduledTaskActive) blockers.push("stage3p_resume_watchdog_not_armed");
    if (blockers.length) throw new Error(blockers.join(";"));
  } else {
    const blockers = billingSafetyBlockers(billing); if (blockers.length) throw new Error(blockers.join("；"));
  }
  const pool = readGenerationPool(); const tasks = STAGE3O_TASK_IDS.map((id) => pool.tasks.find((task) => task.id === id));
  const expectedTaskStatus = authorization.method === "operator_retry_resume" || authorization.method === "operator_retry_continue" ? "deploying" : "armed";
  if (pool.scheduler.selectedBatchId !== STAGE3O_BATCH_ID || pool.scheduler.selectedTaskIds.length !== 2 || tasks.some((task) => !task || task.batchId !== STAGE3O_BATCH_ID || task.status !== expectedTaskStatus)) throw new Error("Stage 3O 图片与视频批次状态与当前会话阶段不一致。");
  const flux = await fluxCacheStatus(); if (!flux.ready || flux.total_size_bytes !== 12_451_817_860) throw new Error("FLUX current.json 或对象校验未就绪。");
  const wan = await verifyWanCache(); if (!wan.wan_cache_ready || wan.total_size_bytes !== 18_144_966_705) throw new Error("Wan current.json 或对象校验未就绪。");
  const fluxErrors = validateFluxFirstImageWorkflow(buildFluxFirstImageWorkflow({ width: 1024, height: 1024, steps: 4, seed: 20260715 })); if (fluxErrors.length) throw new Error(`FLUX 工作流不可执行：${fluxErrors.join("；")}`);
  validateStage3OWanWorkflow(buildStage3OWanWorkflow());
  return { authorization, billing, flux, wan, pool };
}

export function deploymentReadinessTimeoutMs(hourlyUsd: number | null, remainingFailedSpendUsd = MAX_FAILED_DEPLOYMENT_SPEND_USD) {
  if (hourlyUsd === null || !Number.isFinite(hourlyUsd) || hourlyUsd <= 0) return 60_000;
  const budgetMinutes = ((remainingFailedSpendUsd - CLORE_CREATION_FEE_USD) / hourlyUsd) * 60;
  return Math.max(60_000, Math.min(MAX_SSH_WAIT_MINUTES * 60_000, Math.floor(budgetMinutes * 60_000)));
}

export function stage3SHardwareInspectionCommand() {
  return "set -e; mkdir -p /workspace; echo '=== gpu_summary ==='; nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version --format=csv,noheader; echo '=== nvidia_smi ==='; nvidia-smi; echo '=== memory_bytes ==='; free -b; echo '=== vcpu ==='; nproc; echo '=== root_disk_bytes ==='; df -B1 /; echo '=== workspace_disk_bytes ==='; df -B1 /workspace; echo '=== python_torch_cuda ==='; python3 --version; python3 -c 'import importlib.util; spec=importlib.util.find_spec(\"torch\"); print(\"torch_present=\"+str(spec is not None).lower()); exec(\"import torch\\nprint(\\\"torch_version=\\\"+torch.__version__)\\nprint(\\\"torch_cuda_version=\\\"+str(torch.version.cuda))\\nprint(\\\"cuda_available=\\\"+str(torch.cuda.is_available()).lower())\\nprint(\\\"cuda_device=\\\"+(torch.cuda.get_device_name(0) if torch.cuda.is_available() else \\\"none\\\"))\\nprint(\\\"compute_capability=\\\"+(str(torch.cuda.get_device_capability(0)) if torch.cuda.is_available() else \\\"none\\\"))\") if spec else None'; echo '=== docker ==='; if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo docker_available=true; docker version; else echo docker_available=false; fi; echo '=== network_probe ==='; curl -L -sS --max-time 20 -o /dev/null -w 'download_bytes=%{size_download} speed_bytes_per_second=%{speed_download} http_code=%{http_code}\\n' 'https://speed.cloudflare.com/__down?bytes=1000000' || echo network_probe_failed";
}

export function stage3SVideoFailureMetadata(error: unknown) {
  return { errorClass: error instanceof Error ? error.message.slice(0, 300) : "wan_failure", imagePreserved: true };
}

export function resetStage3PPreCreateFailure() {
  const pool = readGenerationPool();
  const selected = new Set<string>(STAGE3O_TASK_IDS);
  pool.tasks = pool.tasks.map((task) => {
    if (!selected.has(task.id)) return task;
    const outputMetadata = { ...task.outputMetadata }; delete outputMetadata.errorClass; delete outputMetadata.imagePreserved;
    return { ...task, status: "armed" as const, batchId: STAGE3O_BATCH_ID, outputMetadata };
  });
  pool.scheduler = { ...pool.scheduler, state: "batch_ready", selectedBatchId: STAGE3O_BATCH_ID, selectedTaskIds: [...STAGE3O_TASK_IDS], selectedServerId: null, orderCreationAttempted: false, drainingRequested: false };
  writeGenerationPool(pool);
  return writeStage3OState(initialStage3OState());
}

export function resetStage3RContinuation() {
  const state = readStage3OState();
  if (readActiveOrder()) throw new Error("stage3r_continuation_active_order_present");
  if (state.attemptCount !== 1 || state.failedDeploymentSpendUsd <= 0 || state.failedDeploymentSpendUsd >= MAX_FAILED_DEPLOYMENT_SPEND_USD) throw new Error("stage3r_continuation_state_invalid");
  const pool = readGenerationPool(); const selected = new Set<string>(STAGE3O_TASK_IDS);
  pool.tasks = pool.tasks.map((task) => {
    if (!selected.has(task.id)) return task;
    const outputMetadata = { ...task.outputMetadata }; delete outputMetadata.errorClass; delete outputMetadata.imagePreserved;
    return { ...task, status: "deploying" as const, batchId: STAGE3O_BATCH_ID, outputMetadata };
  });
  pool.scheduler = { ...pool.scheduler, state: "batch_ready", selectedBatchId: STAGE3O_BATCH_ID, selectedTaskIds: [...STAGE3O_TASK_IDS], selectedServerId: null, orderCreationAttempted: true, drainingRequested: false };
  writeGenerationPool(pool);
  const preflightDetails = state.details.preflight_validated;
  return writeStage3OState({ ...state, completed: ["preflight_validated"], details: preflightDetails ? { preflight_validated: preflightDetails } : {}, orderId: null, serverId: null, lastError: null });
}

function resetDeploymentAttemptCheckpoints(state: Stage3OLiveState) {
  const reset = new Set(["watchdog_armed", "order_created", "ssh_ready"]);
  const details = { ...state.details };
  for (const checkpoint of reset) delete details[checkpoint as keyof typeof details];
  return writeStage3OState({ ...state, completed: state.completed.filter((checkpoint) => !reset.has(checkpoint)), details, orderId: null, serverId: null });
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
  const cleanupObservations: Array<{ activeCloreOrders: number; activeRunPodPods: number; runPodVolumes: number; balanceUsd: number | null }> = [];
  let finalBilling = await readGpuBillingStatusWithTransientRetry(); let previousBalance: number | null = null; let balanceStable = false; let zeroResourceConfirmations = 0;
  for (let index = 0; index < 3; index += 1) {
    if (index > 0) finalBilling = await readGpuBillingStatusWithTransientRetry();
    const balance = (await provider.getBalance()).availableUsd;
    cleanupObservations.push({ activeCloreOrders: finalBilling.clore.activeOrders, activeRunPodPods: finalBilling.runpod.activePods, runPodVolumes: finalBilling.runpod.networkVolumes, balanceUsd: balance });
    if (finalBilling.clore.activeOrders === 0 && finalBilling.runpod.activePods === 0 && finalBilling.runpod.networkVolumes === 0) zeroResourceConfirmations += 1;
    if (previousBalance !== null && balance !== null && balance >= previousBalance - 0.0001) balanceStable = true;
    previousBalance = balance;
    if (zeroResourceConfirmations >= 2 && balanceStable) break;
    await sleep(5_000);
  }
  const blockers = billingSafetyBlockers(finalBilling);
  if (zeroResourceConfirmations < 2) blockers.push("stage3s_active_order_zero_not_confirmed_twice");
  if (!balanceStable) blockers.push("stage3s_balance_still_decreasing_or_unavailable");
  if (blockers.length) throw new Error(`stage3o_cleanup_incomplete:${blockers.join("；")}`);
  if (!next.completed.includes("cleanup_verified")) next = completeStage3OCheckpoint(next, "cleanup_verified", { activeOrders: 0, activeOrderZeroConfirmations: zeroResourceConfirmations, balanceStable, cleanupObservations, holdsRestored: true, watchdogDisarmExitCode: disarm.status, watchdogTaskDisableExitCode: disableTask.status });
  const pool = readGenerationPool(); pool.scheduler.state = "completed"; writeGenerationPool(pool);
  clearManualParitySecrets();
  return next;
}

async function legacyMain() {
  if (argument("provider") !== "clore" || argument("batch") !== STAGE3O_BATCH_ID) throw new Error("只允许 --provider=clore --batch=stage3o。");
  const preflight = await validateStage3OPreflight(); let state = readStage3OState();
  if (!state.completed.includes("preflight_validated")) state = completeStage3OCheckpoint(state, "preflight_validated", { authorizationMethod: preflight.authorization.method, ticketId: preflight.authorization.method === "support_acknowledgement" ? preflight.authorization.ticketId : null, operatorOverrideExpiresAt: preflight.authorization.method === "operator_retry" ? preflight.authorization.expiresAt : null, fluxBytes: preflight.flux.total_size_bytes, wanBytes: preflight.wan.total_size_bytes });
  const provider = getGpuProvider("clore"); let session = await provider.recoverExistingSession(STAGE3O_BATCH_ID); let target: GpuTarget | null = session?.target ?? null;
  let createRequestAttempted = preflight.authorization.method === "operator_retry_resume";
  try {
    if (!session) {
      if (state.attemptCount >= MAX_HOST_ATTEMPTS) throw new Error("stage3p_single_host_attempt_already_used");
      const candidates = rankStage3OCandidates(await provider.listCandidates(), preflight.authorization.recommendedServerIds);
      const candidate = candidates[0]; if (!candidate) throw new Error("当前没有满足 Stage 3P 显存、内存、150GB 磁盘、历史排除项和预算的 Clore 主机。");
      state = writeStage3OState({ ...state, serverId: candidate.id });
      requireSuccess(runNpm(["run", "clore:watchdog:local:install"]), "watchdog_task_install_failed");
      requireSuccess(armRemoteWatchdogWithTransientRetry(candidate.id), "watchdog_arm_failed");
      if (!state.completed.includes("watchdog_armed")) state = completeStage3OCheckpoint(state, "watchdog_armed", { serverId: candidate.id, hardDeadlineMinutes: 180, hardBudgetUsd: 2.5 });
      setCloreDeploymentHold(false, preflight.authorization.method === "support_acknowledgement" ? "stage3p_valid_support_acknowledgement" : "stage3p_operator_accepted_platform_risk");
      try {
        setGenerationTaskStatus([...STAGE3O_TASK_IDS], "deploying");
        session = await provider.createSession({
          sessionId: STAGE3O_BATCH_ID,
          candidate,
          sshPublicKey: "managed-by-clore-provider",
          bootstrapImage: FIXED_RUNTIME_DIGEST,
          dryRun: false,
          beforeCreateRequest: () => {
            if (preflight.authorization.method === "operator_retry") consumeOperatorRetryOverride(preflight.authorization.paths);
            state = writeStage3OState({ ...state, attemptCount: state.attemptCount + 1, serverId: candidate.id });
            createRequestAttempted = true;
          },
          afterCreateRequestAttempt: () => {
            if (preflight.authorization.method === "operator_retry") markOperatorRetryConsumed(preflight.authorization.paths);
          },
        });
        const readinessTimeoutMs = deploymentReadinessTimeoutMs(session.hourlyUsd);
        state = writeStage3OState({ ...state, orderId: session.id }); if (!state.completed.includes("order_created")) state = completeStage3OCheckpoint(state, "order_created", { orderId: session.id, serverId: candidate.id, gpu: candidate.gpuType, hourlyUsd: session.hourlyUsd, reliability: candidate.reliability, rating: candidate.rating, downloadMbps: candidate.downloadMbps, uploadMbps: candidate.uploadMbps, readinessTimeoutSeconds: Math.floor(readinessTimeoutMs / 1000) });
        const waitStartedAt = Date.now();
        target = await provider.waitForSsh(session, readinessTimeoutMs); if (!state.completed.includes("ssh_ready")) state = completeStage3OCheckpoint(state, "ssh_ready", { target: sanitizeGpuTarget(target), waitSeconds: Math.round((Date.now() - waitStartedAt) / 1000) });
      } catch (error) {
        session ??= await provider.recoverExistingSession(STAGE3O_BATCH_ID);
        if (session) {
          const billing = await provider.getBilling(session); await provider.terminateSession(session);
          state = writeStage3OState({ ...state, failedDeploymentSpendUsd: Number((state.failedDeploymentSpendUsd + (billing.estimatedSpendUsd ?? 0) + CLORE_CREATION_FEE_USD).toFixed(4)), orderId: null });
          session = null;
        } else if (createRequestAttempted) state = writeStage3OState({ ...state, failedDeploymentSpendUsd: Number((state.failedDeploymentSpendUsd + CLORE_CREATION_FEE_USD).toFixed(4)), orderId: null });
        setCloreDeploymentHold(true, "stage3p_failed_single_host_attempt"); runNpm(["run", "clore:watchdog:remote:disarm"]); disableLocalWatchdogTask();
        throw error;
      }
    }
    if (!session) throw new Error("Stage 3P 未获得可用 Clore 会话。"); target ??= await provider.waitForSsh(session, deploymentReadinessTimeoutMs(session.hourlyUsd));
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
    if (createRequestAttempted && preflight.authorization.method === "operator_retry") {
      try { markOperatorRetryConsumed(preflight.authorization.paths); } catch { /* The final billing/hold cleanup remains authoritative. */ }
    }
    if (createRequestAttempted && session && state.failedDeploymentSpendUsd === 0) {
      try {
        const billing = await provider.getBilling(session);
        state = writeStage3OState({ ...state, failedDeploymentSpendUsd: Number(((billing.estimatedSpendUsd ?? 0) + CLORE_CREATION_FEE_USD).toFixed(4)) });
      } catch { /* Final wallet delta remains the authoritative spend readback. */ }
    }
    const pool = readGenerationPool();
    const imageCompleted = pool.tasks.find((task) => task.id === STAGE3O_IMAGE_TASK_ID)?.status === "completed";
    if (!imageCompleted) {
      setGenerationTaskStatus([STAGE3O_IMAGE_TASK_ID], "failed", { errorClass: error instanceof Error ? error.message.slice(0, 300) : "stage3p_failure" });
      setGenerationTaskStatus([STAGE3O_VIDEO_TASK_ID], "failed", { errorClass: "image_prerequisite_failed", imagePreserved: false });
    }
    state = checkpointThroughFailure(state, error); state = await cleanup(session, target, provider, state).catch(() => writeStage3OState({ ...state, lastError: error instanceof Error ? error.message : "stage3o_failure" }));
    if (!createRequestAttempted) state = resetStage3PPreCreateFailure();
    throw error;
  } finally { setCloreDeploymentHold(true, "stage3o_finally"); }
}

void legacyMain;

async function main() {
  if (argument("provider") !== "clore" || argument("batch") !== STAGE3O_BATCH_ID) throw new Error("only --provider=clore --batch=stage3o is allowed");
  const preflight = await validateStage3OPreflight();
  let state = readStage3OState();
  if (!state.completed.includes("preflight_validated")) {
    state = completeStage3OCheckpoint(state, "preflight_validated", {
      authorizationMethod: preflight.authorization.method,
      ticketId: preflight.authorization.method === "support_acknowledgement" ? preflight.authorization.ticketId : null,
      operatorOverrideExpiresAt: preflight.authorization.method !== "support_acknowledgement" ? preflight.authorization.expiresAt : null,
      limits: preflight.authorization.limits,
      fluxBytes: preflight.flux.total_size_bytes,
      wanBytes: preflight.wan.total_size_bytes,
    });
  }
  const provider = getGpuProvider("clore");
  let session = await provider.recoverExistingSession(STAGE3O_BATCH_ID);
  let target: GpuTarget | null = session?.target ?? null;
  let createRequestAttempted = state.attemptCount > 0 || preflight.authorization.method === "operator_retry_resume";
  try {
    if (!session) {
      const candidates = rankStage3OCandidates(await provider.listCandidates(), preflight.authorization.recommendedServerIds);
      while (!session && state.attemptCount < preflight.authorization.limits.maxAttempts) {
        const remainingFailedSpendUsd = Number((preflight.authorization.limits.maxFailedSpendUsd - state.failedDeploymentSpendUsd).toFixed(4));
        if (remainingFailedSpendUsd <= CLORE_CREATION_FEE_USD) throw new Error("clore_failed_deployment_budget_exhausted");
        const candidate = candidates[state.attemptCount];
        if (!candidate) throw new Error("no_unused_clore_candidate_meets_stage3r_requirements");
        const attemptBeforeCreate = state.attemptCount;
        state = writeStage3OState({ ...state, serverId: candidate.id });
        requireSuccess(runNpm(["run", "clore:watchdog:local:install"]), "watchdog_task_install_failed");
        requireSuccess(armRemoteWatchdogWithTransientRetry(candidate.id), "watchdog_arm_failed");
        if (!state.completed.includes("watchdog_armed")) state = completeStage3OCheckpoint(state, "watchdog_armed", { serverId: candidate.id, hardDeadlineMinutes: 180, hardBudgetUsd: 2.5 });
        setCloreDeploymentHold(false, preflight.authorization.method === "support_acknowledgement" ? "stage3r_valid_support_acknowledgement" : "stage3r_operator_accepted_platform_risk");
        try {
          setGenerationTaskStatus([...STAGE3O_TASK_IDS], "deploying");
          session = await provider.createSession({
            sessionId: STAGE3O_BATCH_ID,
            candidate,
            sshPublicKey: "managed-by-clore-provider",
            bootstrapImage: FIXED_RUNTIME_DIGEST,
            dryRun: false,
            cloreProfile: "clore_manual_parity",
            beforeCreateRequest: () => {
              if (preflight.authorization.method === "operator_retry" && attemptBeforeCreate === 0) consumeOperatorRetryOverride(preflight.authorization.paths);
              state = writeStage3OState({ ...state, attemptCount: state.attemptCount + 1, serverId: candidate.id });
              createRequestAttempted = true;
            },
            afterCreateRequestAttempt: () => {
              if (preflight.authorization.method === "operator_retry" && attemptBeforeCreate === 0) markOperatorRetryConsumed(preflight.authorization.paths);
            },
          });
          const readinessTimeoutMs = deploymentReadinessTimeoutMs(session.hourlyUsd, remainingFailedSpendUsd);
          state = writeStage3OState({ ...state, orderId: session.id });
          if (!state.completed.includes("order_created")) state = completeStage3OCheckpoint(state, "order_created", { orderId: session.id, serverId: candidate.id, gpu: candidate.gpuType, hourlyUsd: session.hourlyUsd, reliability: candidate.reliability, rating: candidate.rating, downloadMbps: candidate.downloadMbps, uploadMbps: candidate.uploadMbps, readinessTimeoutSeconds: Math.floor(readinessTimeoutMs / 1000), parityProfile: "password_key_autossh_minimal" });
          const waitStartedAt = Date.now();
          target = await provider.waitForSsh(session, readinessTimeoutMs);
          if (!state.completed.includes("ssh_ready")) state = completeStage3OCheckpoint(state, "ssh_ready", { target: sanitizeGpuTarget(target), waitSeconds: Math.round((Date.now() - waitStartedAt) / 1000), ...readCloreSshAuthEvidence() });
        } catch (error) {
          session ??= await provider.recoverExistingSession(STAGE3O_BATCH_ID);
          let attemptSpend = createRequestAttempted && state.attemptCount > attemptBeforeCreate ? CLORE_CREATION_FEE_USD : 0;
          if (session) {
            const billing = await provider.getBilling(session);
            attemptSpend += billing.estimatedSpendUsd ?? 0;
            await provider.terminateSession(session);
            session = null;
          }
          clearManualParitySecrets();
          if (attemptSpend > 0) state = writeStage3OState({ ...state, failedDeploymentSpendUsd: Number((state.failedDeploymentSpendUsd + attemptSpend).toFixed(4)), orderId: null });
          setCloreDeploymentHold(true, "stage3r_failed_host_attempt");
          runNpm(["run", "clore:watchdog:remote:disarm"]);
          disableLocalWatchdogTask();
          if (state.attemptCount <= attemptBeforeCreate || state.attemptCount >= preflight.authorization.limits.maxAttempts || state.failedDeploymentSpendUsd >= preflight.authorization.limits.maxFailedSpendUsd) throw error;
          state = resetDeploymentAttemptCheckpoints(state);
        }
      }
    }
    if (!session) throw new Error("stage3r_no_usable_clore_session");
    target ??= await provider.waitForSsh(session, deploymentReadinessTimeoutMs(session.hourlyUsd, preflight.authorization.limits.maxFailedSpendUsd - state.failedDeploymentSpendUsd));
    if (!state.completed.includes("ssh_ready")) state = completeStage3OCheckpoint(state, "ssh_ready", { target: sanitizeGpuTarget(target), ...readCloreSshAuthEvidence() });
    if (!state.completed.includes("hardware_inspected")) {
      const inspection = requireSuccess(sshCommand(target, stage3SHardwareInspectionCommand(), 180_000), "hardware_inspection_failed");
      state = completeStage3OCheckpoint(state, "hardware_inspected", { fullOutput: inspection });
    }
    if (!state.completed.includes("image_synced")) {
      setGenerationTaskStatus([STAGE3O_IMAGE_TASK_ID], "restoring_models");
      const result = await runRemoteFirstImage(target, "clore", STAGE3O_IMAGE_TASK_ID, session.gpuType ?? "unknown", { warmRun: false });
      state = completeStage3OCheckpoint(state, "flux_restored", { elapsedMs: result.restoreElapsedMs, verified: true });
      setGenerationTaskStatus([STAGE3O_IMAGE_TASK_ID], "generating");
      state = completeStage3OCheckpoint(state, "image_generated", result.generated);
      setGenerationTaskStatus([STAGE3O_IMAGE_TASK_ID], "syncing");
      state = completeStage3OCheckpoint(state, "image_synced", { localArchive: true });
      setGenerationTaskStatus([STAGE3O_IMAGE_TASK_ID], "completed", { outputPath: String((result.generated.archive as Record<string, unknown> | undefined)?.outputPath ?? "") });
    }
    if (!state.completed.includes("flux_unloaded")) {
      requireSuccess(sshCommand(target, "curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"unload_models\":true,\"free_memory\":true}' http://127.0.0.1:8188/free >/dev/null", 60_000), "flux_unload_failed");
      state = completeStage3OCheckpoint(state, "flux_unloaded", { cudaCacheCleared: true });
    }
    try {
      if (!state.completed.includes("outputs_synced")) {
        setGenerationTaskStatus([STAGE3O_VIDEO_TASK_ID], "restoring_models");
        const wan = await runWan(target);
        state = completeStage3OCheckpoint(state, "wan_restored", wan.restore as Record<string, unknown>);
        setGenerationTaskStatus([STAGE3O_VIDEO_TASK_ID], "generating");
        state = completeStage3OCheckpoint(state, "video_generated", wan.generated);
        setGenerationTaskStatus([STAGE3O_VIDEO_TASK_ID], "syncing");
        state = completeStage3OCheckpoint(state, "outputs_synced", { imagePreserved: true, videoSynced: true });
        setGenerationTaskStatus([STAGE3O_VIDEO_TASK_ID], "completed", { outputPath: String(wan.generated.outputPath ?? ""), thumbnailPath: String(wan.generated.thumbnailPath ?? "") });
      }
    } catch (error) {
      setGenerationTaskStatus([STAGE3O_VIDEO_TASK_ID], "failed", stage3SVideoFailureMetadata(error));
      state = checkpointThroughFailure(state, error);
    }
    state = await cleanup(session, target, provider, state);
    session = null;
    const output = { completed: true, batch: STAGE3O_BATCH_ID, checkpoints: state.completed, attempts: state.attemptCount, failedDeploymentSpendUsd: state.failedDeploymentSpendUsd, imageStatus: readGenerationPool().tasks.find((task) => task.id === STAGE3O_IMAGE_TASK_ID)?.status, videoStatus: readGenerationPool().tasks.find((task) => task.id === STAGE3O_VIDEO_TASK_ID)?.status, hold: getCloreDeploymentHold() };
    const text = JSON.stringify(output, null, 2); assertNoSecretOutput(text); console.log(text);
  } catch (error) {
    if (createRequestAttempted && preflight.authorization.method === "operator_retry") {
      try { markOperatorRetryConsumed(preflight.authorization.paths); } catch { /* Final billing and hold state are authoritative. */ }
    }
    const pool = readGenerationPool();
    const imageCompleted = pool.tasks.find((task) => task.id === STAGE3O_IMAGE_TASK_ID)?.status === "completed";
    if (!imageCompleted) {
      setGenerationTaskStatus([STAGE3O_IMAGE_TASK_ID], "failed", { errorClass: error instanceof Error ? error.message.slice(0, 300) : "stage3r_failure" });
      setGenerationTaskStatus([STAGE3O_VIDEO_TASK_ID], "failed", { errorClass: "image_prerequisite_failed", imagePreserved: false });
    }
    state = checkpointThroughFailure(state, error);
    state = await cleanup(session, target, provider, state).catch(() => writeStage3OState({ ...state, lastError: error instanceof Error ? error.message : "stage3r_failure" }));
    if (!createRequestAttempted) state = resetStage3PPreCreateFailure();
    throw error;
  } finally {
    clearManualParitySecrets();
    setCloreDeploymentHold(true, "stage3r_finally");
  }
}

if (process.argv[1]?.endsWith("generation-live-session.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "stage3o_live_session_failed"); process.exitCode = 1; });
