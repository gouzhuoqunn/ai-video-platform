import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import {
  FLUX_IMAGE_STACK,
  classifyImageGpu,
  type ImageGpuClass,
  type ImageTaskSettings,
} from "@/lib/image-generation/flux-stack";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";

export const dynamic = "force-dynamic";

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
};

const DATA_PATH = path.join(process.cwd(), ".secrets", "image-studio", "tasks.json");

function readTasks(): ImageTask[] {
  return existsSync(DATA_PATH) ? (JSON.parse(readFileSync(DATA_PATH, "utf8")) as ImageTask[]) : [];
}

function saveTasks(tasks: ImageTask[]) {
  mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  writeFileSync(DATA_PATH, JSON.stringify(tasks, null, 2), "utf8");
}

function imageDimension(value: unknown) {
  const dimension = Number(value);
  return Number.isInteger(dimension) && dimension >= 768 && dimension <= 2048 && dimension % 256 === 0
    ? dimension
    : null;
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

  const referenceImage =
    typeof input.referenceImage === "string" &&
    input.referenceImage.startsWith("data:image/") &&
    input.referenceImage.length <= 6_000_000
      ? input.referenceImage
      : null;
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

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  return guard ?? NextResponse.json({ tasks: readTasks() }, { headers: { "cache-control": "no-store" } });
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
      return NextResponse.json({ task, tasks });
    }

    const id = String(body.id ?? "");
    if (!tasks.some((task) => task.id === id)) {
      return NextResponse.json({ error: "task_not_found" }, { status: 404 });
    }
    const updatedAt = new Date().toISOString();
    if (action === "delete") tasks = tasks.filter((task) => task.id !== id);
    else if (action === "confirm") tasks = tasks.map((task) => task.id === id ? { ...task, status: "waiting_for_gpu", updatedAt } : task);
    else if (action === "retry") tasks = tasks.map((task) => task.id === id ? { ...task, status: "pending_confirmation", attempts: task.attempts + 1, updatedAt } : task);
    else return NextResponse.json({ error: "invalid_action" }, { status: 400 });

    saveTasks(tasks);
    return NextResponse.json({ tasks });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "image_task_failed" }, { status: 400 });
  }
}
