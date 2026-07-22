import { NextResponse, type NextRequest } from "next/server";
import { confirmOrderPlan } from "@/lib/local-lab/clore-console";
import { guardLocalLabMutation } from "@/lib/local-lab/route-guard";

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;

  const payload = (await request.json().catch(() => ({}))) as {
    nonce?: string;
    serverId?: string;
    maxPriceUsdPerHour?: number;
    confirmationText?: string;
    riskAccepted?: boolean;
    queuedJobCount?: number;
  };

  try {
    const result = await confirmOrderPlan({
      nonce: payload.nonce ?? "",
      serverId: payload.serverId ?? "",
      maxPriceUsdPerHour: Number(payload.maxPriceUsdPerHour),
      confirmationText: payload.confirmationText ?? "",
      riskAccepted: payload.riskAccepted === true,
      queuedJobCount: Number(payload.queuedJobCount ?? 0),
    });

    return NextResponse.json(result, { status: result.order_created ? 200 : result.status === "blocked_by_environment" ? 423 : 501 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Order confirmation rejected." }, { status: 400 });
  }
}
