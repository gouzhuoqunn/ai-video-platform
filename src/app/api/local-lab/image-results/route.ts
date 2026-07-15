import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import { listLocalImageResults } from "@/lib/local-lab/local-results";

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  const statePath = path.join(process.cwd(), ".secrets", "first-image-state.json");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) as { session_id?: string; completed?: string[] } : null;
  return NextResponse.json({
    results: listLocalImageResults(),
    pending: state ? { sessionId: state.session_id ?? "first-image", completedStages: state.completed ?? [], status: state.completed?.includes("image_generated") ? "completed" : "pending" } : null,
  });
}
