import { NextResponse, type NextRequest } from "next/server";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { VIDEO_JOB_SELECT_FIELDS } from "@/lib/video-jobs/fields";
import type { VideoJob } from "@/types/video-jobs";

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;

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

  const { data, error } = await supabase
    .from("video_jobs")
    .select(VIDEO_JOB_SELECT_FIELDS)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(80);

  if (error) {
    return NextResponse.json({ error: "Unable to read local lab jobs." }, { status: 500 });
  }

  const jobs = (data as VideoJob[] | null) ?? [];
  return NextResponse.json({
    jobs,
    counts: {
      queued: jobs.filter((job) => job.status === "queued").length,
      processing: jobs.filter((job) => job.status === "processing").length,
      succeeded: jobs.filter((job) => job.status === "succeeded").length,
      failed: jobs.filter((job) => job.status === "failed").length,
      canceled: jobs.filter((job) => job.status === "canceled").length,
    },
  });
}
