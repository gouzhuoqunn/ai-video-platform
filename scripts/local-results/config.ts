import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildImageMediaPaths,
  buildShortVideoMediaPaths,
  getLocalDataPaths,
  getLocalMediaReadRoots,
  LEGACY_LOCAL_IMAGE_LIBRARY_DIR,
  LEGACY_LOCAL_VIDEO_LIBRARY_DIR,
} from "../../src/lib/local-data/path-registry";

export const DEFAULT_LOCAL_VIDEO_LIBRARY_DIR = LEGACY_LOCAL_VIDEO_LIBRARY_DIR;
export const DEFAULT_LOCAL_IMAGE_LIBRARY_DIR = LEGACY_LOCAL_IMAGE_LIBRARY_DIR;

export type LocalResultsConfig = {
  libraryDir: string;
  legacyLibraryDirs: string[];
  minRemoteRetentionHours: number;
};

export function loadLocalResultsConfig(): LocalResultsConfig {
  const roots = getLocalMediaReadRoots();
  return {
    libraryDir: getLocalDataPaths().videoMediaRoot,
    legacyLibraryDirs: roots.videoRoots.filter((root) => root !== getLocalDataPaths().videoMediaRoot),
    minRemoteRetentionHours: Number(process.env.LOCAL_RESULTS_MIN_REMOTE_RETENTION_HOURS ?? 24),
  };
}

export function buildLocalJobPaths(libraryDir: string, date: string, jobId: string) {
  return buildShortVideoMediaPaths(libraryDir, date, jobId);
}

export function buildLocalImagePaths(libraryDir: string, date: string, sessionId: string) {
  return buildImageMediaPaths(libraryDir, date, sessionId);
}

export function loadLocalImageResultsConfig() {
  const roots = getLocalMediaReadRoots();
  return {
    libraryDir: getLocalDataPaths().imageMediaRoot,
    legacyLibraryDirs: roots.imageRoots.filter((root) => root !== getLocalDataPaths().imageMediaRoot),
  };
}

export function writeJsonAtomic(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.part`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
}
