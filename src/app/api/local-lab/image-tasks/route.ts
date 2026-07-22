import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { FLUX_IMAGE_STACK, classifyImageGpu, type ImageGpuClass, type ImageTaskSettings } from "@/lib/image-generation/flux-stack";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";

export const dynamic = "force-dynamic";

type ImageTask = ImageTaskSettings & {
  id: string; seed: number; mode: "text_generation" | "kontext_edit"; referenceImage: string | null;
  gpuClass: ImageGpuClass; badge: "低" | "高"; modelStack: typeof FLUX_IMAGE_STACK;
  status: "pending_confirmation" | "waiting_for_gpu" | "generating" | "completed" | "failed";
  createdAt: string; updatedAt: string; attempts: number;
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
  host: { gpu: string; priceHourly: number; serverId: string; orderId: string | null; vram: string | null; cpu: string | null; ram: string | null; disk: string | null; network: string | null; location: string | null; runtimeDigest: string | null; httpState: string | null; sshDiagnostic: string | null } | null;
  error: { stage: string; message: string; at: string } | null;
  blocker: string | null;
};

const DATA_DIR = path.join(process.cwd(), ".secrets", "image-studio");
const DATA_PATH = path.join(DATA_DIR, "tasks.json");
const RUNNER_PATH = path.join(DATA_DIR, "runner-session.json");
const PREFERENCES_PATH = path.join(DATA_DIR, "preferences.json");
const EXECUTOR_BLOCKER = "图像执行器尚未就绪：已发布 Runtime 仍继承 Wan 层，且 FLUX/Kontext 的可校验恢复清单与工作流尚未完成。不会创建付费订单。";

function readJson<T>(filePath: string, fallback: T): T {
  try { return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) as T : fallback; } catch { return fallback; }
}
function writeJson(filePath: string, value: unknown) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8"); }
function readTasks() { return readJson<ImageTask[]>(DATA_PATH, []); }
function saveTasks(tasks: ImageTask[]) { writeJson(DATA_PATH, tasks); }
function readPrice() { const value = Number(readJson<{ maxHourlyPrice?: unknown }>(PREFERENCES_PATH, {}).maxHourlyPrice); return Number.isFinite(value) && value > 0 ? value : 0.6; }
function defaultRunner(): ImageRunnerSession {
  return { state: "idle", stage: "当前未租用显卡", frozenTaskIds: [], gpuClass: null, maxHourlyPrice: readPrice(), currentTaskIndex: null, currentModel: null, promptSummary: null, startedAt: null, updatedAt: new Date().toISOString(), host: null, error: null, blocker: EXECUTOR_BLOCKER };
}
function readRunner() { return { ...defaultRunner(), ...readJson<Partial<ImageRunnerSession>>(RUNNER_PATH, {}) } as ImageRunnerSession; }
function saveRunner(runner: ImageRunnerSession) { writeJson(RUNNER_PATH, { ...runner, updatedAt: new Date().toISOString() }); }
function responsePayload() { return { tasks: readTasks(), runner: readRunner(), executionReady: false, maxHourlyPrice: readPrice() }; }
function imageDimension(value: unknown) { const dimension = Number(value); return Number.isInteger(dimension) && dimension >= 768 && dimension <= 2048 && dimension % 256 === 0 ? dimension : null; }

function taskFrom(input: Record<string, unknown>): ImageTask {
  const prompt = String(input.prompt ?? "").trim(); const width = imageDimension(input.width); const height = imageDimension(input.height);
  const steps = Number(input.steps); const loraStrength = Number(input.loraStrength); const cfg = Number(input.cfg); const sampler = String(input.sampler);
  const seed = Number.isInteger(Number(input.seed)) ? Number(input.seed) : Math.floor(Math.random() * 2_147_483_647);
  if (!prompt || prompt.length > 4000 || !width || !height || !Number.isInteger(steps) || steps < 25 || steps > 40 || loraStrength < 0.6 || loraStrength > 1.1 || cfg < 3.5 || cfg > 5 || (sampler !== "Euler" && sampler !== "FlowMatch")) throw new Error("invalid_image_task");
  const referenceImage = typeof input.referenceImage === "string" && input.referenceImage.startsWith("data:image/") && input.referenceImage.length <= 6_000_000 ? input.referenceImage : null;
  const gpuClass = classifyImageGpu(width, height); const now = new Date().toISOString();
  return { id: randomUUID(), seed, mode: referenceImage ? "kontext_edit" : "text_generation", prompt, referenceImage, steps, loraStrength, cfg, sampler: sampler as ImageTaskSettings["sampler"], width, height, gpuClass, badge: gpuClass === "rtx4090" ? "低" : "高", modelStack: FLUX_IMAGE_STACK, status: "pending_confirmation", createdAt: now, updatedAt: now, attempts: 0 };
}

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request); return guard ?? NextResponse.json(responsePayload(), { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request); if (guard) return guard;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>; const action = String(body.action ?? "create"); let tasks = readTasks();
  try {
    if (action === "create") { const task = taskFrom(body); tasks = [task, ...tasks]; saveTasks(tasks); return NextResponse.json({ task, ...responsePayload() }); }
    if (action === "set_price") {
      const maxHourlyPrice = Number(body.maxHourlyPrice); if (!Number.isFinite(maxHourlyPrice) || maxHourlyPrice <= 0 || maxHourlyPrice > 100) throw new Error("invalid_max_hourly_price");
      writeJson(PREFERENCES_PATH, { maxHourlyPrice }); const runner = readRunner(); if (runner.state === "idle") saveRunner({ ...runner, maxHourlyPrice }); return NextResponse.json(responsePayload());
    }
    if (action === "start_batch") {
      const ids = Array.isArray(body.taskIds) ? [...new Set(body.taskIds.map(String))] : []; const maxHourlyPrice = Number(body.maxHourlyPrice);
      const batch = tasks.filter((task) => ids.includes(task.id) && task.status === "waiting_for_gpu"); const classes = [...new Set(batch.map((task) => task.gpuClass))];
      if (!batch.length) throw new Error("no_confirmed_image_tasks_selected"); if (classes.length !== 1) throw new Error("mixed_gpu_classes_are_not_allowed");
      if (!Number.isFinite(maxHourlyPrice) || maxHourlyPrice <= 0) throw new Error("invalid_max_hourly_price");
      writeJson(PREFERENCES_PATH, { maxHourlyPrice });
      // This remains a hard server-side guard until the HTTP executor and model manifests are genuinely complete.
      throw new Error("image_executor_not_ready");
    }
    const id = String(body.id ?? ""); if (!tasks.some((task) => task.id === id)) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
    const updatedAt = new Date().toISOString();
    if (action === "delete") tasks = tasks.filter((task) => task.id !== id);
    else if (action === "confirm") tasks = tasks.map((task) => task.id === id ? { ...task, status: "waiting_for_gpu", updatedAt } : task);
    else if (action === "retry") tasks = tasks.map((task) => task.id === id ? { ...task, status: "pending_confirmation", attempts: task.attempts + 1, updatedAt } : task);
    else return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    saveTasks(tasks); return NextResponse.json(responsePayload());
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "image_task_failed", ...responsePayload() }, { status: 400 }); }
}
