import { readFileSync } from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { findLocalResultFile } from "@/lib/local-lab/local-results";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";

export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;

  try {
    const { jobId } = await context.params;
    const localFile = findLocalResultFile(jobId, "thumbnail");
    if (!localFile) {
      return NextResponse.json({ error: "Thumbnail not found." }, { status: 404 });
    }

    return new NextResponse(readFileSync(localFile.filePath), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=30",
      },
    });
  } catch {
    return NextResponse.json({ error: "Invalid thumbnail request." }, { status: 400 });
  }
}
