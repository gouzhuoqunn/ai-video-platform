import { NextResponse, type NextRequest } from "next/server";
import { LOCAL_LAB_ROLE } from "@/lib/local-lab/config";
import { guardLocalLabMutation } from "@/lib/local-lab/route-guard";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { shouldArmCloreScheduler } from "@/lib/local-lab/studio-mode";
import { armGenerationPool, createGenerationTask, generationThreshold, updateGenerationTasks, upsertGenerationTasks } from "@/lib/generation/task-pool";

type BatchAction = "confirm" | "urgent" | "delete" | "regenerate";

type BatchPayload = {
  action?: BatchAction;
  jobIds?: string[];
  minEffectiveHourlyUsd?: number;
  maxEffectiveHourlyUsd?: number;
  gpuMode?: "auto" | "current" | "wait_for_current_to_close";
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeJobIds(values: unknown) {
  return Array.isArray(values) ? values.map(String).filter((value) => UUID_PATTERN.test(value)).slice(0, 50) : [];
}

function normalizePrice(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function assertLocalTester(userId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || data.user?.app_metadata?.role !== LOCAL_LAB_ROLE) {
    throw new Error("Only the local_tester account can use batch local lab actions.");
  }
}

async function createAutoRentRequest(input: {
  supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;
  jobIds: string[];
  priority: "normal" | "urgent";
  minEffectiveHourlyUsd: number;
  maxEffectiveHourlyUsd: number;
}) {
  const { data, error } = await input.supabase.rpc("create_gpu_autorent_request", {
    p_job_ids: input.jobIds,
    p_priority: input.priority,
    p_min_effective_hourly_usd: input.minEffectiveHourlyUsd,
    p_max_effective_hourly_usd: input.maxEffectiveHourlyUsd,
  });
  if (error) {
    return { request: null, error: error.message.split("\n")[0] };
  }
  return { request: data, error: null };
}

async function queuedCount(userId: string) {
  const admin = getSupabaseAdminClient();
  const { count, error } = await admin.from("video_jobs").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "queued").is("deleted_at", null);
  if (error) throw new Error("Unable to count queued tasks.");
  return count ?? 0;
}

