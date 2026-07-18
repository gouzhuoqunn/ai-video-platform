import { NextResponse, type NextRequest } from "next/server";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import { getBillingAggregate } from "@/lib/local-lab/billing";

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  try {
    return NextResponse.json(await getBillingAggregate(request.nextUrl.searchParams.get("refresh") === "1"));
  } catch {
    return NextResponse.json({ error: "费用信息暂时不可用，未执行任何计费操作。" }, { status: 503 });
  }
}
