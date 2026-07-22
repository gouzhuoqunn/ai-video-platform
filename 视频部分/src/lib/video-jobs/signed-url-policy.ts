import type { VideoJob } from "@/types/video-jobs";

export const SIGNED_URL_EXPIRES_IN = 60 * 15;
export const GENERATED_VIDEOS_BUCKET = "generated-videos";

export function getSafeVideoFilename(jobId: string, mimeType: string | null) {
  return `${jobId}.${mimeType === "video/webm" ? "webm" : "mp4"}`;
}

export function getExpectedOutputPath(job: Pick<VideoJob, "id" | "user_id" | "output_mime_type">) {
  return `${job.user_id}/${job.id}/output.${job.output_mime_type === "video/webm" ? "webm" : "mp4"}`;
}

export function canCreateSignedVideoUrl(job: Pick<VideoJob, "id" | "user_id" | "status" | "output_video_path" | "output_mime_type" | "deleted_at">) {
  return !job.deleted_at && job.status === "succeeded" && Boolean(job.output_video_path) && job.output_video_path === getExpectedOutputPath(job);
}
