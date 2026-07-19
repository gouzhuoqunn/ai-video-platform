import "server-only";

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { findLocalImageResultFile, findLocalResultFile } from "@/lib/local-lab/local-results";
import { getLocalMediaReadRoots } from "@/lib/local-data/path-registry";
import { buildLongVideoAttemptPaths, resolveLongVideoProjectPaths } from "@/lib/long-video/media";
import { getLongVideoProject } from "@/lib/long-video/store";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_ID_PATTERN = /^[A-Za-z0-9_-]{6,120}$/;

export type LocalFolderAssetIdentity =
  | { kind: "image"; sessionId: string }
  | { kind: "short-video"; jobId: string }
  | { kind: "long-video"; projectId: string }
  | { kind: "long-video-segment"; projectId: string; sequenceIndex: number; attemptId: string };

function assertLocalId(value: string) {
  if (!LOCAL_ID_PATTERN.test(value)) throw new Error("本地媒体编号无效。");
}

function assertUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new Error("长视频编号无效。");
}

function allowedRoots() {
  const roots = getLocalMediaReadRoots();
  return [...roots.imageRoots, ...roots.videoRoots].filter(existsSync);
}

export function assertApprovedLocalMediaFile(filePath: string, roots = allowedRoots()) {
  if (!existsSync(filePath)) throw new Error("本地媒体不存在。");
  const realFile = realpathSync.native(filePath);
  for (const root of roots) {
    const realRoot = realpathSync.native(root);
    const relative = path.relative(realRoot, realFile);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return realFile;
  }
  throw new Error("本地媒体路径不在允许目录内。");
}

export function resolveLocalFolderAsset(identity: LocalFolderAssetIdentity) {
  if (identity.kind === "image") {
    assertLocalId(identity.sessionId);
    return findLocalImageResultFile(identity.sessionId)?.filePath ?? null;
  }
  if (identity.kind === "short-video") {
    assertLocalId(identity.jobId);
    return findLocalResultFile(identity.jobId, "video")?.filePath ?? null;
  }

  assertUuid(identity.projectId);
  const project = getLongVideoProject(identity.projectId);
  if (!project) return null;
  const paths = resolveLongVideoProjectPaths(project);
  if (identity.kind === "long-video") {
    const candidate = existsSync(paths.finalVideoWithAudio) ? paths.finalVideoWithAudio : paths.finalVideo;
    return existsSync(candidate) ? candidate : null;
  }

  if (!Number.isInteger(identity.sequenceIndex) || identity.sequenceIndex < 0) throw new Error("长视频分段编号无效。");
  assertUuid(identity.attemptId);
  const segment = project.segments.find((value) => value.sequenceIndex === identity.sequenceIndex);
  if (!segment?.attempts.some((attempt) => attempt.id === identity.attemptId)) return null;
  const attemptPaths = buildLongVideoAttemptPaths(paths.projectDir, identity.sequenceIndex, identity.attemptId);
  const candidate = existsSync(attemptPaths.outputWithAudio) ? attemptPaths.outputWithAudio : attemptPaths.outputMp4;
  return existsSync(candidate) ? candidate : null;
}

export async function openLocalFolderAsset(identity: LocalFolderAssetIdentity, platform = process.platform) {
  if (platform !== "win32") throw new Error("仅支持在 Windows 本地打开文件夹。");
  const filePath = resolveLocalFolderAsset(identity);
  if (!filePath) throw new Error("当前没有可打开的本地媒体文件。");
  const approvedPath = assertApprovedLocalMediaFile(filePath);
  await new Promise<void>((resolve, reject) => {
    execFile("explorer.exe", ["/select,", approvedPath], { windowsHide: true }, (error) => error ? reject(error) : resolve());
  });
}
