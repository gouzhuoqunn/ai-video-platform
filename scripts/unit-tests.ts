import { canCreateSignedVideoUrl, getExpectedOutputPath, getSafeVideoFilename, SIGNED_URL_EXPIRES_IN } from "../src/lib/video-jobs/signed-url-policy";
import type { VideoJob } from "../src/types/video-jobs";
import { readFileSync } from "node:fs";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function baseJob(overrides: Partial<VideoJob> = {}): VideoJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    user_id: "22222222-2222-4222-8222-222222222222",
    prompt: "test",
    model_key: "lightweight-video",
    status: "succeeded",
    duration_seconds: 5,
    resolution: "480p",
    cost_credits: 5,
    reference_image_path: null,
    output_video_url: null,
    thumbnail_url: null,
    error_message: null,
    progress: 100,
    worker_id: null,
    lease_expires_at: null,
    attempt_count: 1,
    max_attempts: 3,
    output_video_path: "22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/output.mp4",
    thumbnail_path: "22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/thumbnail.jpg",
    thumbnail_status: "ready",
    output_size_bytes: 100,
    output_mime_type: "video/mp4",
    priority: "normal",
    confirmed_at: "2026-07-06T00:00:00.000Z",
    queued_at: "2026-07-06T00:00:00.000Z",
    deleted_at: null,
    deletion_cleanup_status: "none",
    deletion_cleanup_error: null,
    generation_group_id: "11111111-1111-4111-8111-111111111111",
    generation_number: 1,
    parent_job_id: null,
    charged_at: "2026-07-06T00:00:00.000Z",
    refunded_at: null,
    created_at: "2026-07-06T00:00:00.000Z",
    updated_at: "2026-07-06T00:00:00.000Z",
    started_at: "2026-07-06T00:00:00.000Z",
    completed_at: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

function main() {
  const succeeded = baseJob();
  assert(SIGNED_URL_EXPIRES_IN === 900, "签名 URL 应为短期 15 分钟。");
  assert(getSafeVideoFilename(succeeded.id, "video/mp4").endsWith(".mp4"), "MP4 文件名应正确。");
  assert(getSafeVideoFilename(succeeded.id, "video/webm").endsWith(".webm"), "WebM 文件名应正确。");
  assert(getExpectedOutputPath(succeeded) === succeeded.output_video_path, "期望路径应匹配 user_id/job_id/output.mp4。");
  assert(canCreateSignedVideoUrl(succeeded), "succeeded 且路径正确时应允许签名 URL。");

  for (const status of ["queued", "failed", "canceled"] as const) {
    assert(!canCreateSignedVideoUrl(baseJob({ status })), `${status} 不应允许签名 URL。`);
  }

  assert(!canCreateSignedVideoUrl(baseJob({ output_video_path: null })), "缺少输出路径不应允许签名 URL。");
  assert(!canCreateSignedVideoUrl(baseJob({ deleted_at: "2026-07-06T00:00:00.000Z" })), "已软删除任务不应允许签名 URL。");
  assert(!canCreateSignedVideoUrl(baseJob({ output_video_path: `${succeeded.user_id}/wrong-job/output.mp4` })), "job_id 不匹配应拒绝。");
  assert(!canCreateSignedVideoUrl(baseJob({ output_video_path: `wrong-user/${succeeded.id}/output.mp4` })), "user_id 不匹配应拒绝。");
  assert(!canCreateSignedVideoUrl(baseJob({ output_video_path: `${succeeded.user_id}/${succeeded.id}/output.webm` })), "mime/path 扩展名不匹配应拒绝。");

  const migration0005 = readFileSync(path.join(process.cwd(), "supabase", "migrations", "0005_limited_gpu_worker_role.sql"), "utf8");
  assert(migration0005.includes("app_metadata") && migration0005.includes("gpu_worker"), "0005 应检查 gpu_worker app_metadata 角色。");
  assert(migration0005.includes("auth.role() = 'service_role'"), "0005 应保留 service_role 管理路径。");
  assert(migration0005.includes("generated_videos_gpu_worker_insert_owned_output"), "0005 应增加受限 Storage 上传策略。");
  assert(migration0005.includes("job.worker_id = auth.uid()::text"), "Storage 上传必须绑定当前 Worker 已领取任务。");
  assert(!migration0005.includes("grant insert on storage.objects to authenticated"), "0005 不应扩大普通 authenticated 直接上传权限。");
  console.log("单元测试通过：签名 URL 核心校验。");
}

void main();
