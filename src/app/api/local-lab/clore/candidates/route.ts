import { NextResponse, type NextRequest } from "next/server";
import { getLocalLabCloreCandidates } from "@/lib/local-lab/clore-console";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;

  try {
    return NextResponse.json(await getLocalLabCloreCandidates());
  } catch {
    return NextResponse.json({ error: "Clore candidates are temporarily unavailable. No order was created." }, { status: 500 });
  }
}
