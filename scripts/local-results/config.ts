import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_LOCAL_VIDEO_LIBRARY_DIR = "D:\\AI-Video-Library";
export const DEFAULT_LOCAL_IMAGE_LIBRARY_DIR = "D:\\AI-Creative-Library";

export type LocalResultsConfig = {
  libraryDir: string;
  minRemoteRetentionHours: number;
};

export function loadLocalResultsConfig(): LocalResultsConfig {
  return {
    libraryDir: process.env.LOCAL_VIDEO_LIBRARY_DIR?.trim() || DEFAULT_LOCAL_VIDEO_LIBRARY_DIR,
    minRemoteRetentionHours: Number(process.env.LOCAL_RESULTS_MIN_REMOTE_RETENTION_HOURS ?? 24),
  };
}

export function buildLocalJobPaths(libraryDir: string, date: string, jobId: string) {
  const jobDir = path.join(libraryDir, date, jobId);
  return {
    jobDir,
    sourceWebmPath: path.join(jobDir, "source.webm"),
    videoPath: path.join(jobDir, "output.mp4"),
    partialVideoPath: path.join(jobDir, "output.mp4.part"),
    metadataPath: path.join(jobDir, "metadata.json"),
    thumbnailPath: path.join(jobDir, "thumbnail.jpg"),
    workflowPath: path.join(jobDir, "workflow-api.json"),
    runtimeEvidencePath: path.join(jobDir, "runtime-evidence.json"),
    providerSessionPath: path.join(jobDir, "provider-session.json"),
    restoreEvidencePath: path.join(jobDir, "restore-evidence.json"),
  };
}

export function buildLocalImagePaths(libraryDir: string, date: string, sessionId: string) {
  const sessionDir = path.join(libraryDir, date, sessionId);
  return {
    sessionDir,
    imagePath: path.join(sessionDir, "output.png"),
    thumbnailPath: path.join(sessionDir, "thumbnail.jpg"),
    metadataPath: path.join(sessionDir, "metadata.json"),
    workflowPath: path.join(sessionDir, "workflow-api.json"),
    evidencePath: path.join(sessionDir, "runtime-evidence.json"),
    providerSessionPath: path.join(sessionDir, "provider-session.json"),
    restoreEvidencePath: path.join(sessionDir, "restore-evidence.json"),
  };
}

export function loadLocalImageResultsConfig() {
  return {
    libraryDir: process.env.LOCAL_IMAGE_LIBRARY_DIR?.trim() || DEFAULT_LOCAL_IMAGE_LIBRARY_DIR,
  };
}

export function writeJsonAtomic(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.part`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
}
