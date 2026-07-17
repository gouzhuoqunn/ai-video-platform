import { NextResponse, type NextRequest } from "next/server";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import {
  armGenerationPool,
  createGenerationTask,
  createNormalJobSet,
  generationPoolSummary,
  regenerateGenerationTasks,
  requestSessionShutdown,
  retryGenerationTasks,
  updateGenerationTasks,
  upsertGenerationTasks,
  type GenerationJobForm,
  type GenerationTask,
  type GenerationType,
} from "@/lib/generation/task-pool";
import { validateProductionPrompt } from "@/lib/generation/production-prompt-safety";
import { listLocalImageResults } from "@/lib/local-lab/local-results";

type Payload = {
  action?: "create" | "sync" | "confirm" | "immediate" | "cancel" | "delete" | "retry" | "regenerate" | "arm" | "shutdown";
  generationType?: GenerationType;
  jobForm?: GenerationJobForm;
  prompt?: string;
  negativePrompt?: string;
  seed?: number | null;
  sizePreset?: "square_1024" | "landscape_1024" | "wan_4090" | "wan_5090";
  existingImageJobId?: string | null;
  startMode?: "pending" | "confirm" | "immediate";
  shutdownMode?: "immediate" | "after_current" | "cancel_waiting";
  modelProfile?: string;
  gpuPreference?: string[];
  taskIds?: string[];
  tasks?: Array<Partial<GenerationTask> & Pick<GenerationTask, "id" | "generationType" | "prompt" | "modelProfile">>;
};

function ids(value: unknown) { return Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 100) : []; }

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  return NextResponse.json(generationPoolSummary());
}

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;
  const payload = await request.json().catch(() => ({})) as Payload;
  if (payload.action === "create") {
    const prompt = String(payload.prompt ?? "").trim();
    const jobForm = payload.jobForm ?? (payload.generationType === "image" ? "image_only" : "video_from_generated_image");
    if (!["image_only", "video_from_generated_image", "video_from_existing_image"].includes(jobForm) || !prompt || prompt.length > 2000) return NextResponse.json({ error: "任务字段无效。" }, { status: 400 });
    const safety = validateProductionPrompt(prompt);
    if (!safety.allowed) return NextResponse.json({ error: safety.reason, code: safety.code }, { status: 400 });
    const existingImageId = String(payload.existingImageJobId ?? "");
    const existingImageVerified = jobForm !== "video_from_existing_image" || listLocalImageResults().some((image) => image.sessionId === existingImageId);
    try {
      const tasks = createNormalJobSet({
        jobForm,
        prompt,
        negativePrompt: payload.negativePrompt,
        seed: payload.seed,
        sizePreset: payload.sizePreset,
        gpuPreference: payload.gpuPreference,
        existingImageJobId: existingImageId || null,
        existingImageVerified,
      });
      let state = upsertGenerationTasks(tasks);
      if (payload.startMode === "confirm") state = updateGenerationTasks(tasks.map((task) => task.id), "confirm");
      if (payload.startMode === "immediate") state = updateGenerationTasks(tasks.map((task) => task.id), "immediate");
      const armed = payload.startMode === "immediate" ? armGenerationPool() : null;
      return NextResponse.json({ tasks, pool: generationPoolSummary(armed?.state ?? state), scheduler_armed: armed?.armed ?? false, provider_authorization_created: false, credit_charged: false, create_order_called: false });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建生产任务。" }, { status: 400 });
    }
  }
  if (payload.action === "sync") {
    const requested = (payload.tasks ?? []).slice(0, 100);
    const rejected = requested.map((task) => validateProductionPrompt(String(task.prompt ?? ""))).find((result) => !result.allowed);
    if (rejected) return NextResponse.json({ error: rejected.reason, code: rejected.code }, { status: 400 });
    const tasks = requested.map((task) => createGenerationTask(task));
    return NextResponse.json({ synced: tasks.length, pool: generationPoolSummary(upsertGenerationTasks(tasks)), create_order_called: false });
  }
  if (payload.action === "arm") {
    const armed = armGenerationPool();
    return NextResponse.json({ armed: armed.armed, reason: armed.reason, reused_persisted_batch: armed.reusedPersistedBatch, pool: generationPoolSummary(armed.state), create_order_called: false });
  }
  if (payload.action === "shutdown") {
    if (!payload.shutdownMode || !["immediate", "after_current", "cancel_waiting"].includes(payload.shutdownMode)) return NextResponse.json({ error: "关机操作无效。" }, { status: 400 });
    const state = requestSessionShutdown(payload.shutdownMode);
    return NextResponse.json({ shutdown_mode: payload.shutdownMode, pool: generationPoolSummary(state), create_order_called: false });
  }
  const action = payload.action;
  if (!action || !["confirm", "immediate", "cancel", "delete", "retry", "regenerate"].includes(action)) return NextResponse.json({ error: "任务池操作无效。" }, { status: 400 });
  const taskIds = ids(payload.taskIds);
  if (!taskIds.length) return NextResponse.json({ error: "请选择至少一个任务。" }, { status: 400 });
  if (action === "retry") {
    try {
      const state = retryGenerationTasks(taskIds);
      return NextResponse.json({ retried: taskIds.length, pool: generationPoolSummary(state), create_order_called: false });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "重试失败。" }, { status: 409 });
    }
  }
  if (action === "regenerate") {
    const result = regenerateGenerationTasks(taskIds);
    return NextResponse.json({ regenerated: result.regenerated, pool: generationPoolSummary(result.state), create_order_called: false });
  }
  const state = updateGenerationTasks(taskIds, action);
  const armed = action === "immediate" ? armGenerationPool() : null;
  return NextResponse.json({ updated: taskIds.length, pool: generationPoolSummary(armed?.state ?? state), scheduler_armed: armed?.armed ?? false, create_order_called: false });
}
