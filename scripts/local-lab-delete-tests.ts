import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteLocalResultFiles } from "./local-results/delete";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function read(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function main() {
  const originalDir = process.env.LOCAL_VIDEO_LIBRARY_DIR;
  const temp = path.join(os.tmpdir(), `local-lab-delete-${Date.now()}`);
  const jobId = "123e4567-e89b-12d3-a456-426614174000";
  const jobDir = path.join(temp, "2026-07-11", jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(path.join(jobDir, "output.mp4"), "video");
  writeFileSync(path.join(jobDir, "thumbnail.jpg"), "thumb");
  writeFileSync(path.join(jobDir, "metadata.json"), "{}");
  process.env.LOCAL_VIDEO_LIBRARY_DIR = temp;

  try {
    const summary = deleteLocalResultFiles(jobId);
    assert(summary.local_video_deleted, "local output.mp4 should be deleted.");
    assert(summary.local_thumbnail_deleted, "local thumbnail.jpg should be deleted.");
    assert(summary.local_metadata_deleted, "local metadata.json should be deleted.");
    assert(!existsSync(path.join(jobDir, "output.mp4")), "output.mp4 should no longer exist.");
    assert(!existsSync(path.join(jobDir, "thumbnail.jpg")), "thumbnail.jpg should no longer exist.");
    assert(!existsSync(path.join(jobDir, "metadata.json")), "metadata.json should no longer exist.");

    const route = read("src/app/api/local-lab/jobs/[jobId]/route.ts");
    assert(route.includes("guardLocalLabMutation"), "delete route must require local lab mutation guard.");
    assert(route.includes("LOCAL_LAB_ROLE"), "delete route must verify local_tester role.");
    assert(route.includes('job.status === "processing"'), "processing jobs must be rejected.");
    assert(route.includes("cancel_video_job"), "queued jobs must be canceled before deletion.");
    assert(route.includes("GENERATED_VIDEOS_BUCKET"), "delete route must clean Supabase generated videos.");
    assert(route.includes("absolute_paths_included: false"), "delete response must not expose absolute paths.");

    const studio = read("src/components/LocalCreationStudio.tsx");
    assert(studio.includes('aria-label="删除该记录"'), "trash button must have the required aria-label.");
    assert(studio.includes("删除该记录"), "trash tooltip text must be present.");
    assert(studio.includes("视频生成中，不能删除"), "processing tooltip must be present.");
    assert(studio.includes("待删除视频封面"), "delete confirmation must show the thumbnail image alt text.");
    assert(studio.includes("event.stopPropagation()"), "trash click must not open/select the video card.");
    assert(studio.includes("lg:grid-cols-[minmax(0,1fr)_380px]"), "desktop layout must reserve a permanent 380px sidebar.");
    assert(!studio.includes("lg:grid-cols-[minmax(0,1fr)_64px]"), "desktop sidebar must not collapse to a 64px rail.");
    assert(studio.includes("lg:block"), "desktop sidebar content must remain visible.");
    assert(studio.includes("normalized_usd_per_hour"), "host sorting and order planning must use normalized hourly price.");
    assert(!studio.includes("original_on_demand_price.localeCompare"), "host sorting must not use raw price labels.");

    console.log("Local lab delete tests passed.");
  } finally {
    process.env.LOCAL_VIDEO_LIBRARY_DIR = originalDir;
    rmSync(temp, { recursive: true, force: true });
  }
}

void main();
