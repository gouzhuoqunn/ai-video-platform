import "server-only";

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildLocalImagePaths, buildLocalJobPaths, loadLocalImageResultsConfig, loadLocalResultsConfig } from "../../../scripts/local-results/config";
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

export type LocalImageResultSummary = {
  sessionId: string;
  date: string;
  metadata: Record<string, unknown> | null;
  imageUrl: string;
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
    return sanitizeMetadata(JSON.parse(readFileSync(metadataPath, "utf8"))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sanitizeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, sanitizeMetadata(nested)]));
  }
  if (typeof value === "string" && (/^[A-Za-z]:[\\/]/.test(value) || /^\/(?:workspace|home|root|tmp)\//.test(value))) {
    return path.basename(value.replace(/\\/g, "/"));
  }
  return value;
}

export function listLocalResults(): LocalResultSummary[] {
  const config = loadLocalResultsConfig();
  const results = new Map<string, LocalResultSummary>();
  for (const libraryDir of [config.libraryDir, ...config.legacyLibraryDirs]) {
    if (!existsSync(libraryDir)) continue;
    for (const date of readdirSync(libraryDir)) {
      if (!DATE_PATTERN.test(date)) continue;
      const dateDir = path.join(libraryDir, date);
      if (!statSync(dateDir).isDirectory()) continue;

      for (const jobId of readdirSync(dateDir)) {
        if (!JOB_ID_PATTERN.test(jobId) || results.has(jobId)) continue;
        const paths = buildLocalJobPaths(libraryDir, date, jobId);
        assertInsideLibrary(libraryDir, paths.jobDir);
        const hasVideo = existsSync(paths.outputWithAudioPath) || existsSync(paths.videoPath);
        const hasThumbnail = existsSync(paths.thumbnailPath);
        results.set(jobId, {
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
  }

  return [...results.values()].sort((left, right) => right.date.localeCompare(left.date));
}

export function findLocalResultFile(jobId: string, kind: "video" | "thumbnail") {
  assertSafeJobId(jobId);
  const config = loadLocalResultsConfig();
  for (const libraryDir of [config.libraryDir, ...config.legacyLibraryDirs]) {
    if (!existsSync(libraryDir)) continue;
    for (const date of readdirSync(libraryDir)) {
      if (!DATE_PATTERN.test(date)) continue;
      const paths = buildLocalJobPaths(libraryDir, date, jobId);
      const filePath = kind === "video"
        ? (existsSync(paths.outputWithAudioPath) ? paths.outputWithAudioPath : paths.videoPath)
        : paths.thumbnailPath;
      assertInsideLibrary(libraryDir, filePath);
      if (existsSync(filePath)) {
        return { filePath, stat: statSync(filePath) };
      }
    }
  }

  return null;
}

export function listLocalImageResults(): LocalImageResultSummary[] {
  const config = loadLocalImageResultsConfig();
  const results = new Map<string, LocalImageResultSummary>();
  for (const libraryDir of [config.libraryDir, ...config.legacyLibraryDirs]) {
    if (!existsSync(libraryDir)) continue;
    for (const date of readdirSync(libraryDir)) {
      if (!DATE_PATTERN.test(date)) continue;
      const dateDir = path.join(libraryDir, date);
      if (!statSync(dateDir).isDirectory()) continue;
      for (const sessionId of readdirSync(dateDir)) {
        if (!JOB_ID_PATTERN.test(sessionId) || results.has(sessionId)) continue;
        const paths = buildLocalImagePaths(libraryDir, date, sessionId);
        assertInsideLibrary(libraryDir, paths.sessionDir);
        if (existsSync(paths.imagePath)) {
          results.set(sessionId, { sessionId, date, metadata: readMetadata(paths.metadataPath), imageUrl: `/api/local-lab/image-results/${encodeURIComponent(sessionId)}` });
        }
      }
    }
  }
  return [...results.values()].sort((left, right) => right.date.localeCompare(left.date));
}

export function findLocalImageResultFile(sessionId: string) {
  assertSafeJobId(sessionId);
  const config = loadLocalImageResultsConfig();
  for (const libraryDir of [config.libraryDir, ...config.legacyLibraryDirs]) {
    if (!existsSync(libraryDir)) continue;
    for (const date of readdirSync(libraryDir)) {
      if (!DATE_PATTERN.test(date)) continue;
      const paths = buildLocalImagePaths(libraryDir, date, sessionId);
      assertInsideLibrary(libraryDir, paths.imagePath);
      if (existsSync(paths.imagePath)) return { filePath: paths.imagePath, stat: statSync(paths.imagePath) };
    }
  }
  return null;
}
