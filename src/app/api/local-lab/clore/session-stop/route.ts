import { NextResponse, type NextRequest } from "next/server";
import { stopLocalLabSessionDryRun } from "@/lib/local-lab/clore-console";
import { guardLocalLabMutation } from "@/lib/local-lab/route-guard";

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;

  try {
    return NextResponse.json(stopLocalLabSessionDryRun());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to stop session." }, { status: 409 });
  }
}
