import { NextResponse, type NextRequest } from "next/server";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import { readLongVideoUpload } from "@/lib/long-video/uploads";

export async function GET(request: NextRequest, context: { params: Promise<{ uploadId: string }> }) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  const upload = readLongVideoUpload((await context.params).uploadId);
  if (!upload) return NextResponse.json({ error: "首帧图片不存在。" }, { status: 404 });
  return new NextResponse(upload.bytes, {
    headers: { "content-type": upload.mime, "content-length": String(upload.sizeBytes), "cache-control": "private, max-age=60" },
  });
}
