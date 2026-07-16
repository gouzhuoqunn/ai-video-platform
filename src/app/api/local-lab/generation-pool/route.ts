import { NextResponse, type NextRequest } from "next/server";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import { armGenerationPool, createGenerationTask, generationPoolSummary, readGenerationPool, updateGenerationTasks, upsertGenerationTasks, type GenerationPriority, type GenerationTask, type GenerationType } from "@/lib/generation/task-pool";

type Payload = {
  action?: "create" | "sync" | "confirm" | "immediate" | "cancel" | "delete" | "regenerate" | "arm";
  generationType?: GenerationType;
  prompt?: string;
  modelProfile?: string;
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
    const generationType = payload.generationType;
    const modelProfile = String(payload.modelProfile ?? "").trim();
    if (!generationType || !["image", "video"].includes(generationType) || !prompt || prompt.length > 2000 || !modelProfile) return NextResponse.json({ error: "任务字段无效。" }, { status: 400 });
    const task = createGenerationTask({ generationType, prompt, modelProfile });
    const state = upsertGenerationTasks([task]);
    return NextResponse.json({ task, pool: generationPoolSummary(state), create_order_called: false });
  }
  if (payload.action === "sync") {
    const tasks = (payload.tasks ?? []).slice(0, 100).map((task) => createGenerationTask(task));
    return NextResponse.json({ synced: tasks.length, pool: generationPoolSummary(upsertGenerationTasks(tasks)), create_order_called: false });
  }
  if (payload.action === "arm") {
    const armed = armGenerationPool();
    return NextResponse.json({ armed: armed.armed, reason: armed.reason, reused_persisted_batch: armed.reusedPersistedBatch, pool: generationPoolSummary(armed.state), create_order_called: false });
  }
  const action = payload.action;
  if (!action || !["confirm", "immediate", "cancel", "delete", "regenerate"].includes(action)) return NextResponse.json({ error: "任务池操作无效。" }, { status: 400 });
  const taskIds = ids(payload.taskIds);
  if (!taskIds.length) return NextResponse.json({ error: "请选择至少一个任务。" }, { status: 400 });
  if (action === "regenerate") {
    const current = readGenerationPool();
    const regenerated = current.tasks.filter((task) => taskIds.includes(task.id)).map((task) => createGenerationTask({ ...task, id: undefined, status: "pending_confirmation", priority: "normal" as GenerationPriority, confirmedAt: null, batchId: null, createdAt: undefined, outputMetadata: {} }));
    return NextResponse.json({ regenerated, pool: generationPoolSummary(upsertGenerationTasks(regenerated)), create_order_called: false });
  }
  const state = updateGenerationTasks(taskIds, action);
  const armed = action === "immediate" ? armGenerationPool() : null;
  return NextResponse.json({ updated: taskIds.length, pool: generationPoolSummary(armed?.state ?? state), scheduler_armed: armed?.armed ?? false, create_order_called: false });
}
