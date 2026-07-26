import { readFileSync } from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { localArtifactFile, verifyPublishedLocalImageArtifact, type LocalArtifactReference } from "@/lib/image-generation/local-image-artifacts";
import { readImageTask } from "@/lib/image-generation/local-image-task-store";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";

export const dynamic = "force-dynamic";

function artifactReference(value: unknown): LocalArtifactReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  return typeof result.relativeDir === "string" && typeof result.pngSha256 === "string" && typeof result.pngBytes === "number" && typeof result.width === "number" && typeof result.height === "number" && typeof result.completedAt === "string"
    ? result as LocalArtifactReference
    : null;
}

export async function GET(request: NextRequest, context: { params: Promise<{ taskId: string; kind: string }> }) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  const { taskId, kind } = await context.params;
  if (kind !== "output" && kind !== "thumbnail") return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const task = readImageTask(taskId);
    const artifact = artifactReference(task?.result);
    if (!task || task.status !== "completed" || !artifact) return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
    await verifyPublishedLocalImageArtifact({ taskId, artifact });
    const bytes = readFileSync(localArtifactFile({ taskId, artifact, kind }));
    return new NextResponse(bytes, { headers: { "content-type": kind === "output" ? "image/png" : "image/webp", "content-length": String(bytes.length), "cache-control": "private, max-age=60, no-transform", "x-content-type-options": "nosniff" } });
  } catch {
    return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
  }
}
