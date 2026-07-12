import { NextResponse, type NextRequest } from "next/server";
import { getLocalLabSessionSummary } from "@/lib/local-lab/clore-console";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;

  return NextResponse.json(getLocalLabSessionSummary());
}
