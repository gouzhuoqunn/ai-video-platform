import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getLocalLabCloreCandidates } from "../src/lib/local-lab/clore-console";
import { GENERATION_POOL_PATH, readGenerationPool, updateManualGpuBatch, type ManualGpuExecutionBatch, type ManualGpuRunnerStage } from "../src/lib/generation/task-pool";
import { runManualSilent4090Batch } from "../src/lib/generation/manual-gpu-batch-runner";
import { getGpuProvider } from "./gpu-providers";
import type { GpuTarget } from "./gpu-providers/types";
import { scpFile, sshCommand } from "./gpu-providers/common";
import { createHttpWanTransport, createRealWanTransport } from "./wan-real-transport";
import { buildRuntimeOverlay } from "./runtime-overlay";
import { installRemoteComfyRunner, runRemoteComfyProbe } from "./comfy-remote-runner";
import { isDeploymentHostBlacklisted, recordDeploymentFailure } from "./clore/deployment-host-blacklist";
import { installLocalWatchdogTask } from "./clore/watchdog-io";
import { assertWatchdogsReadyForCreate } from "./clore/watchdog-preflight";

const STATE_DIR = path.join(process.cwd(), ".secrets", "gpu-session-runner");
const PID_PATH = path.join(STATE_DIR, "runner.pid");
const STATUS_PATH = path.join(STATE_DIR, "status.json");
const INTERVAL_MS = 3_000;
const SSH_AUTH_TIMEOUT_MS = 40 * 60_000;

type RunnerStatus = { pid: number; updatedAt: string; state: "idle" | "searching" | "candidate_selected" | "blocked" | "order_created" | "error"; batchId: string | null; message: string };
type Candidate = { server_id: string; base_usd_per_hour?: number | null; effective_usd_per_hour?: number | null; gpu?: string | null };
type CandidateReader = () => Promise<{ selected?: Candidate | null } | Record<string, unknown>>;
type WanSession = { ensureRestored(): Promise<unknown>; run(task: { id: string; prompt: string; seed?: number }): Promise<{ generated: { outputPath: string; thumbnailPath: string } }>; stop(): Promise<void> };

function commandOutput(result: ReturnType<typeof sshCommand | typeof scpFile>) {
  return String(result.stderr ?? result.stdout ?? result.error?.message ?? `exit_${result.status}`).trim().slice(-1_500);
}
function requireRemoteSuccess(result: ReturnType<typeof sshCommand | typeof scpFile>, code: string) {
  if (result.status !== 0) throw new Error(`${code}:${commandOutput(result)}`);
}
function sanitizedOrderPayload(input: {
  serverId: string | null;
  orderId: string | null;
  requiredPrice: number | null;
  deploymentState?: string | null;
  startedAt?: string | null;
  sshHost?: string | null;
  sshPort?: number | null;
  latestSshAuthError?: string | null;
  createResponseStatus?: string | null;
}) {
  return {
    image: "ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime@sha256:78c9964cc5c0fc3b1be081df09c8bee225e7c0b175844e321f3175671cfa6a3d",
    ports: ["8080/http"],
    commandPresent: false,
    autosshEntrypoint: null,
    serverId: input.serverId,
    orderId: input.orderId,
    requiredPrice: input.requiredPrice,
    deploymentState: input.deploymentState ?? null,
    startedAt: input.startedAt ?? null,
    sshHost: input.sshHost ?? null,
    sshPort: input.sshPort ?? null,
    latestSshAuthError: input.latestSshAuthError ?? null,
    createResponseStatus: input.createResponseStatus ?? null,
    updatedAt: new Date().toISOString(),
  };
}

function readableSshError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed/i.test(message)) return "fetch failed";
  if (/ssh_tcp_not_ready/i.test(message)) return "ssh_tcp_not_ready";
  if (/ssh_public_key_rejected/i.test(message)) return "ssh_public_key_rejected";
  if (/order_not_deployed/i.test(message)) return "order_not_deployed";
  return message.slice(-500);
}

