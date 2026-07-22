import { readFileSync } from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { findLocalImageResultFile } from "@/lib/local-lab/local-results";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";

export async function GET(request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  try {
    const { sessionId } = await context.params;
    const image = findLocalImageResultFile(sessionId);
    if (!image) return NextResponse.json({ error: "Image not found." }, { status: 404 });
    return new NextResponse(readFileSync(image.filePath), { headers: { "content-type": "image/png", "cache-control": "private, max-age=30" } });
  } catch {
    return NextResponse.json({ error: "Invalid image request." }, { status: 400 });
  }
}
