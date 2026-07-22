import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { FLUX_IMAGE_STACK, classifyImageGpu, type ImageGpuClass, type ImageTaskSettings } from "@/lib/image-generation/flux-stack";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import { loadCloreConfig } from "../../../../../scripts/clore/config";
import { readLiveOrdersSummary } from "../../../../../scripts/clore/live";
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
    gpu: string;
    priceHourly: number;
    serverId: string;
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
  } | null;
  error: { stage: string; message: string; at: string; cancellationError?: string; billingRisk?: string } | null;
  blocker: string | null;
  pid?: number | null;
  logPath?: string | null;
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
  return readJson<ImageTask[]>(DATA_PATH, []);
}

function saveTasks(tasks: ImageTask[]) {
  writeJson(DATA_PATH, tasks);
}

function readPrice() {
  const value = Number(readJson<{ maxHourlyPrice?: unknown }>(PREFERENCES_PATH, {}).maxHourlyPrice);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_HOURLY_PRICE;
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

function readRunner() {
  const runner = { ...defaultRunner(), ...readJson<Partial<ImageRunnerSession>>(RUNNER_PATH, {}) } as ImageRunnerSession;
  if (terminalRunnerState(runner.state)) return { ...runner, blocker: readinessBlocker() };
  return runner;
}

function saveRunner(runner: ImageRunnerSession) {
  writeJson(RUNNER_PATH, { ...runner, updatedAt: new Date().toISOString() });
}

function terminalRunnerState(state: ImageRunnerSession["state"]) {
  return state === "idle" || state === "failed" || state === "completed";
}

function appendRunnerLog(kind: "stdout" | "stderr" | "event", text: string) {
  mkdirSync(DATA_DIR, { recursive: true });
  const lines = finalSanitizedLogLines(text, 50);
  if (!lines.length) return;
  appendFileSync(RUNNER_LOG_PATH, lines.map((line) => JSON.stringify({ at: new Date().toISOString(), stream: kind, line })).join("\n") + "\n", "utf8");
}

async function activeCloreOrderCount() {
  try {
    return (await readLiveOrdersSummary(loadCloreConfig(), { forceRefresh: true })).filter((order) => order.active).length;
  } catch {
    return null;
  }
}

async function reconcileStaleRunner(runner: ImageRunnerSession) {
  if (terminalRunnerState(runner.state) || processExists(runner.pid)) return runner;
  const activeOrders = await activeCloreOrderCount();
  if (activeOrders !== 0) return runner;
  const failed = {
    ...runner,
    state: "failed" as const,
    stage: "runner_exited",
    host: null,
    error: { stage: "runner_exited", message: STALE_RUNNER_NO_ORDER_MESSAGE, at: new Date().toISOString() },
    blocker: STALE_RUNNER_NO_ORDER_MESSAGE,
  };
  saveRunner(failed);
  return readRunner();
}

async function responsePayload() {
  const blocker = readinessBlocker();
  const runner = await reconcileStaleRunner(readRunner());
  return {
    tasks: readTasks(),
    runner: terminalRunnerState(runner.state) ? { ...runner, blocker } : runner,
    executionReady: blocker === null,
    maxHourlyPrice: readPrice(),
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
    if (action === "create") {
      const task = taskFrom(body);
      tasks = [task, ...tasks];
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
      const ids = Array.isArray(body.taskIds) ? [...new Set(body.taskIds.map(String))] : [];
      const maxHourlyPrice = Number(body.maxHourlyPrice);
      const batch = tasks.filter((task) => ids.includes(task.id) && task.status === "waiting_for_gpu");
      assertStartableBatch(batch, maxHourlyPrice);
      const previous = await reconcileStaleRunner(readRunner());
      if (previous.state === "running" || previous.state === "cancelling") throw new Error("已有图像批次正在运行");
      const startedAt = new Date().toISOString();
      writeJson(PREFERENCES_PATH, { maxHourlyPrice });
      saveRunner({
        ...previous,
        state: "running",
        stage: "正在寻找显卡",
        frozenTaskIds: batch.map((task) => task.id),
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
      error: { stage: "开始批次", message, at: new Date().toISOString() },
    });
    return NextResponse.json({ error: message, ...(await responsePayload()) }, { status: 400 });
  }
}
