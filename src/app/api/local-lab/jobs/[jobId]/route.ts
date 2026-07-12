import { NextResponse, type NextRequest } from "next/server";
import { guardLocalLabMutation } from "@/lib/local-lab/route-guard";
import { LOCAL_LAB_ROLE } from "@/lib/local-lab/config";
import { deleteLocalResultFiles } from "@/lib/local-lab/local-results";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { VIDEO_JOB_SELECT_FIELDS } from "@/lib/video-jobs/fields";
import { GENERATED_VIDEOS_BUCKET } from "@/lib/video-jobs/signed-url-policy";
import type { VideoJob } from "@/types/video-jobs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

async function listStoragePathsForJob(userId: string, jobId: string, outputPath: string | null) {
  const admin = getSupabaseAdminClient();
  const prefix = `${userId}/${jobId}`;
  const paths = new Set<string>();
  if (outputPath?.startsWith(`${prefix}/`)) {
    paths.add(outputPath);
  }

  const { data, error } = await admin.storage.from(GENERATED_VIDEOS_BUCKET).list(prefix, { limit: 100 });
  if (!error) {
    for (const item of data ?? []) {
      if (item.name && !item.name.includes("/") && !item.name.includes("..")) {
        paths.add(`${prefix}/${item.name}`);
      }
    }
  }

  return [...paths];
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;

  const { jobId } = await context.params;
  if (!UUID_PATTERN.test(jobId)) {
    return NextResponse.json({ error: "Invalid job id." }, { status: 400 });
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

  const admin = getSupabaseAdminClient();
  const { data: authUser, error: authError } = await admin.auth.admin.getUserById(user.id);
  if (authError || authUser.user?.app_metadata?.role !== LOCAL_LAB_ROLE) {
    return NextResponse.json({ error: "Only the local_tester account can delete local lab history." }, { status: 403 });
  }

  const { data: existing, error: readError } = await admin.from("video_jobs").select(VIDEO_JOB_SELECT_FIELDS).eq("id", jobId).maybeSingle();
  if (readError) {
    return NextResponse.json({ error: "Unable to read the video job." }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({
      deleted: true,
      already_deleted: true,
      absolute_paths_included: false,
    });
  }

  const job = existing as VideoJob;
  if (job.user_id !== user.id) {
    return NextResponse.json({ error: "This video job does not belong to the local tester." }, { status: 403 });
  }
  if (job.status === "processing") {
    return NextResponse.json({ error: "视频生成中，不能删除" }, { status: 409 });
  }

  let queuedCanceled = false;
  if (job.status === "queued") {
    const { error: cancelError } = await supabase.rpc("cancel_video_job", { p_job_id: jobId });
    if (cancelError) {
      return NextResponse.json({ error: "Unable to cancel queued job before deletion." }, { status: 409 });
    }
    queuedCanceled = true;
  }

  const storagePaths = await listStoragePathsForJob(user.id, jobId, job.output_video_path);
  let supabaseObjectsDeleted = 0;
  if (storagePaths.length > 0) {
    const { error: storageError } = await admin.storage.from(GENERATED_VIDEOS_BUCKET).remove(storagePaths);
    if (storageError) {
      return NextResponse.json({ error: "Unable to delete generated video objects." }, { status: 500 });
    }
    supabaseObjectsDeleted = storagePaths.length;
  }

  const localSummary = deleteLocalResultFiles(jobId);
  const { error: deleteError } = await admin.from("video_jobs").delete().eq("id", jobId).eq("user_id", user.id);
  if (deleteError) {
    return NextResponse.json({ error: "Unable to delete the video job record." }, { status: 500 });
  }

  return NextResponse.json({
    deleted: true,
    queued_canceled: queuedCanceled,
    job_record_deleted: true,
    supabase_objects_deleted: supabaseObjectsDeleted,
    ...localSummary,
    absolute_paths_included: false,
  });
}
