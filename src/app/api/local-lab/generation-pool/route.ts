import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import {
  abortConfirmedQueueRentalSearch,
  beginConfirmedQueueExecution,
  confirmGenerationTasks,
  createGenerationTask,
  createNormalJobSet,
  generationPoolSummary,
  readGenerationPool,
  regenerateGenerationTasks,
  requestPoolGenerationStop,
  requestPoolModelStop,
  requestPoolGpuCancellation,
  retryGenerationTasks,
  updateGenerationTasks,
  upsertGenerationTasks,
  type GenerationJobForm,
  type GenerationTask,
  type GenerationType,
} from "@/lib/generation/task-pool";
import {
  assertSingleFamilyExecution,
  confirmedQueueCounts,
  confirmedVideoQueueCounts,
  confirmedQueueTasks,
  defaultGpuExecutionState,
  rentalEligibilityFor,
  type GpuExecutionState,
  type RequiredGpuClass,
} from "@/lib/generation/gpu-execution-state";
import { validateProductionPrompt } from "@/lib/generation/production-prompt-safety";
import { listLocalImageResults } from "@/lib/local-lab/local-results";
import { longVideoUploadExists } from "@/lib/long-video/uploads";
import type { TaskMediaType } from "@/lib/generation/gallery-routing";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Payload = {
  action?: "create" | "sync" | "confirm" | "cancel" | "delete" | "retry" | "regenerate" | "start_execution" | "abort_search" | "stop_generation" | "stop_model" | "cancel_gpu";
  generationType?: GenerationType;
  mediaType?: TaskMediaType;
  jobForm?: GenerationJobForm;
  prompt?: string;
  negativePrompt?: string;
  seed?: number | null;
  sizePreset?: "square_1024" | "landscape_1024" | "medium_image_4090" | "medium_image_5090" | "high_image_5090" | "wan_4090" | "wan_5090" | "low_video_4090" | "medium_video_4090" | "medium_video_5090" | "high_video_5090" | "audible_low_video_4090" | "audible_medium_video_5090" | "audible_high_video_5090";
  existingImageJobId?: string | null;
  startMode?: "pending";
  gpuClass?: RequiredGpuClass;
  modelProfile?: string;
  modelKey?: "image_flux" | "video_wan_silent" | "video_ltx_native_audio";
  gpuPreference?: string[];
  taskIds?: string[];
  tasks?: Array<Partial<GenerationTask> & Pick<GenerationTask, "id" | "generationType" | "prompt" | "modelProfile">>;
};

function ids(value: unknown) { return Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 100) : []; }

function fixtureExecution(name: string): GpuExecutionState {
  const base = defaultGpuExecutionState();
  const active = { generationFamily: "image" as const, gpuClass: "rtx5090" as const, confirmedTaskIds: ["fixture-image-5090-waiting"], runtimeSessionId: "fixture-session" };
  const rented = { rentedGpuClass: "rtx5090" as const, providerOrderId: "fixture-order", runtimeSessionId: "fixture-session" };
  if (name === "searching") return { ...base, activity: "searching", activeExecution: active, operationId: "fixture-search", updatedAt: new Date().toISOString() };
  if (name === "rental_success") return { ...base, ...rented, activity: "deploying", activeExecution: active, switchPhase: "deploying", notice: "rental_succeeded" };
  if (name === "rented_image") return { ...base, ...rented, activity: "running", deployedFamily: "image", activeExecution: active };
  if (name === "rented_video") return { ...base, ...rented, activity: "running", deployedFamily: "video", activeExecution: { ...active, generationFamily: "video", confirmedTaskIds: ["fixture-video-5090-waiting"] } };
  if (name === "stopped_image") return { ...base, ...rented, activity: "idle", deployedFamily: "image", idleCancelAt: new Date(Date.now() + 120_000).toISOString(), notice: "generation_stopped" };
  if (name === "switching") return { ...base, ...rented, activity: "deploying", deployedFamily: "image", activeExecution: { ...active, generationFamily: "video", confirmedTaskIds: ["fixture-video-5090-waiting"] }, switchPhase: "unloading", operationId: "fixture-switch" };
  if (name === "canceling") return { ...base, ...rented, activity: "canceling", deployedFamily: "video", activeExecution: { ...active, generationFamily: "video" }, operationId: "fixture-cancel" };
  return base;
}