function statusPath() { mkdirSync(STATE_DIR, { recursive: true }); return STATUS_PATH; }
function writeStatus(status: Omit<RunnerStatus, "pid" | "updatedAt">) {
  writeFileSync(statusPath(), JSON.stringify({ ...status, pid: process.pid, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}
function clearRunnerPidIfOwned() {
  if (existsSync(PID_PATH) && Number(readFileSync(PID_PATH, "utf8")) === process.pid) rmSync(PID_PATH, { force: true });
}
function updateIntent(batch: ManualGpuExecutionBatch, patch: Partial<NonNullable<ManualGpuExecutionBatch["startIntent"]>>, poolPath = GENERATION_POOL_PATH) {
  if (!batch.startIntent) return;
  updateManualGpuBatch({ status: batch.status, stateRevision: batch.stateRevision + 1, startIntent: { ...batch.startIntent, ...patch, stateRevision: batch.stateRevision + 1 } }, poolPath);
}
function report(batchId: string, stage: ManualGpuRunnerStage, message: string, poolPath = GENERATION_POOL_PATH, error: string | null = null, taskNumber: number | null = null) {
  const batch = readGenerationPool(poolPath).scheduler.manualBatch;
  if (!batch || batch.id !== batchId) return;
  updateManualGpuBatch({ runnerProgress: { stage, message, error, taskNumber, updatedAt: new Date().toISOString() } }, poolPath);
  writeStatus({ state: error ? "error" : stage === "search_candidates" ? "searching" : stage === "creating_order" ? "candidate_selected" : "order_created", batchId, message });
}
function recordRunnerError(error: unknown, poolPath = GENERATION_POOL_PATH) {
  const batch = readGenerationPool(poolPath).scheduler.manualBatch;
  const message = error instanceof Error ? error.message.slice(0, 240) : "runner_failure";
  if (batch?.startIntent && !["completed", "canceled", "failed"].includes(batch.status)) {
    updateIntent(batch, { lastError: message }, poolPath);
  }
  if (batch) report(batch.id, "error", message, poolPath, message);
  else writeStatus({ state: "error", batchId: null, message });
}
function mutationsEnabled() {
  return process.env.LOCAL_LAB_ENABLED === "true"
    && process.env.NEXT_PUBLIC_APP_MODE === "local_lab"
    && process.env.LOCAL_REAL_GPU_RENTAL_ENABLED === "true"
    && process.env.CLORE_ORDER_EXECUTION_ENABLED === "true";
}

function rearmWatchdogsBeforeCreate(serverId: string) {
  try {
    assertWatchdogsReadyForCreate(serverId);
    return;
  } catch {
    // A stale local heartbeat commonly means Windows has disabled the scheduled
    // task. Recreating it re-enables the task, then the arm command writes both
    // fresh local and remote watchdog state before any order can be created.
    installLocalWatchdogTask();
    const command = process.platform === "win32"
      ? { file: "cmd.exe", args: ["/c", "npm", "run", "clore:watchdog:remote:arm", "--", `--server-id=${serverId}`, "--hard-deadline-minutes=180", "--hard-budget-usd=4.5"] }
      : { file: "npm", args: ["run", "clore:watchdog:remote:arm", "--", `--server-id=${serverId}`, "--hard-deadline-minutes=180", "--hard-budget-usd=4.5"] };
    const armed = spawnSync(command.file, command.args, { cwd: process.cwd(), encoding: "utf8", stdio: "pipe", timeout: 180_000 });
    if (armed.status !== 0) throw new Error("订单监控恢复失败，未创建 Clore 订单。");
    assertWatchdogsReadyForCreate(serverId);
  }
}

function inspectCudaBaseHost(target: GpuTarget) {
  const inspection = sshCommand(target, "set -e; nvidia-smi; free -b; df -B1 /workspace 2>/dev/null || df -B1 /", 60_000);
  requireRemoteSuccess(inspection, "cuda_base_hardware_check_failed");
  return String(inspection.stdout ?? "").trim();
}

function bootstrapCudaBaseWanRuntime(target: GpuTarget) {
  const overlay = buildRuntimeOverlay();
  const bootstrap = path.join(process.cwd(), "scripts", "clore", "clore-light-bootstrap.sh");
  requireRemoteSuccess(sshCommand(target, "mkdir -p /workspace", 30_000), "cuda_base_workspace_create_failed");
  requireRemoteSuccess(scpFile(target, overlay.outputPath, "/workspace/runtime-overlay.tgz", 5 * 60_000), "cuda_base_overlay_copy_failed");
  requireRemoteSuccess(scpFile(target, bootstrap, "/workspace/clore-light-bootstrap.sh", 2 * 60_000), "cuda_base_bootstrap_copy_failed");
  requireRemoteSuccess(sshCommand(target, "set -e; sed -i 's/\\r$//' /workspace/clore-light-bootstrap.sh; chmod 700 /workspace/clore-light-bootstrap.sh; /workspace/clore-light-bootstrap.sh prepare /workspace/runtime-overlay.tgz rtx4090", 55 * 60_000), "cuda_base_runtime_prepare_failed");
  requireRemoteSuccess(sshCommand(target, "/workspace/clore-light-bootstrap.sh start rtx4090", 90_000), "cuda_base_runtime_start_failed");
  installRemoteComfyRunner(target);
  runRemoteComfyProbe(target);
}

async function refreshOrderPayload(input: {
  batch: ManualGpuExecutionBatch;
  orderId: string;
  poolPath: string;
  latestSshAuthError?: string | null;
  target?: GpuTarget | null;
}) {
  const latest = readGenerationPool(input.poolPath).scheduler.manualBatch;
  if (!latest?.startIntent || latest.id !== input.batch.id) return;
  const existing = latest.startIntent.orderPayload;
  let live: { deploymentState?: string; startedAt?: string | null; sshHost?: string | null; sshPort?: number | null } | null = null;
  try {
    const { loadCloreConfig } = await import("./clore/config");
    const { readLiveOrdersSummary } = await import("./clore/live");
    live = (await readLiveOrdersSummary(loadCloreConfig(), { forceRefresh: true })).find((order) => order.orderId === input.orderId) ?? null;
  } catch {
    // The persisted payload still captures the local evidence if Clore status is briefly unavailable.
  }
  updateIntent(latest, {
    orderPayload: sanitizedOrderPayload({
      serverId: latest.startIntent.selectedServerId ?? existing?.serverId ?? null,
      orderId: input.orderId,
      requiredPrice: existing?.requiredPrice ?? latest.startIntent.maxEffectiveHourlyUsd,
      deploymentState: live?.deploymentState ?? existing?.deploymentState ?? null,
      startedAt: live?.startedAt ?? existing?.startedAt ?? latest.startIntent.orderCreatedAt ?? null,
      sshHost: input.target?.host ?? live?.sshHost ?? existing?.sshHost ?? null,
      sshPort: input.target?.port ?? live?.sshPort ?? existing?.sshPort ?? null,
      latestSshAuthError: input.latestSshAuthError ?? existing?.latestSshAuthError ?? null,
      createResponseStatus: existing?.createResponseStatus ?? null,
    }),
  }, input.poolPath);
}

export async function executeFrozenWanBatch(input: { target: GpuTarget; poolPath?: string; transport?: WanSession; onStage?: (stage: ManualGpuRunnerStage, message: string, taskNumber?: number | null) => void }) {
  const poolPath = input.poolPath ?? GENERATION_POOL_PATH;
  const transport = input.transport ?? createRealWanTransport(input.target);
  return runManualSilent4090Batch({
    async loadWan22() { input.onStage?.("restoring_wan", "恢复 Wan"); await transport.ensureRestored(); input.onStage?.("starting_worker", "启动 Worker"); },
    async runSilentShortVideo(task) {
      const batch = readGenerationPool(poolPath).scheduler.manualBatch;
      input.onStage?.("generating", `生成 ${Math.min((batch?.completedCount ?? 0) + (batch?.failedCount ?? 0) + 1, batch?.taskCount ?? 1)}/${batch?.taskCount ?? 1}`, (batch?.completedCount ?? 0) + (batch?.failedCount ?? 0) + 1);
      const result = await transport.run({ id: task.id, prompt: task.prompt, seed: task.seed ?? undefined });
      input.onStage?.("uploading", "回传结果");
      return { outputMetadata: { outputPath: result.generated.outputPath, thumbnailPath: result.generated.thumbnailPath } };
    },
    async unloadWan22() { input.onStage?.("idle_countdown", "空闲倒计时"); await transport.stop(); },
  }, poolPath);
}

async function resumeCreatedWanBatch(input: { batch: ManualGpuExecutionBatch; orderId: string; poolPath: string }) {
  const orderCreatedAt = input.batch.startIntent?.orderCreatedAt ?? input.batch.createdAt;
  if (Date.now() - Date.parse(orderCreatedAt) >= SSH_AUTH_TIMEOUT_MS) {
    const message = "Clore 在 40 分钟内未开放 HTTP runtime，已取消本次未运行订单。";
    report(input.batch.id, "error", message, input.poolPath, message);
    await refreshOrderPayload({ batch: input.batch, orderId: input.orderId, poolPath: input.poolPath, latestSshAuthError: input.batch.startIntent?.orderPayload?.latestSshAuthError ?? message });
    recordDeploymentFailure({
      serverId: input.batch.startIntent?.selectedServerId ?? "",
      orderId: input.orderId,
      reason: "deployment_timeout_without_ssh",
    });
    const provider = getGpuProvider("clore");
    const session = await provider.recoverExistingSession(input.orderId);
    if (session) await provider.terminateSession(session);
    const latest = readGenerationPool(input.poolPath).scheduler.manualBatch;
    if (latest?.startIntent) {
      updateIntent(latest, { status: "canceled", lastError: message }, input.poolPath);
      updateManualGpuBatch({ status: "failed", currentTaskId: null, recoveryState: "clean" }, input.poolPath);
    }
    return { action: "deployment_timeout" as const, orderId: input.orderId };
  }
  report(input.batch.id, "waiting_deployment", "等待 HTTP runtime", input.poolPath);
  const provider = getGpuProvider("clore");
  const session = await provider.recoverExistingSession(input.orderId);
  if (!session) throw new Error("runner_created_order_not_recoverable");
  try {
    const { loadCloreConfig } = await import("./clore/config"); const { readLiveOrdersSummary } = await import("./clore/live");
    const deadline = Date.now() + Math.max(1_000, SSH_AUTH_TIMEOUT_MS - (Date.now() - Date.parse(orderCreatedAt)));
    let controllerUrl = "";
    while (Date.now() < deadline) {
      const live = (await readLiveOrdersSummary(loadCloreConfig(), { forceRefresh: true })).find((order) => order.orderId === input.orderId);
      controllerUrl = live?.controllerUrl ?? "";
      if (controllerUrl) {
        try { const health = await fetch(`${controllerUrl}/healthz`); if (health.ok) break; } catch { /* deployment is still converging */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    if (!controllerUrl) throw new Error("http_runtime_endpoint_not_published");
    report(input.batch.id, "pulling_runtime", "HTTP runtime ready", input.poolPath);
    const target = { provider: "clore" as const, host: "http-runtime", port: 0, username: "", sshKeyPath: "", gpuProfile: "rtx4090" as const, runtimeDigest: "http-controller" };
    const completed = await executeFrozenWanBatch({ target, poolPath: input.poolPath, transport: createHttpWanTransport(controllerUrl), onStage: (stage, message, taskNumber) => report(input.batch.id, stage, message, input.poolPath, null, taskNumber ?? null) });
    report(input.batch.id, "terminating", "退租", input.poolPath);
    await provider.terminateSession(session);
    report(input.batch.id, "completed", "批次已完成", input.poolPath);
    return { action: "batch_completed" as const, orderId: input.orderId, completed };
  } catch (error) {
    const message = error instanceof Error ? error.message : "runner_session_failed";
    if (/http_runtime_endpoint_not_published|fetch failed|deployment/i.test(message)) {
      report(input.batch.id, "waiting_deployment", "HTTP runtime 尚未就绪", input.poolPath, null);
      return { action: "awaiting_deployment" as const, orderId: input.orderId };
    }
    report(input.batch.id, "error", message, input.poolPath, message);
    await provider.terminateSession(session).catch(() => undefined);
    throw error;
  }
}

/** One idempotent runner tick. It is intentionally the only non-browser mutation owner. */
export async function runGpuSessionRunnerTick(readCandidates: CandidateReader | undefined = undefined, poolPath = GENERATION_POOL_PATH) {
  const batch = readGenerationPool(poolPath).scheduler.manualBatch;
  const candidateReader = readCandidates ?? (() => getLocalLabCloreCandidates("manual_silent_4090", batch?.startIntent?.maxEffectiveHourlyUsd ?? 0.7));
  if (!batch?.startIntent || ["completed", "canceled", "failed"].includes(batch.status)) {
    writeStatus({ state: "idle", batchId: batch?.id ?? null, message: "没有待处理的 RTX 4090 批次" });
    return { action: "idle" as const };
  }
  if (batch.startIntent.status === "order_created" && batch.providerOrderId) {
    if (!mutationsEnabled()) {
      writeStatus({ state: "blocked", batchId: batch.id, message: "真实 GPU 执行开关未启用；订单仍保留，未恢复远端会话。" });
      return { action: "mutation_disabled" as const };
    }
    return resumeCreatedWanBatch({ batch, orderId: batch.providerOrderId, poolPath });
  }
  if (batch.startIntent.status === "requested" || batch.startIntent.status === "runner_claimed") {
    updateIntent(batch, { status: "runner_claimed", lastError: null }, poolPath);
    updateManualGpuBatch({ status: "searching" }, poolPath);
    report(batch.id, "search_candidates", "搜索候选", poolPath);
    const market = await candidateReader();
    const candidate = (("selected" in market ? market.selected : null) ?? null) as Candidate | null;
    const effective = candidate?.effective_usd_per_hour ?? null;
    if (!candidate || !candidate.server_id || effective === null || effective > batch.startIntent.maxEffectiveHourlyUsd || !/rtx\s*4090/i.test(candidate.gpu ?? "")) {
      const latest = readGenerationPool(poolPath).scheduler.manualBatch!;
      updateIntent(latest, { status: "blocked", lastError: "没有符合 RTX 4090 价格、显存和 On-Demand 条件的候选主机。" }, poolPath);
      updateManualGpuBatch({ status: "no_candidate" }, poolPath);
      writeStatus({ state: "blocked", batchId: batch.id, message: "没有符合价格要求的 RTX 4090" });
      return { action: "no_candidate" as const };
    }
    const latest = readGenerationPool(poolPath).scheduler.manualBatch!;
    updateIntent(latest, {
      status: "candidate_selected",
      selectedServerId: candidate.server_id,
      selectedEffectiveHourlyUsd: effective,
      selectedHost: candidate as Record<string, unknown>,
      lastError: null,
    }, poolPath);
    updateManualGpuBatch({ status: "order_pending" }, poolPath);
    writeStatus({ state: "candidate_selected", batchId: batch.id, message: `已选择合规 RTX 4090 候选 ${candidate.server_id}` });
    return { action: "candidate_selected" as const, candidate };
  }
  if (batch.startIntent.status === "candidate_selected" && !mutationsEnabled()) {
    writeStatus({ state: "blocked", batchId: batch.id, message: "真实下单开关未启用；已保留启动授权，未调用 Clore 下单接口。" });
    return { action: "mutation_disabled" as const };
  }
  if (batch.startIntent.status === "candidate_selected" && mutationsEnabled()) {
    // This branch is intentionally unreachable in tests unless all server-only
    // execution flags are set. The provider adapter performs its own live
    // candidate, wallet, active-order, lock, and ambiguous-create reconciliation.
    report(batch.id, "creating_order", "创建订单", poolPath);
    const market = await candidateReader();
    const candidate = ("selected" in market ? market.selected : null) as Candidate | null;
    if (!candidate?.server_id || !candidate.base_usd_per_hour) {
      const latest = readGenerationPool(poolPath).scheduler.manualBatch;
      if (latest?.startIntent) {
        updateIntent(latest, {
          status: "requested",
          selectedServerId: null,
          selectedEffectiveHourlyUsd: null,
          selectedHost: null,
          lastError: null,
        }, poolPath);
        updateManualGpuBatch({ status: "searching" }, poolPath);
        report(batch.id, "search_candidates", "候选已变化，重新搜索", poolPath);
      }
      return { action: "candidate_lost_research" as const };
    }
    if (isDeploymentHostBlacklisted(candidate.server_id)) {
      const latest = readGenerationPool(poolPath).scheduler.manualBatch;
      if (latest?.startIntent) {
        updateIntent(latest, {
          status: "requested",
          selectedServerId: null,
          selectedEffectiveHourlyUsd: null,
          selectedHost: null,
          lastError: null,
        }, poolPath);
        updateManualGpuBatch({ status: "searching" }, poolPath);
        report(batch.id, "search_candidates", "已跳过近期部署失败主机，重新搜索候选", poolPath);
      }
      return { action: "candidate_blacklisted" as const };
    }
    const latestCandidateState = readGenerationPool(poolPath).scheduler.manualBatch;
    if (latestCandidateState?.startIntent) {
      updateIntent(latestCandidateState, {
        selectedServerId: candidate.server_id,
        selectedEffectiveHourlyUsd: candidate.effective_usd_per_hour ?? null,
        selectedHost: candidate as Record<string, unknown>,
        lastError: null,
      }, poolPath);
      updateManualGpuBatch({ status: "order_pending" }, poolPath);
    }
    const { loadCloreExecutionConfig } = await import("./clore/execution-config");
    const { createCloreOrder, prepareCreateOrderFromLive } = await import("./clore/order-execution");
    report(batch.id, "creating_order", "恢复订单监控", poolPath);
    rearmWatchdogsBeforeCreate(candidate.server_id);
    const execution = loadCloreExecutionConfig();
    const config = { ...(await import("./clore/config")).loadCloreConfig(), targetGpu: "NVIDIA GeForce RTX 4090" as const, minGpuVramGb: 24, maxGpuPricePerHour: batch.startIntent.maxEffectiveHourlyUsd };
    const prepared = await prepareCreateOrderFromLive({
      config,
      execution,
      serverId: candidate.server_id,
      // This is deliberately the frozen user-entered ceiling, not a derived
      // marketplace or fee-adjusted number.
      maxPriceUsdPerHour: batch.startIntent.maxEffectiveHourlyUsd,
      queuedJobCount: batch.taskCount,
      orderProfile: "http_runtime",
    });
    const beforeCreate = readGenerationPool(poolPath).scheduler.manualBatch;
    if (beforeCreate?.startIntent) {
      updateIntent(beforeCreate, { orderPayload: sanitizedOrderPayload({ serverId: candidate.server_id, orderId: null, requiredPrice: prepared.requestBody.required_price ?? batch.startIntent.maxEffectiveHourlyUsd }) }, poolPath);
    }
    const created = await createCloreOrder({ config, execution, candidate: prepared.candidate, requestBody: prepared.requestBody });
    if (!created.order_created || !created.order_id) throw new Error("runner_order_not_created");
    const latest = readGenerationPool(poolPath).scheduler.manualBatch!;
    updateIntent(latest, {
      status: "order_created",
      orderCreatedAt: new Date().toISOString(),
      orderPayload: sanitizedOrderPayload({
        serverId: candidate.server_id,
        orderId: created.order_id,
        requiredPrice: prepared.requestBody.required_price ?? batch.startIntent.maxEffectiveHourlyUsd,
        deploymentState: created.status,
        createResponseStatus: created.create_response_status,
      }),
      lastError: null,
    }, poolPath);
    updateManualGpuBatch({ status: "provisioning", providerOrderId: created.order_id }, poolPath);
    writeStatus({ state: "order_created", batchId: batch.id, message: "租用成功，正在等待主机" });
    return resumeCreatedWanBatch({ batch: readGenerationPool(poolPath).scheduler.manualBatch!, orderId: created.order_id, poolPath });
  }
  if (batch.startIntent.status === "blocked") {
    writeStatus({ state: "blocked", batchId: batch.id, message: batch.startIntent.lastError ?? "没有可用候选主机" });
    return { action: "no_candidate" as const };
  }
  writeStatus({ state: "idle", batchId: batch.id, message: "批次已由 runner 接管" });
  return { action: "already_reconciled" as const };
}

export function runnerStatus() { return existsSync(STATUS_PATH) ? JSON.parse(readFileSync(STATUS_PATH, "utf8")) as RunnerStatus : null; }

async function main() {
  const action = process.argv[2] ?? "start";
  if (action === "status") { console.log(JSON.stringify(runnerStatus() ?? { state: "stopped" }, null, 2)); return; }
  if (action === "stop") {
    if (existsSync(PID_PATH)) {
      const pid = Number(readFileSync(PID_PATH, "utf8"));
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try { process.kill(pid, "SIGTERM"); } catch { /* A stale PID is safe to clear. */ }
      }
      rmSync(PID_PATH, { force: true });
    }
    writeStatus({ state: "idle", batchId: null, message: "已请求 runner 停止" });
    return;
  }
  if (action === "recover") { await runGpuSessionRunnerTick(); return; }
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(PID_PATH) && Number(readFileSync(PID_PATH, "utf8")) !== process.pid) { console.log("runner_already_recorded"); return; }
  writeFileSync(PID_PATH, String(process.pid), "utf8");
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try { await runGpuSessionRunnerTick(); }
    catch (error) { recordRunnerError(error); }
    finally { ticking = false; }
  };
  await tick();
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  const stop = () => { clearInterval(timer); clearRunnerPidIfOwned(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
if (process.argv[1]?.endsWith("gpu-session-runner.ts")) void main().catch((error) => { clearRunnerPidIfOwned(); console.error(error instanceof Error ? error.message : "gpu_session_runner_failed"); process.exitCode = 1; });
