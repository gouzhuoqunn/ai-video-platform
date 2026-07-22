import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { FLUX_IMAGE_STACK, classifyImageGpu, type ImageGpuClass, type ImageTaskSettings } from "@/lib/image-generation/flux-stack";
import { finiteNumber } from "@/lib/image-generation/formatters";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import { COMFY_RUNTIME_IMAGE, loadCloreConfig } from "../../../../../scripts/clore/config";
import { cloreRequest } from "../../../../../scripts/clore/client";
import { loadCloreExecutionConfig } from "../../../../../scripts/clore/execution-config";
import { readLiveOrdersSummary, type CloreOrderSummary } from "../../../../../scripts/clore/live";
import { ACTIVE_ORDER_PATH, clearActiveOrder, readActiveOrder } from "../../../../../scripts/clore/order-state";
import { finalSanitizedLogLines, imageExecutorReadiness, processExists, STALE_RUNNER_NO_ORDER_MESSAGE } from "../../../../../scripts/image-executor/readiness";

export const dynamic = "force-dynamic";

type PersistedImageResult = {
  imagePath: string;
  thumbnailPath: string;
  sha256: string;
  width: number;
  height: number;
  metadataPath: string;
  persistedAt: string;
};

type ImageTask = ImageTaskSettings & {
  id: string;
  seed: number;
  mode: "text_generation" | "kontext_edit";
  referenceImage: string | null;
  gpuClass: ImageGpuClass;
  badge: "低" | "高";
  modelStack: typeof FLUX_IMAGE_STACK;
  status: "pending_confirmation" | "waiting_for_gpu" | "generating" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  attempts: number;
  result?: PersistedImageResult;
};

export type ImageRunnerSession = {
  state: "idle" | "running" | "failed" | "completed" | "cancelling";
  stage: string;
  frozenTaskIds: string[];
  gpuClass: ImageGpuClass | null;
  maxHourlyPrice: number;
  currentTaskIndex: number | null;
  currentModel: string | null;
  promptSummary: string | null;
  startedAt: string | null;
  updatedAt: string;
  host: {
    gpu: string | null;
    priceHourly: number | null;
    serverId: string | null;
    orderId: string | null;
    vram: string | null;
    cpu: string | null;
    ram: string | null;
    disk: string | null;
    network: string | null;
    location: string | null;
    runtimeDigest: string | null;
    httpState: string | null;
    sshDiagnostic: string | null;
    orderStatus?: string | null;
    deploymentState?: string | null;
    clorePorts?: string[] | null;
    cloreHttpUrls?: string[] | null;
    controllerUrl?: string | null;
    httpExternalPort?: number | null;
    lastHealthStatus?: number | null;
    lastHealthError?: string | null;
    readinessElapsedSeconds?: number | null;
    lastPollAt?: string | null;
    message?: string | null;
  } | null;
  error: { stage: string; message: string; at: string; cancellationError?: string; billingRisk?: string } | null;
  blocker: string | null;
  pid?: number | null;
  logPath?: string | null;
  lastCancellation?: { at: string; orderId: string | null; message: string };
};

