import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getLocalLabCloreCandidates } from "../src/lib/local-lab/clore-console";
import { GENERATION_POOL_PATH, readGenerationPool, updateManualGpuBatch, type ManualGpuExecutionBatch, type ManualGpuRunnerStage } from "../src/lib/generation/task-pool";
import { runManualSilent4090Batch } from "../src/lib/generation/manual-gpu-batch-runner";
import { getGpuProvider } from "./gpu-providers";
import type { GpuTarget } from "./gpu-providers/types";
import { createRealWanTransport } from "./wan-real-transport";

const STATE_DIR = path.join(process.cwd(), ".secrets", "gpu-session-runner");
const PID_PATH = path.join(STATE_DIR, "runner.pid");
const STATUS_PATH = path.join(STATE_DIR, "status.json");
const INTERVAL_MS = 3_000;

type RunnerStatus = { pid: number; updatedAt: string; state: "idle" | "searching" | "candidate_selected" | "blocked" | "order_created" | "error"; batchId: string | null; message: string };
type Candidate = { server_id: string; base_usd_per_hour?: number | null; effective_usd_per_hour?: number | null; gpu?: string | null };
type CandidateReader = () => Promise<{ selected?: Candidate | null } | Record<string, unknown>>;
type WanSession = { ensureRestored(): Promise<unknown>; run(task: { id: string; prompt: string; seed?: number }): Promise<{ generated: { outputPath: string; thumbnailPath: string } }>; stop(): Promise<void> };

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
  report(input.batch.id, "waiting_deployment", "等待部署", input.poolPath);
  const provider = getGpuProvider("clore");
  const session = await provider.recoverExistingSession(input.orderId);
  if (!session) throw new Error("runner_created_order_not_recoverable");
  const target = await provider.waitForSsh(session, 10 * 60_000);
  try {
    report(input.batch.id, "checking_host", "检查主机", input.poolPath);
    report(input.batch.id, "pulling_runtime", "拉取运行环境", input.poolPath);
    const completed = await executeFrozenWanBatch({ target, poolPath: input.poolPath, onStage: (stage, message, taskNumber) => report(input.batch.id, stage, message, input.poolPath, null, taskNumber ?? null) });
    report(input.batch.id, "terminating", "退租", input.poolPath);
    await provider.terminateSession(session);
    report(input.batch.id, "completed", "批次已完成", input.poolPath);
    return { action: "batch_completed" as const, orderId: input.orderId, completed };
  } catch (error) {
    const message = error instanceof Error ? error.message : "runner_session_failed";
    if (/ssh_tcp_not_ready|order_not_deployed|deployment/i.test(message)) {
      report(input.batch.id, "waiting_deployment", "Clore 仍在部署，SSH 尚未开放", input.poolPath, null);
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
    if (!candidate?.server_id || !candidate.base_usd_per_hour) throw new Error("runner_candidate_lost_before_create");
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
    const execution = loadCloreExecutionConfig();
    const config = { ...(await import("./clore/config")).loadCloreConfig(), targetGpu: "NVIDIA GeForce RTX 4090" as const, minGpuVramGb: 24, maxGpuPricePerHour: batch.startIntent.maxEffectiveHourlyUsd / 1.05 };
    const prepared = await prepareCreateOrderFromLive({ config, execution, serverId: candidate.server_id, maxPriceUsdPerHour: candidate.base_usd_per_hour, queuedJobCount: batch.taskCount });
    const created = await createCloreOrder({ config, execution, candidate: prepared.candidate, requestBody: prepared.requestBody });
    if (!created.order_created || !created.order_id) throw new Error("runner_order_not_created");
    const latest = readGenerationPool(poolPath).scheduler.manualBatch!;
    updateIntent(latest, { status: "order_created", lastError: null }, poolPath);
    updateManualGpuBatch({ status: "provisioning", providerOrderId: created.order_id }, poolPath);
    writeStatus({ state: "order_created", batchId: batch.id, message: "租用成功，正在等待主机" });
    return resumeCreatedWanBatch({ batch: readGenerationPool(poolPath).scheduler.manualBatch!, orderId: created.order_id, poolPath });
  }
  writeStatus({ state: "idle", batchId: batch.id, message: "批次已由 runner 接管" });
  return { action: "already_reconciled" as const };
}

export function runnerStatus() { return existsSync(STATUS_PATH) ? JSON.parse(readFileSync(STATUS_PATH, "utf8")) as RunnerStatus : null; }

async function main() {
  const action = process.argv[2] ?? "start";
  if (action === "status") { console.log(JSON.stringify(runnerStatus() ?? { state: "stopped" }, null, 2)); return; }
  if (action === "stop") { if (existsSync(PID_PATH)) rmSync(PID_PATH, { force: true }); writeStatus({ state: "idle", batchId: null, message: "已请求 runner 停止" }); return; }
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
