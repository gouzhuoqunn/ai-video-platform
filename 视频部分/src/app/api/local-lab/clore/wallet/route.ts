import { NextResponse, type NextRequest } from "next/server";
import { getLocalLabWallet } from "@/lib/local-lab/clore-console";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;

  try {
    return NextResponse.json(await getLocalLabWallet());
  } catch {
    return NextResponse.json({ error: "Clore wallet is temporarily unavailable. No balance change was made." }, { status: 500 });
  }
}
