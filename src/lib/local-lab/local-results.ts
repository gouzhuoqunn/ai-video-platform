import "server-only";

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildLocalJobPaths, loadLocalResultsConfig } from "../../../scripts/local-results/config";
export { deleteLocalResultFiles } from "../../../scripts/local-results/delete";

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{6,120}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type LocalResultSummary = {
  jobId: string;
  date: string;
  hasVideo: boolean;
  hasThumbnail: boolean;
  metadata: Record<string, unknown> | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
};

function assertSafeJobId(jobId: string) {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error("Invalid job id.");
  }
}

function assertInsideLibrary(libraryDir: string, filePath: string) {
  const relative = path.relative(path.resolve(libraryDir), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to read outside the local video library.");
  }
}

function readMetadata(metadataPath: string) {
  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function listLocalResults(): LocalResultSummary[] {
  const config = loadLocalResultsConfig();
  if (!existsSync(config.libraryDir)) {
    return [];
  }

  const results: LocalResultSummary[] = [];
  for (const date of readdirSync(config.libraryDir)) {
    if (!DATE_PATTERN.test(date)) continue;
    const dateDir = path.join(config.libraryDir, date);
    if (!statSync(dateDir).isDirectory()) continue;

    for (const jobId of readdirSync(dateDir)) {
      if (!JOB_ID_PATTERN.test(jobId)) continue;
      const paths = buildLocalJobPaths(config.libraryDir, date, jobId);
      assertInsideLibrary(config.libraryDir, paths.jobDir);
      const hasVideo = existsSync(paths.videoPath);
      const hasThumbnail = existsSync(paths.thumbnailPath);
      results.push({
        jobId,
        date,
        hasVideo,
        hasThumbnail,
        metadata: readMetadata(paths.metadataPath),
        videoUrl: hasVideo ? `/api/local-lab/results/${encodeURIComponent(jobId)}/video` : null,
        thumbnailUrl: hasThumbnail ? `/api/local-lab/results/${encodeURIComponent(jobId)}/thumbnail` : null,
      });
    }
  }

  return results.sort((left, right) => right.date.localeCompare(left.date));
}

export function findLocalResultFile(jobId: string, kind: "video" | "thumbnail") {
  assertSafeJobId(jobId);
  const config = loadLocalResultsConfig();
  if (!existsSync(config.libraryDir)) {
    return null;
  }

  for (const date of readdirSync(config.libraryDir)) {
    if (!DATE_PATTERN.test(date)) continue;
    const paths = buildLocalJobPaths(config.libraryDir, date, jobId);
    const filePath = kind === "video" ? paths.videoPath : paths.thumbnailPath;
    assertInsideLibrary(config.libraryDir, filePath);
    if (existsSync(filePath)) {
      return { filePath, stat: statSync(filePath) };
    }
  }

  return null;
}