function withStage4J9Fixture(summary: ReturnType<typeof generationPoolSummary>, fixture: string) {
  const fixtures = [
    createGenerationTask({ id: "fixture-image-4090-pending", generationType: "image", prompt: "蓝色图片待确认任务", modelProfile: "ultrareal-flux1-dev-fp8", gpuPreference: ["rtx4090"], status: "pending_confirmation" }),
    createGenerationTask({ id: "fixture-image-5090-pending", generationType: "image", prompt: "绿色图片待确认任务", modelProfile: "ultrareal-flux1-dev-fp8", gpuPreference: ["rtx5090"], status: "pending_confirmation" }),
    createGenerationTask({ id: "fixture-video-4090-pending", generationType: "video", prompt: "蓝色视频待确认任务", modelProfile: "wan22-remix-14b-i2v-fp8", jobForm: "video_from_existing_image", gpuPreference: ["rtx4090"], status: "pending_confirmation", inputImageVerified: true, inputImageJobId: "fixture-image" }),
    createGenerationTask({ id: "fixture-video-5090-pending", generationType: "video", prompt: "绿色视频待确认任务", modelProfile: "wan22-remix-14b-i2v-fp8", jobForm: "video_from_existing_image", gpuPreference: ["rtx5090"], status: "pending_confirmation", inputImageVerified: true, inputImageJobId: "fixture-image" }),
    createGenerationTask({ id: "fixture-image-4090-waiting", generationType: "image", prompt: "蓝色图片已确认任务", modelProfile: "ultrareal-flux1-dev-fp8", gpuPreference: ["rtx4090"], status: "waiting_for_gpu" }),
    createGenerationTask({ id: "fixture-image-5090-waiting", generationType: "image", prompt: "绿色图片已确认任务", modelProfile: "ultrareal-flux1-dev-fp8", gpuPreference: ["rtx5090"], status: "waiting_for_gpu" }),
    createGenerationTask({ id: "fixture-video-4090-waiting", generationType: "video", prompt: "蓝色短视频已确认任务", modelProfile: "wan22-remix-14b-i2v-fp8", jobForm: "video_from_existing_image", gpuPreference: ["rtx4090"], status: "waiting_for_gpu", inputImageVerified: true, inputImageJobId: "fixture-image" }),
    createGenerationTask({ id: "fixture-long-video-4090-waiting", generationType: "video", prompt: "蓝色长视频已确认任务", modelProfile: "wan22-remix-14b-i2v-fp8", jobForm: "long_video_segment", gpuPreference: ["rtx4090"], status: "waiting_for_gpu", inputImageVerified: true, inputImageJobId: "fixture-image", longVideoProjectId: "fixture-long-video", longVideoSegmentIndex: 0 }),
    createGenerationTask({ id: "fixture-video-5090-waiting", generationType: "video", prompt: "绿色视频已确认任务", modelProfile: "wan22-remix-14b-i2v-fp8", jobForm: "video_from_existing_image", gpuPreference: ["rtx5090"], status: "waiting_for_gpu", inputImageVerified: true, inputImageJobId: "fixture-image" }),
    createGenerationTask({ id: "fixture-audible-video-4090-waiting", generationType: "video", prompt: "蓝色有声视频已确认任务", modelProfile: "ltx23_sulphur_native_audio_fp8", modelKey: "video_ltx_native_audio", soundMode: "audible", audioOrigin: "local_voice_conditioning", audioBinding: { voiceInferenceJobId: "fixture-audio-4090", audioRevisionId: "fixture-audio-revision-4090", status: "local_audio_ready", inputAudioSha256: "fixture", inputAudioDurationMs: 2000 }, jobForm: "video_from_existing_image", gpuPreference: ["rtx4090"], status: "waiting_for_gpu", inputImageVerified: true, inputImageJobId: "fixture-image" }),
    createGenerationTask({ id: "fixture-audible-video-5090-waiting", generationType: "video", prompt: "绿色有声视频已确认任务", modelProfile: "ltx23_sulphur_native_audio_fp8", modelKey: "video_ltx_native_audio", soundMode: "audible", audioOrigin: "local_voice_conditioning", audioBinding: { voiceInferenceJobId: "fixture-audio-5090", audioRevisionId: "fixture-audio-revision-5090", status: "local_audio_ready", inputAudioSha256: "fixture", inputAudioDurationMs: 2000 }, jobForm: "video_from_existing_image", gpuPreference: ["rtx5090"], status: "waiting_for_gpu", inputImageVerified: true, inputImageJobId: "fixture-image" }),
  ];
  const tasks = [...summary.tasks.filter((task) => ["completed", "failed", "cancelled"].includes(task.status)), ...fixtures];
  return {
    ...summary,
    tasks,
    confirmedQueueCounts: confirmedQueueCounts(tasks),
    confirmedVideoQueueCounts: confirmedVideoQueueCounts(tasks),
    execution: fixtureExecution(fixture),
    provider_mutations: 0,
    fixture_mode: true,
  };
}

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  const summary = generationPoolSummary();
  const fixture = process.env.STAGE4J9_UI_FIXTURES === "true" ? request.nextUrl.searchParams.get("fixture") : null;
  return NextResponse.json(fixture ? withStage4J9Fixture(summary, fixture) : summary, {
    headers: { "cache-control": "no-store, max-age=0" },
  });
}

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;
  const payload = await request.json().catch(() => ({})) as Payload;
  if (payload.action === "create") {
    const prompt = String(payload.prompt ?? "").trim();
    const jobForm = (payload.jobForm ?? (payload.generationType === "image" ? "image_only" : "video_from_generated_image")) as Exclude<GenerationJobForm, "long_video_segment">;
    if (!["image_only", "video_from_generated_image", "video_from_existing_image"].includes(jobForm) || !prompt || prompt.length > 2000) return NextResponse.json({ error: "任务字段无效。" }, { status: 400 });
    const expectedMediaType: GenerationType = jobForm === "image_only" ? "image" : "video";
    if (payload.generationType !== expectedMediaType || (payload.mediaType !== undefined && payload.mediaType !== expectedMediaType)) return NextResponse.json({ error: "媒体类型必须与提交的任务形式一致。" }, { status: 400 });
    const safety = validateProductionPrompt(prompt);
    if (!safety.allowed) return NextResponse.json({ error: safety.reason, code: safety.code }, { status: 400 });
    const existingImageId = String(payload.existingImageJobId ?? "");
    const existingImageVerified = jobForm !== "video_from_existing_image" || listLocalImageResults().some((image) => image.sessionId === existingImageId) || longVideoUploadExists(existingImageId);
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
      const state = upsertGenerationTasks(tasks);
      return NextResponse.json({ tasks, pool: generationPoolSummary(state), scheduler_armed: false, provider_authorization_created: false, credit_charged: false, create_order_called: false });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建生产任务。" }, { status: 400 });
    }
  }
  if (payload.action === "sync") {
    const requested = (payload.tasks ?? []).slice(0, 100);
    if (requested.some((task) => task.mediaType !== task.generationType || !["image", "video"].includes(String(task.mediaType)))) return NextResponse.json({ error: "同步任务缺少或更改了规范媒体类型。" }, { status: 400 });
    const rejected = requested.map((task) => validateProductionPrompt(String(task.prompt ?? ""))).find((result) => !result.allowed);
    if (rejected) return NextResponse.json({ error: rejected.reason, code: rejected.code }, { status: 400 });
    const tasks = requested.map((task) => createGenerationTask(task));
    return NextResponse.json({ synced: tasks.length, pool: generationPoolSummary(upsertGenerationTasks(tasks)), create_order_called: false });
  }
  if (payload.action === "start_execution") {
    const family = payload.generationType;
    const gpuClass = payload.gpuClass;
    if (!family || !["image", "video"].includes(family) || !gpuClass || !["rtx4090", "rtx5090"].includes(gpuClass)) return NextResponse.json({ error: "执行队列无效。" }, { status: 400 });
    const state = readGenerationPool();
    const queue = confirmedQueueTasks(state.tasks, family, gpuClass).filter((task) => !payload.modelKey || task.modelKey === payload.modelKey);
    const requested = ids(payload.taskIds);
    const tasks = requested.length ? queue.filter((task) => requested.includes(task.id)) : queue;
    try {
      const eligibility = rentalEligibilityFor({
        state: state.execution,
        tasks: state.tasks,
        family,
        gpuClass,
        modelKey: payload.modelKey,
        manualAuthorization: true,
      });
      if (!eligibility.eligible) return NextResponse.json({ error: eligibility.reason, eligibility, provider_mutations: 0, create_order_called: false }, { status: 409 });
      assertSingleFamilyExecution(tasks, family, gpuClass);
      const next = beginConfirmedQueueExecution({
        generationFamily: family,
        gpuClass,
        operationId: randomUUID(),
        manualRentalIntentVerified: true,
        modelKey: payload.modelKey,
        taskIds: tasks.map((task) => task.id),
      });
      const needsRental = !state.execution.rentedGpuClass;
      return NextResponse.json({
        pool: generationPoolSummary(next),
        controller_action_required: !needsRental,
        manual_authorization_required: needsRental,
        binding: { generation_family: family, gpu_class: gpuClass, confirmed_task_ids: tasks.map((task) => task.id) },
        paid_execution_authorized: false,
        eligibility,
        provider_mutations: 0,
        create_order_called: false,
      }, { status: 202 });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "无法开始执行队列。", provider_mutations: 0 }, { status: 409 });
    }
  }
  if (payload.action === "abort_search") {
    try {
      const next = abortConfirmedQueueRentalSearch();
      return NextResponse.json({ pool: generationPoolSummary(next), provider_mutations: 0, create_order_called: false });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "无法取消寻卡。", provider_mutations: 0 }, { status: 409 });
    }
  }
  if (payload.action === "stop_generation") {
    try {
      const next = requestPoolGenerationStop(randomUUID());
      return NextResponse.json({ pool: generationPoolSummary(next), controller_action_required: true, provider_order_preserved: true, provider_mutations: 0 }, { status: 202 });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "无法停止生成。", provider_mutations: 0 }, { status: 409 });
    }
  }
  if (payload.action === "stop_model") {
    try {
      const next = requestPoolModelStop(randomUUID());
      return NextResponse.json({ pool: generationPoolSummary(next), controller_action_required: true, provider_order_preserved: true, provider_mutations: 0 }, { status: 202 });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "无法停止模型。", provider_mutations: 0 }, { status: 409 });
    }
  }
  if (payload.action === "cancel_gpu") {
    try {
      const next = requestPoolGpuCancellation(randomUUID());
      return NextResponse.json({ pool: generationPoolSummary(next), controller_action_required: true, waiting_tasks_preserved: true, provider_mutations: 0 }, { status: 202 });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "无法退租显卡。", provider_mutations: 0 }, { status: 409 });
    }
  }
  const action = payload.action;
  if (!action || !["confirm", "cancel", "delete", "retry", "regenerate"].includes(action)) return NextResponse.json({ error: "任务池操作无效。" }, { status: 400 });
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
  if (action === "confirm") {
    if (!payload.generationType || !["image", "video"].includes(payload.generationType)) return NextResponse.json({ error: "确认任务缺少生成类型。" }, { status: 400 });
    try {
      const result = confirmGenerationTasks(taskIds, payload.generationType);
      return NextResponse.json({ updated: result.confirmed, duplicate_confirmation_blocked: result.duplicateConfirmationBlocked, pool: generationPoolSummary(result.state), scheduler_armed: false, provider_mutations: 0, create_order_called: false });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "确认任务失败。", provider_mutations: 0 }, { status: 409 });
    }
  }
  const state = updateGenerationTasks(taskIds, action);
  return NextResponse.json({ updated: taskIds.length, pool: generationPoolSummary(state), scheduler_armed: false, provider_mutations: 0, create_order_called: false });
}
