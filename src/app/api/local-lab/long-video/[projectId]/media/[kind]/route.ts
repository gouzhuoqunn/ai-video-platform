import { existsSync, readFileSync, statSync } from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import { buildLongVideoAttemptPaths, buildLongVideoProjectPaths, loadLongVideoLibraryDir } from "@/lib/long-video/media";
import { getLongVideoProject } from "@/lib/long-video/store";

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; kind: string }> }) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  const { projectId, kind } = await context.params;
  const project = getLongVideoProject(projectId);
  if (!project) return NextResponse.json({ error: "长视频媒体不存在。" }, { status: 404 });
  const paths = buildLongVideoProjectPaths(loadLongVideoLibraryDir(), project.createdAt.slice(0, 10), project.id);
  let filePath: string;
  let contentType: string;
  let isVideo = false;
  if (kind === "video" || kind === "thumbnail") {
    if (project.status !== "completed") return NextResponse.json({ error: "长视频媒体不存在。" }, { status: 404 });
    filePath = kind === "video" ? paths.finalVideo : paths.finalThumbnail;
    contentType = kind === "video" ? "video/mp4" : "image/jpeg";
    isVideo = kind === "video";
  } else if (["segment-video", "segment-thumbnail", "segment-last-frame"].includes(kind)) {
    const sequenceIndex = Number(new URL(request.url).searchParams.get("sequence"));
    const requestedAttempt = new URL(request.url).searchParams.get("attempt");
    const segment = project.segments.find((candidate) => candidate.sequenceIndex === sequenceIndex);
    const attemptId = requestedAttempt ?? segment?.selectedAttemptId;
    const attempt = segment?.attempts.find((candidate) => candidate.id === attemptId);
    if (!segment || !attempt || !attemptId || !/^[a-f0-9-]{36}$/.test(attemptId)) return NextResponse.json({ error: "长视频分段媒体不存在。" }, { status: 404 });
    const attemptPaths = buildLongVideoAttemptPaths(paths.projectDir, sequenceIndex, attemptId);
    filePath = kind === "segment-video" ? attemptPaths.outputMp4 : kind === "segment-thumbnail" ? attemptPaths.thumbnail : attemptPaths.lastFrame;
    contentType = kind === "segment-video" ? "video/mp4" : kind === "segment-thumbnail" ? "image/jpeg" : "image/png";
    isVideo = kind === "segment-video";
  } else return NextResponse.json({ error: "长视频媒体类型无效。" }, { status: 404 });
  if (!existsSync(filePath)) return NextResponse.json({ error: "长视频媒体不存在。" }, { status: 404 });
  const size = statSync(filePath).size;
  const range = isVideo ? request.headers.get("range") : null;
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const boundedEnd = Math.min(end, size - 1);
    const body = readFileSync(filePath).subarray(start, boundedEnd + 1);
    return new NextResponse(body, { status: 206, headers: { "content-type": contentType, "content-length": String(body.byteLength), "content-range": `bytes ${start}-${boundedEnd}/${size}`, "accept-ranges": "bytes", "cache-control": "private, max-age=30" } });
  }
  return new NextResponse(readFileSync(filePath), { headers: { "content-type": contentType, "content-length": String(size), "cache-control": "private, max-age=30", "accept-ranges": isVideo ? "bytes" : "none" } });
}