async function mirrorVideoJobs(userId: string, jobIds: string[], immediate: boolean) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.from("video_jobs").select("id,prompt,model_key,priority,status,created_at,confirmed_at,output_video_path,output_size_bytes,output_mime_type").eq("user_id", userId).in("id", jobIds);
  if (error) throw new Error("Unable to mirror selected jobs into the generation pool.");
  const tasks = (data ?? []).map((job) => createGenerationTask({
    id: String(job.id), generationType: "video", prompt: String(job.prompt), modelProfile: "wan22-ti2v-5b",
    priority: immediate || job.priority === "urgent" ? "immediate" : "normal",
    status: immediate ? "armed" : job.status === "pending_confirmation" ? "pending_confirmation" : "waiting_for_batch",
    createdAt: String(job.created_at), confirmedAt: job.confirmed_at ? String(job.confirmed_at) : null,
    estimatedVram: 24, outputMetadata: { outputPath: job.output_video_path ?? null, sizeBytes: job.output_size_bytes ?? null, mimeType: job.output_mime_type ?? null },
  }));
  upsertGenerationTasks(tasks);
  if (immediate) return armGenerationPool();
  return null;
}

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;

  const payload = (await request.json().catch(() => ({}))) as BatchPayload;
  const action = payload.action;
  const jobIds = normalizeJobIds(payload.jobIds);
  const minEffectiveHourlyUsd = normalizePrice(payload.minEffectiveHourlyUsd, 0);
  const maxEffectiveHourlyUsd = normalizePrice(payload.maxEffectiveHourlyUsd, 0.7);
  const gpuMode = payload.gpuMode ?? "auto";

  if (!action || !["confirm", "urgent", "delete", "regenerate"].includes(action)) {
    return NextResponse.json({ error: "Invalid batch action." }, { status: 400 });
  }
  if (jobIds.length === 0) {
    return NextResponse.json({ error: "Select at least one job." }, { status: 400 });
  }
  if (minEffectiveHourlyUsd < 0 || minEffectiveHourlyUsd > maxEffectiveHourlyUsd || maxEffectiveHourlyUsd > 0.7) {
    return NextResponse.json({ error: "Invalid GPU price filter." }, { status: 400 });
  }
  if (!["auto", "current", "wait_for_current_to_close"].includes(gpuMode)) {
    return NextResponse.json({ error: "Invalid GPU queue mode." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 500 });
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Please restore the local lab session first." }, { status: 401 });
  }

  try {
    await assertLocalTester(user.id);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Not allowed." }, { status: 403 });
  }

  if (action === "confirm") {
    const { data, error } = await supabase.rpc("confirm_video_jobs", { p_job_ids: jobIds, p_urgent: false });
    if (error) return NextResponse.json({ error: error.message.split("\n")[0] }, { status: 409 });
    const queueSize = await queuedCount(user.id);
    await mirrorVideoJobs(user.id, jobIds, false);
    const scheduler = shouldArmCloreScheduler({ immediate: false, queuedCount: queueSize, threshold: generationThreshold("video") });
    const autorent =
      gpuMode === "current" || !scheduler.schedulerArmed
        ? { request: null, error: null }
        : await createAutoRentRequest({ supabase, jobIds, priority: "normal", minEffectiveHourlyUsd, maxEffectiveHourlyUsd });
    return NextResponse.json({
      action,
      confirmed_count: Array.isArray(data) ? data[0]?.confirmed_count ?? 0 : data?.confirmed_count ?? 0,
      gpu_mode: gpuMode,
      autorent_request: autorent.request,
      autorent_error: autorent.error,
      real_clore_create_enabled: process.env.CLORE_AUTORENT_ENABLED === "true",
      create_order_called: false,
      automatic_provider: scheduler.provider,
      scheduler_armed: scheduler.schedulerArmed,
      batch_threshold: generationThreshold("video"),
      queued_count: queueSize,
    });
  }

  if (action === "urgent") {
    const { data, error } = await supabase.rpc("mark_video_jobs_urgent", { p_job_ids: jobIds });
    if (error) return NextResponse.json({ error: error.message.split("\n")[0] }, { status: 409 });
    const queueSize = await queuedCount(user.id);
    const poolArm = await mirrorVideoJobs(user.id, jobIds, true);
    const scheduler = shouldArmCloreScheduler({ immediate: true, queuedCount: queueSize, threshold: generationThreshold("video") });
    const autorent =
      gpuMode === "current"
        ? { request: null, error: null }
        : await createAutoRentRequest({ supabase, jobIds, priority: "urgent", minEffectiveHourlyUsd, maxEffectiveHourlyUsd });
    return NextResponse.json({
      action,
      updated_count: Array.isArray(data) ? data[0]?.updated_count ?? 0 : data?.updated_count ?? 0,
      gpu_mode: gpuMode,
      autorent_request: autorent.request,
      autorent_error: autorent.error,
      real_clore_create_enabled: process.env.CLORE_AUTORENT_ENABLED === "true",
      create_order_called: false,
      automatic_provider: scheduler.provider,
      scheduler_armed: scheduler.schedulerArmed,
      generation_pool_armed: poolArm?.armed ?? false,
      batch_threshold: generationThreshold("video"),
      queued_count: queueSize,
    });
  }

  if (action === "delete") {
    const { data, error } = await supabase.rpc("soft_delete_video_jobs", { p_job_ids: jobIds });
    if (error) return NextResponse.json({ error: error.message.split("\n")[0] }, { status: 409 });
    updateGenerationTasks(jobIds, "delete");
    return NextResponse.json({
      action,
      deleted: true,
      deleted_count: Array.isArray(data) ? data[0]?.deleted_count ?? 0 : data?.deleted_count ?? 0,
      cleanup_count: Array.isArray(data) ? data[0]?.cleanup_count ?? 0 : data?.cleanup_count ?? 0,
    });
  }

  const regenerated = [];
  for (const jobId of jobIds) {
    const { data, error } = await supabase.rpc("regenerate_video_job", { p_job_id: jobId });
    if (error) return NextResponse.json({ error: error.message.split("\n")[0], failed_job_id: jobId }, { status: 409 });
    regenerated.push(Array.isArray(data) ? data[0] : data);
  }

  const regeneratedTasks = regenerated.filter(Boolean).map((job) => createGenerationTask({ id: String(job.id), generationType: "video", prompt: String(job.prompt), modelProfile: "wan22-ti2v-5b", status: "pending_confirmation", createdAt: String(job.created_at), estimatedVram: 24 }));
  upsertGenerationTasks(regeneratedTasks);

  return NextResponse.json({ action, regenerated });
}
