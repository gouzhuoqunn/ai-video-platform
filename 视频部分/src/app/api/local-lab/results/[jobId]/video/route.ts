import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { findLocalResultFile } from "@/lib/local-lab/local-results";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";

export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;

  try {
    const { jobId } = await context.params;
    const localFile = findLocalResultFile(jobId, "video");
    if (!localFile) {
      return NextResponse.json({ error: "Video not found." }, { status: 404 });
    }

    const range = request.headers.get("range");
    const size = localFile.stat.size;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      }

      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= size || start > end) {
        return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      }

      return new NextResponse(Readable.toWeb(createReadStream(localFile.filePath, { start, end })) as BodyInit, {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${size}`,
          "content-type": "video/mp4",
          "cache-control": "private, max-age=30",
        },
      });
    }

    return new NextResponse(Readable.toWeb(createReadStream(localFile.filePath)) as BodyInit, {
      headers: {
        "accept-ranges": "bytes",
        "content-length": String(size),
        "content-type": "video/mp4",
        "cache-control": "private, max-age=30",
      },
    });
  } catch {
    return NextResponse.json({ error: "Invalid video request." }, { status: 400 });
  }
}