const DATA_DIR = path.join(process.cwd(), ".secrets", "image-studio");
const DATA_PATH = path.join(DATA_DIR, "tasks.json");
const RUNNER_PATH = path.join(DATA_DIR, "runner-session.json");
const RUNNER_LOG_PATH = path.join(DATA_DIR, "image-runner.log");
const PREFERENCES_PATH = path.join(DATA_DIR, "preferences.json");
const RESTORE_MANIFEST_PATH = path.join(DATA_DIR, "fluxed-up-10.2-rtx4090-text.restore.json");
const SOURCE_MANIFEST_PATH = path.join(process.cwd(), "comfy-runtime", "image-source-artifacts.json");
const DEFAULT_MAX_HOURLY_PRICE = 0.6;
const KONTEXT_BLOCKER = "FLUX Kontext 执行器尚未完成";
const RTX5090_BLOCKER = "RTX 5090 高分辨率执行器尚未完成";
const DUPLICATE_START_MESSAGE = "已有图像批次正在启动或执行，请先等待或退租。";

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return existsSync(filePath) ? (JSON.parse(readFileSync(filePath, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readTasks() {
  return readJson<ImageTask[]>(DATA_PATH, []).filter((task, index, all) => task?.id && all.findIndex((candidate) => candidate.id === task.id) === index);
}

function saveTasks(tasks: ImageTask[]) {
  writeJson(DATA_PATH, tasks.filter((task, index, all) => task?.id && all.findIndex((candidate) => candidate.id === task.id) === index));
}

function readPrice() {
  const value = finiteNumber(readJson<{ maxHourlyPrice?: unknown }>(PREFERENCES_PATH, {}).maxHourlyPrice);
  return value !== null && value > 0 ? value : DEFAULT_MAX_HOURLY_PRICE;
}

function readinessBlocker() {
  const readiness = imageExecutorReadiness({ restoreManifestPath: RESTORE_MANIFEST_PATH, sourceManifestPath: SOURCE_MANIFEST_PATH });
  return readiness.ready ? null : readiness.blocker;
}

function defaultRunner(): ImageRunnerSession {
  return {
    state: "idle",
    stage: "当前未租用显卡",
    frozenTaskIds: [],
    gpuClass: null,
    maxHourlyPrice: readPrice(),
    currentTaskIndex: null,
    currentModel: null,
    promptSummary: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    host: null,
    error: null,
    blocker: readinessBlocker(),
    pid: null,
    logPath: null,
  };
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArrayOrNull(value: unknown) {
  if (!Array.isArray(value)) return null;
  const values = [...new Set(value.map(String).filter(Boolean))];
  return values.length ? values : null;
}

function normalizeHost(value: unknown): ImageRunnerSession["host"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const host = value as Record<string, unknown>;
  return {
    gpu: stringOrNull(host.gpu),
    priceHourly: finiteNumber(host.priceHourly),
    serverId: stringOrNull(host.serverId),
    orderId: stringOrNull(host.orderId),
    vram: stringOrNull(host.vram),
    cpu: stringOrNull(host.cpu),
    ram: stringOrNull(host.ram),
    disk: stringOrNull(host.disk),
    network: stringOrNull(host.network),
    location: stringOrNull(host.location),
    runtimeDigest: stringOrNull(host.runtimeDigest),
    httpState: stringOrNull(host.httpState),
    sshDiagnostic: stringOrNull(host.sshDiagnostic),
    orderStatus: stringOrNull(host.orderStatus),
    deploymentState: stringOrNull(host.deploymentState),
    clorePorts: stringArrayOrNull(host.clorePorts),
    cloreHttpUrls: stringArrayOrNull(host.cloreHttpUrls),
    controllerUrl: stringOrNull(host.controllerUrl),
    httpExternalPort: finiteNumber(host.httpExternalPort),
    lastHealthStatus: finiteNumber(host.lastHealthStatus),
    lastHealthError: stringOrNull(host.lastHealthError),
    readinessElapsedSeconds: finiteNumber(host.readinessElapsedSeconds),
    lastPollAt: stringOrNull(host.lastPollAt),
    message: stringOrNull(host.message),
  };
}

function normalizeRunner(input: Partial<ImageRunnerSession>): ImageRunnerSession {
  const fallback = defaultRunner();
  const state = ["idle", "running", "failed", "completed", "cancelling"].includes(String(input.state)) ? input.state! : fallback.state;
  const maxHourly = finiteNumber(input.maxHourlyPrice);
  return {
    ...fallback,
    ...input,
    state,
    stage: stringOrNull(input.stage) ?? fallback.stage,
    frozenTaskIds: [...new Set(Array.isArray(input.frozenTaskIds) ? input.frozenTaskIds.map(String).filter(Boolean) : [])],
    gpuClass: input.gpuClass === "rtx4090" || input.gpuClass === "rtx5090" ? input.gpuClass : null,
    maxHourlyPrice: maxHourly !== null && maxHourly > 0 ? maxHourly : readPrice(),
    currentTaskIndex: Number.isInteger(input.currentTaskIndex) ? input.currentTaskIndex! : null,
    currentModel: stringOrNull(input.currentModel),
    promptSummary: stringOrNull(input.promptSummary),
    startedAt: stringOrNull(input.startedAt),
    updatedAt: stringOrNull(input.updatedAt) ?? new Date().toISOString(),
    host: normalizeHost(input.host),
    error: input.error ?? null,
    blocker: input.blocker ?? null,
    pid: Number.isInteger(input.pid) ? input.pid : null,
    logPath: stringOrNull(input.logPath),
  };
}

function terminalRunnerState(state: ImageRunnerSession["state"]) {
  return state === "idle" || state === "failed" || state === "completed";
}

function readRunner() {
  const runner = normalizeRunner(readJson<Partial<ImageRunnerSession>>(RUNNER_PATH, {}));
  if (terminalRunnerState(runner.state)) return { ...runner, blocker: readinessBlocker() };
  return runner;
}

function saveRunner(runner: ImageRunnerSession) {
  writeJson(RUNNER_PATH, { ...normalizeRunner(runner), updatedAt: new Date().toISOString() });
}

function appendRunnerLog(kind: "stdout" | "stderr" | "event", text: string) {
  mkdirSync(DATA_DIR, { recursive: true });
  const lines = finalSanitizedLogLines(text, 50);
  if (!lines.length) return;
  appendFileSync(RUNNER_LOG_PATH, lines.map((line) => JSON.stringify({ at: new Date().toISOString(), stream: kind, line })).join("\n") + "\n", "utf8");
}

async function activeCloreOrders() {
  return (await readLiveOrdersSummary(loadCloreConfig(), { forceRefresh: true })).filter((order) => order.active);
}

async function activeCloreOrderCount() {
  try {
    return (await activeCloreOrders()).length;
  } catch {
    return null;
  }
}

async function reconcileStaleRunner(runner: ImageRunnerSession) {
  if (terminalRunnerState(runner.state) || processExists(runner.pid)) return runner;
  const activeOrders = await activeCloreOrders().catch(() => null);
  if (activeOrders === null) return runner;
  const activeImageOrder = matchingImageOrder(runner, activeOrders);
  if (activeImageOrder?.orderId) {
    const failedWithOrder = {
      ...runner,
      state: "failed" as const,
      stage: "runner_exited_order_active",
      pid: null,
      host: normalizeHost({
        ...(runner.host ?? {}),
        orderId: activeImageOrder.orderId,
        serverId: activeImageOrder.serverId ?? runner.host?.serverId ?? null,
        orderStatus: activeImageOrder.status,
        deploymentState: activeImageOrder.deploymentState ?? null,
        controllerUrl: activeImageOrder.controllerUrl ?? null,
        message: "图像 runner 已退出，但订单仍活跃",
      }),
      error: {
        stage: "runner_exited_order_active",
        message: `图像 runner 已退出，但 Clore 图像订单 ${activeImageOrder.orderId} 仍活跃，请点击“停止并退租 / 取消本批次”。`,
        at: new Date().toISOString(),
        billingRisk: "订单可能仍在计费",
      },
      blocker: "image_runner_exited_with_active_order",
    };
    saveRunner(failedWithOrder);
    return readRunner();
  }
  if (activeStateLooksImageOrder()) {
    try {
      clearActiveOrder(activeStateLooksImageOrder()!.order_id);
    } catch {
      rmSync(ACTIVE_ORDER_PATH, { force: true });
    }
  }
  const failed = {
    ...runner,
    state: "failed" as const,
    stage: "runner_exited",
    host: null,
    frozenTaskIds: [],
    gpuClass: null,
    currentTaskIndex: null,
    currentModel: null,
    promptSummary: null,
    pid: null,
    error: { stage: "runner_exited", message: STALE_RUNNER_NO_ORDER_MESSAGE, at: new Date().toISOString() },
    blocker: STALE_RUNNER_NO_ORDER_MESSAGE,
  };
  saveRunner(failed);
  return readRunner();
}

async function responsePayload(extra: Record<string, unknown> = {}) {
  const blocker = readinessBlocker();
  const runner = await reconcileStaleRunner(readRunner());
  return {
    tasks: readTasks(),
    runner: terminalRunnerState(runner.state) ? { ...runner, blocker } : runner,
    executionReady: blocker === null,
    maxHourlyPrice: readPrice(),
    ...extra,
  };
}

function imageDimension(value: unknown) {
  const dimension = Number(value);
  return Number.isInteger(dimension) && dimension >= 768 && dimension <= 2048 && dimension % 256 === 0 ? dimension : null;
}

function taskFrom(input: Record<string, unknown>): ImageTask {
  const prompt = String(input.prompt ?? "").trim();
  const width = imageDimension(input.width);
  const height = imageDimension(input.height);
  const steps = Number(input.steps);
  const loraStrength = Number(input.loraStrength);
  const cfg = Number(input.cfg);
  const sampler = String(input.sampler);
  const seed = Number.isInteger(Number(input.seed)) ? Number(input.seed) : Math.floor(Math.random() * 2_147_483_647);
  if (
    !prompt ||
    prompt.length > 4000 ||
    !width ||
    !height ||
    !Number.isInteger(steps) ||
    steps < 25 ||
    steps > 40 ||
    loraStrength < 0.6 ||
    loraStrength > 1.1 ||
    cfg < 3.5 ||
    cfg > 5 ||
    (sampler !== "Euler" && sampler !== "FlowMatch")
  ) {
    throw new Error("invalid_image_task");
  }
  const referenceImage = typeof input.referenceImage === "string" && input.referenceImage.startsWith("data:image/") && input.referenceImage.length <= 6_000_000 ? input.referenceImage : null;
  const gpuClass = classifyImageGpu(width, height);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    seed,
    mode: referenceImage ? "kontext_edit" : "text_generation",
    prompt,
    referenceImage,
    steps,
    loraStrength,
    cfg,
    sampler: sampler as ImageTaskSettings["sampler"],
    width,
    height,
    gpuClass,
    badge: gpuClass === "rtx4090" ? "低" : "高",
    modelStack: FLUX_IMAGE_STACK,
    status: "pending_confirmation",
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
}

function assertStartableBatch(batch: ImageTask[], maxHourlyPrice: number) {
  const classes = [...new Set(batch.map((task) => task.gpuClass))];
  const blocker = readinessBlocker();
  if (blocker) throw new Error(blocker);
  if (!batch.length) throw new Error("no_confirmed_image_tasks_selected");
  if (classes.length !== 1) throw new Error("mixed_gpu_classes_are_not_allowed");
  if (!Number.isFinite(maxHourlyPrice) || maxHourlyPrice <= 0) throw new Error("invalid_max_hourly_price");
  if (classes[0] === "rtx5090") throw new Error(RTX5090_BLOCKER);
  if (batch.some((task) => task.mode !== "text_generation" || task.referenceImage || task.width > 1280 || task.height > 1280 || !task.prompt.trim())) {
    throw new Error(KONTEXT_BLOCKER);
  }
}

function activeStateLooksImageOrder() {
  const active = readActiveOrder();
  if (!active) return null;
  const imageRuntime = active.bootstrap_image === COMFY_RUNTIME_IMAGE;
  const imagePort = Array.isArray(active.open_ports) && active.open_ports.map(String).includes("controller/http:8080");
  const imageGpu = active.gpu_profile === "rtx4090" || /4090/.test(active.gpu_type ?? "");
  return imageRuntime || imagePort || imageGpu ? active : null;
}

function matchingImageOrder(runner: ImageRunnerSession, orders: CloreOrderSummary[]) {
  const active = orders.filter((order) => order.active && order.orderId);
  const activeState = activeStateLooksImageOrder();
  if (activeState) {
    const byId = active.find((order) => order.orderId === activeState.order_id);
    if (byId) return byId;
    const byServer = active.find((order) => order.serverId === activeState.server_id);
    if (byServer) return byServer;
  }
  if (runner.gpuClass !== "rtx4090" || !runner.frozenTaskIds.length) return null;
  if (runner.host?.orderId) return active.find((order) => order.orderId === runner.host?.orderId) ?? null;
  if (runner.host?.serverId) {
    const matches = active.filter((order) => order.serverId === runner.host?.serverId);
    return matches.length === 1 ? matches[0] : null;
  }
  return null;
}

function resetRunnerAfterCancel(message: string, orderId: string | null) {
  const now = new Date().toISOString();
  saveRunner({
    ...defaultRunner(),
    state: "idle",
    stage: "当前未租用显卡",
    frozenTaskIds: [],
    gpuClass: null,
    currentTaskIndex: null,
    currentModel: null,
    promptSummary: null,
    startedAt: null,
    host: null,
    error: null,
    blocker: readinessBlocker(),
    pid: null,
    logPath: null,
    lastCancellation: { at: now, orderId, message },
    updatedAt: now,
  });
}

async function cancelCurrentImageBatch() {
  const runner = readRunner();
  if (processExists(runner.pid)) {
    try {
      process.kill(Number(runner.pid), "SIGTERM");
    } catch {
      // Cancellation does not depend on the process signal.
    }
  }
  const orders = await activeCloreOrders();
  const order = matchingImageOrder(runner, orders);
  if (!order?.orderId) {
    const activeState = activeStateLooksImageOrder();
    if (activeState && existsSync(ACTIVE_ORDER_PATH)) {
      try {
        clearActiveOrder(activeState.order_id);
      } catch {
        rmSync(ACTIVE_ORDER_PATH, { force: true });
      }
    }
    const message = "没有活跃图像订单，已清理本地批次状态。";
    resetRunnerAfterCancel(message, null);
    return { orderId: null, cancelled: false, message };
  }
  const execution = loadCloreExecutionConfig();
  if (!execution.enabled) throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false，无法执行真实退租。");
  await cloreRequest<unknown>(loadCloreConfig(), "/cancel_order", {
    method: "POST",
    body: JSON.stringify({ id: order.orderId, issue: "image_session_cancel" }),
  });
  const activeAfter = await activeCloreOrders();
  if (activeAfter.some((candidate) => candidate.orderId === order.orderId)) throw new Error(`退租后订单仍活跃：${order.orderId}`);
  const activeState = activeStateLooksImageOrder();
  if (activeState?.order_id === order.orderId && existsSync(ACTIVE_ORDER_PATH)) {
    try {
      clearActiveOrder(order.orderId);
    } catch {
      rmSync(ACTIVE_ORDER_PATH, { force: true });
    }
  }
  const message = `已退租图像订单 ${order.orderId}。`;
  resetRunnerAfterCancel(message, order.orderId);
  return { orderId: order.orderId, cancelled: true, message };
}

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  return guard ?? NextResponse.json(await responsePayload(), { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "create");
  let tasks = readTasks();
  try {
    if (action === "cancel_batch") {
      const cancellation = await cancelCurrentImageBatch();
      return NextResponse.json(await responsePayload({ cancellation }));
    }

    if (action === "create") {
      const task = taskFrom(body);
      tasks = [task, ...tasks.filter((candidate) => candidate.id !== task.id)];
      saveTasks(tasks);
      return NextResponse.json({ task, ...(await responsePayload()) });
    }

    if (action === "set_price") {
      const maxHourlyPrice = Number(body.maxHourlyPrice);
      if (!Number.isFinite(maxHourlyPrice) || maxHourlyPrice <= 0 || maxHourlyPrice > 100) throw new Error("invalid_max_hourly_price");
      writeJson(PREFERENCES_PATH, { maxHourlyPrice });
      const runner = readRunner();
      if (runner.state === "idle") saveRunner({ ...runner, maxHourlyPrice });
      return NextResponse.json(await responsePayload());
    }

    if (action === "start_batch") {
      const ids = [...new Set(Array.isArray(body.taskIds) ? body.taskIds.map(String).filter(Boolean) : [])];
      const maxHourlyPrice = Number(body.maxHourlyPrice);
      const previous = await reconcileStaleRunner(readRunner());
      if (previous.state === "running" || previous.state === "cancelling" || processExists(previous.pid)) throw new Error(DUPLICATE_START_MESSAGE);
      if ((await activeCloreOrderCount()) !== 0) throw new Error(DUPLICATE_START_MESSAGE);
      const batch = tasks.filter((task) => ids.includes(task.id) && task.status === "waiting_for_gpu");
      assertStartableBatch(batch, maxHourlyPrice);
      const startedAt = new Date().toISOString();
      writeJson(PREFERENCES_PATH, { maxHourlyPrice });
      saveRunner({
        ...previous,
        state: "running",
        stage: "正在寻找显卡",
        frozenTaskIds: [...new Set(batch.map((task) => task.id))],
        gpuClass: "rtx4090",
        maxHourlyPrice,
        currentTaskIndex: null,
        currentModel: null,
        promptSummary: null,
        startedAt,
        host: null,
        error: null,
        blocker: null,
        pid: null,
        logPath: RUNNER_LOG_PATH,
        updatedAt: startedAt,
      });
      const child = spawn(process.execPath, [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), path.join(process.cwd(), "scripts", "image-4090-runner.ts")], {
        cwd: process.cwd(),
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      saveRunner({ ...readRunner(), pid: child.pid ?? null, startedAt, logPath: RUNNER_LOG_PATH });
      child.stdout?.on("data", (chunk) => appendRunnerLog("stdout", String(chunk)));
      child.stderr?.on("data", (chunk) => appendRunnerLog("stderr", String(chunk)));
      child.on("error", (error) => {
        appendRunnerLog("event", `child_error:${error.message}`);
        const current = readRunner();
        if (!terminalRunnerState(current.state)) {
          saveRunner({
            ...current,
            state: "failed",
            stage: "runner_exited",
            host: null,
            error: { stage: "runner_exited", message: `image runner failed to start: ${error.message}`, at: new Date().toISOString() },
            blocker: "image_runner_start_failed",
          });
        }
      });
      child.on("exit", (code, signal) => {
        appendRunnerLog("event", `child_exit code=${code ?? "null"} signal=${signal ?? "null"}`);
        const current = readRunner();
        if (!terminalRunnerState(current.state) && current.pid === child.pid) {
          const stderr = existsSync(RUNNER_LOG_PATH) ? finalSanitizedLogLines(readFileSync(RUNNER_LOG_PATH, "utf8"), 8).join("\n") : "";
          saveRunner({
            ...current,
            state: "failed",
            stage: "runner_exited",
            host: null,
            error: {
              stage: "runner_exited",
              message: `image runner exited before completion: code=${code ?? "null"} signal=${signal ?? "null"}${stderr ? `\n${stderr}` : ""}`,
              at: new Date().toISOString(),
            },
            blocker: "image_runner_exited_nonzero",
          });
        }
      });
      return NextResponse.json(await responsePayload());
    }

    const id = String(body.id ?? "");
    if (!tasks.some((task) => task.id === id)) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
    const updatedAt = new Date().toISOString();
    if (action === "delete") tasks = tasks.filter((task) => task.id !== id);
    else if (action === "confirm") tasks = tasks.map((task) => (task.id === id ? { ...task, status: "waiting_for_gpu", updatedAt } : task));
    else if (action === "retry") tasks = tasks.map((task) => (task.id === id ? { ...task, status: "pending_confirmation", attempts: task.attempts + 1, updatedAt } : task));
    else return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    saveTasks(tasks);
    return NextResponse.json(await responsePayload());
  } catch (error) {
    const message = error instanceof Error ? error.message : "image_task_failed";
    const runner = readRunner();
    saveRunner({
      ...runner,
      state: "failed",
      stage: "执行失败",
      error: { stage: action === "cancel_batch" ? "退租" : "开始批次", message, at: new Date().toISOString() },
    });
    return NextResponse.json({ error: message, ...(await responsePayload()) }, { status: 400 });
  }
}
