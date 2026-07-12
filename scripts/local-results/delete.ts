import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { buildLocalJobPaths, loadLocalResultsConfig } from "./config";

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{6,120}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertSafeJobId(jobId: string) {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error("Invalid job id.");
  }
}

function assertInsideLibrary(libraryDir: string, filePath: string) {
  const relative = path.relative(path.resolve(libraryDir), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to delete outside the local video library.");
  }
}

export function deleteLocalResultFiles(jobId: string) {
  assertSafeJobId(jobId);
  const config = loadLocalResultsConfig();
  const summary = {
    local_video_deleted: false,
    local_thumbnail_deleted: false,
    local_metadata_deleted: false,
    local_job_dir_deleted: false,
    local_result_found: false,
  };

  if (!existsSync(config.libraryDir)) {
    return summary;
  }

  for (const date of readdirSync(config.libraryDir)) {
    if (!DATE_PATTERN.test(date)) continue;
    const dateDir = path.join(config.libraryDir, date);
    if (!statSync(dateDir).isDirectory()) continue;
    const paths = buildLocalJobPaths(config.libraryDir, date, jobId);
    assertInsideLibrary(config.libraryDir, paths.jobDir);
    if (!existsSync(paths.jobDir)) continue;

    summary.local_result_found = true;
    for (const [key, filePath] of [
      ["local_video_deleted", paths.videoPath],
      ["local_thumbnail_deleted", paths.thumbnailPath],
      ["local_metadata_deleted", paths.metadataPath],
    ] as const) {
      assertInsideLibrary(config.libraryDir, filePath);
      if (existsSync(filePath)) {
        rmSync(filePath, { force: true });
        summary[key] = true;
      }
    }

    try {
      rmSync(paths.jobDir, { recursive: false, force: true });
      summary.local_job_dir_deleted = !existsSync(paths.jobDir);
    } catch {
      summary.local_job_dir_deleted = false;
    }
  }

  return summary;
}
