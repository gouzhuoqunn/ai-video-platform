import { readFileSync } from "node:fs";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function read(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function main() {
  const migration = read("supabase/migrations/0008_pending_confirmation_batch_autorent.sql");
  assert(migration.includes("pending_confirmation"), "migration must add pending_confirmation.");
  assert(migration.includes("status = 'pending_confirmation'"), "old unclaimed queued jobs must migrate to pending_confirmation.");
  assert(migration.includes("create or replace function public.confirm_video_jobs"), "batch confirm RPC must exist.");
  assert(migration.includes("create or replace function public.mark_video_jobs_urgent"), "urgent RPC must exist.");
  assert(migration.includes("create or replace function public.soft_delete_video_jobs"), "soft delete RPC must exist.");
  assert(migration.includes("create or replace function public.regenerate_video_job"), "regenerate RPC must exist.");
  assert(migration.includes("generation_group_id"), "generation group field must exist.");
  assert(migration.includes("generation_number"), "generation number field must exist.");
  assert(migration.includes("parent_job_id"), "parent job field must exist.");
  assert(migration.includes("gpu_autorent_requests"), "persistent auto-rent request table must exist.");
  assert(migration.includes("status in ('waiting', 'searching', 'candidate_found', 'provisioning', 'assigned', 'failed', 'cancelled')"), "auto-rent states must be constrained.");
  assert(migration.includes("max_effective_hourly_usd <= 0.70"), "auto-rent max price must keep the 0.70 cap.");
  assert(migration.includes("where queued.status = 'queued'"), "worker claim must only see queued tasks.");
  assert(migration.includes("case queued.priority when 'urgent'"), "worker claim must sort urgent jobs first.");
  assert(migration.includes("confirmed_at asc"), "same-priority jobs must sort by confirmation time.");
  assert(migration.includes("thumbnail.jpg"), "thumbnail path must be supported.");

  const fields = read("src/lib/video-jobs/fields.ts");
  assert(fields.includes("deleted_at"), "select fields must include soft-delete state.");
  assert(fields.includes("priority"), "select fields must include priority.");
  assert(fields.includes("generation_number"), "select fields must include generation number.");
  assert(fields.includes("thumbnail_path"), "select fields must include thumbnail path.");

  const autorent = read("src/lib/local-lab/autorent.ts");
  assert(autorent.includes("CLORE_AUTORENT_ENABLED"), "autorent must be gated by CLORE_AUTORENT_ENABLED.");
  assert(autorent.includes("create_order_called: false"), "mock autorent must not call create_order.");
  assert(autorent.includes("waiting") && autorent.includes("assigned"), "mock autorent state machine must cover waiting to assigned.");
  assert(autorent.includes("SESSION_COMPLETE_CANCEL_DEADLINE_MS = 60 * 1000"), "mock session completion must expose the 60 second cancel deadline.");

  const batchRoute = read("src/app/api/local-lab/jobs/batch/route.ts");
  assert(!batchRoute.includes("gpuMode"), "confirmation must not choose or mutate a GPU execution mode.");
  assert(batchRoute.includes("create_order_called: false"), "confirmation must not create a provider order.");
  assert(batchRoute.includes("scheduler_armed: false"), "confirmation must not arm automatic rental.");

  const studio = read("src/components/LocalCreationStudio.tsx");
  assert(studio.includes("确认只进入视频等待队列，不会寻找或租用显卡"), "UI must state that confirmation is queue-only.");
  assert(studio.includes("开始任务并租用显卡") || read("src/lib/generation/gpu-execution-state.ts").includes("开始任务并租用显卡"), "manual rental must remain a separate action.");

  const worker = read("gpu-worker/worker.py");
  assert(worker.includes("ffprobe"), "worker must inspect video duration for thumbnail extraction.");
  assert(worker.includes("scale=640:360:force_original_aspect_ratio=increase,crop=640:360"), "worker must produce a 640x360 thumbnail without stretching.");
  assert(worker.includes("random.Random(job_id)"), "thumbnail frame choice must be stable from job id.");
  assert(worker.includes("thumbnail_failed"), "thumbnail failure must be logged without failing the video.");

  console.log("Local lab batch and autorent tests passed.");
}

void main();
