import { NextResponse, type NextRequest } from "next/server";
import { listLocalResults } from "@/lib/local-lab/local-results";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;

  return NextResponse.json({
    results: listLocalResults(),
    absolute_paths_included: false,
  });
}
