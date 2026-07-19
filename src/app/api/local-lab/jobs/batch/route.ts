import { NextResponse, type NextRequest } from "next/server";
import { LOCAL_LAB_ROLE } from "@/lib/local-lab/config";
import { guardLocalLabMutation } from "@/lib/local-lab/route-guard";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createGenerationTask, updateGenerationTasks, upsertGenerationTasks } from "@/lib/generation/task-pool";

type BatchAction = "confirm" | "delete" | "regenerate";

type BatchPayload = {
  action?: BatchAction;
  jobIds?: string[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeJobIds(values: unknown) {
  return Array.isArray(values) ? values.map(String).filter((value) => UUID_PATTERN.test(value)).slice(0, 50) : [];
}

async function assertLocalTester(userId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || data.user?.app_metadata?.role !== LOCAL_LAB_ROLE) {
    throw new Error("Only the local_tester account can use batch local lab actions.");
  }
}

async function mirrorVideoJobs(userId: string, jobIds: string[]) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.from("video_jobs").select("id,prompt,model_key,priority,status,created_at,confirmed_at,output_video_path,output_size_bytes,output_mime_type").eq("user_id", userId).in("id", jobIds);
  if (error) throw new Error("Unable to mirror selected jobs into the generation pool.");
  const tasks = (data ?? []).map((job) => createGenerationTask({
    id: String(job.id), generationType: "video", prompt: String(job.prompt), modelProfile: "wan22-ti2v-5b",
    contentMode: "legacy_debug",
    priority: job.priority === "urgent" ? "immediate" : "normal",
    status: "waiting_for_gpu",
    createdAt: String(job.created_at), confirmedAt: job.confirmed_at ? String(job.confirmed_at) : null,
    gpuPreference: ["rtx4090"],
    requiredGpuClass: "rtx4090",
    estimatedVram: 24, outputMetadata: { outputPath: job.output_video_path ?? null, sizeBytes: job.output_size_bytes ?? null, mimeType: job.output_mime_type ?? null },
  }));
  upsertGenerationTasks(tasks);
}

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;

  const payload = (await request.json().catch(() => ({}))) as BatchPayload;
  const action = payload.action;
  const jobIds = normalizeJobIds(payload.jobIds);

  if (!action || !["confirm", "delete", "regenerate"].includes(action)) {
    return NextResponse.json({ error: "Invalid batch action." }, { status: 400 });
  }
  if (jobIds.length === 0) {
    return NextResponse.json({ error: "Select at least one job." }, { status: 400 });
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
    await mirrorVideoJobs(user.id, jobIds);
    return NextResponse.json({
      action,
      confirmed_count: Array.isArray(data) ? data[0]?.confirmed_count ?? 0 : data?.confirmed_count ?? 0,
      create_order_called: false,
      automatic_provider: null,
      scheduler_armed: false,
      provider_mutations: 0,
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

  const regeneratedTasks = regenerated.filter(Boolean).map((job) => createGenerationTask({ id: String(job.id), generationType: "video", prompt: String(job.prompt), modelProfile: "wan22-ti2v-5b", contentMode: "legacy_debug", status: "pending_confirmation", createdAt: String(job.created_at), estimatedVram: 24 }));
  upsertGenerationTasks(regeneratedTasks);

  return NextResponse.json({ action, regenerated });
}
