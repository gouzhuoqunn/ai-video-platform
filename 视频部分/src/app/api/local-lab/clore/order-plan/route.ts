import { NextResponse, type NextRequest } from "next/server";
import { createOrderPlan } from "@/lib/local-lab/clore-console";
import { guardLocalLabMutation } from "@/lib/local-lab/route-guard";

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;

  const payload = (await request.json().catch(() => ({}))) as {
    serverId?: string;
    maxPriceUsdPerHour?: number;
  };

  try {
    return NextResponse.json(createOrderPlan(payload.serverId ?? "", Number(payload.maxPriceUsdPerHour)));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create order plan." }, { status: 400 });
  }
}
