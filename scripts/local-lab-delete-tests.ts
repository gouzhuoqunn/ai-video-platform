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
    assert(route.includes("soft_delete_video_jobs"), "delete route must soft-delete and refund in one RPC.");
    assert(route.includes("deletion_cleanup_status"), "delete route must record cleanup retry status.");
    assert(route.includes("absolute_paths_included: false"), "delete response must not expose absolute paths.");
    assert(route.includes("job_record_deleted: false"), "delete route must keep audit records instead of hard-deleting.");

    const studio = read("src/components/LocalCreationStudio.tsx");
    assert(studio.includes('requestBatch("delete")'), "batch delete must use optimistic UI action.");
    assert(studio.includes("setJobs((current) => current.filter"), "delete must optimistically remove cards from UI.");
    assert(studio.includes("视频生成中，不能删除") || route.includes("视频生成中，不能删除"), "processing delete rejection must remain visible.");

    console.log("Local lab delete tests passed.");
  } finally {
    process.env.LOCAL_VIDEO_LIBRARY_DIR = originalDir;
    rmSync(temp, { recursive: true, force: true });
  }
}

void main();
