import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { VIDEO_JOB_SELECT_FIELDS } from "@/lib/video-jobs/fields";
import {
  canCreateSignedVideoUrl,
  GENERATED_VIDEOS_BUCKET,
  getSafeVideoFilename,
  SIGNED_URL_EXPIRES_IN,
} from "@/lib/video-jobs/signed-url-policy";
import type { SignedVideoResponse, VideoJob } from "@/types/video-jobs";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({ error: "Supabase 尚未配置。" }, { status: 500 });
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("video_jobs")
    .select(VIDEO_JOB_SELECT_FIELDS)
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "读取任务失败。" }, { status: 500 });
  }

  const job = data as VideoJob | null;

  if (!job) {
    return NextResponse.json({ error: "任务不存在或无权访问。" }, { status: 404 });
  }

  if (job.status !== "succeeded" || !job.output_video_path) {
    return NextResponse.json({ error: "任务尚未完成，暂时不能播放或下载。" }, { status: 409 });
  }

  if (!canCreateSignedVideoUrl(job)) {
    return NextResponse.json({ error: "视频路径校验失败。" }, { status: 409 });
  }

  try {
    const admin = getSupabaseAdminClient();
    const { data: signedData, error: signedError } = await admin.storage
      .from(GENERATED_VIDEOS_BUCKET)
      .createSignedUrl(job.output_video_path, SIGNED_URL_EXPIRES_IN);

    if (signedError || !signedData?.signedUrl) {
      return NextResponse.json({ error: "创建视频临时链接失败。" }, { status: 500 });
    }

    const response: SignedVideoResponse = {
      signedUrl: signedData.signedUrl,
      expiresIn: SIGNED_URL_EXPIRES_IN,
      mimeType: job.output_mime_type ?? "video/mp4",
      filename: getSafeVideoFilename(job.id, job.output_mime_type),
    };

    return NextResponse.json(response);
  } catch {
    return NextResponse.json({ error: "服务器视频访问配置不完整。" }, { status: 500 });
  }
}
