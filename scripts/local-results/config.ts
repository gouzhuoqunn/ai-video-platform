import path from "node:path";

export const DEFAULT_LOCAL_VIDEO_LIBRARY_DIR = "D:\\AI-Video-Library";

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
    videoPath: path.join(jobDir, "output.mp4"),
    partialVideoPath: path.join(jobDir, "output.mp4.part"),
    metadataPath: path.join(jobDir, "metadata.json"),
    thumbnailPath: path.join(jobDir, "thumbnail.jpg"),
  };
}
