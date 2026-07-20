import { NextResponse, type NextRequest } from "next/server";
import { getLocalLabCloreCandidates } from "@/lib/local-lab/clore-console";
import { guardLocalLabRequest } from "@/lib/local-lab/route-guard";

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;

  try {
    const manualSilent4090 = request.nextUrl.searchParams.get("queue") === "manual_silent_4090";
    if (process.env.NODE_ENV !== "production" && request.nextUrl.searchParams.get("mock") === "1") {
      const mockGpu = manualSilent4090 ? "NVIDIA GeForce RTX 4090" : "NVIDIA GeForce RTX 5090";
      return NextResponse.json({
        mode: "local-visual-mock",
        source: "safe local mock fixture",
        wallet: { available_usd_balance: 15.03, source: "mock" },
        matches: [
          {
            server_id: "mock-rtx5090-visual",
            gpu: mockGpu,
            gpu_count: 1,
            gpu_memory_gb: 32,
            gpu_memory_raw_value: 32,
            gpu_memory_raw_unit: "GB",
            ram_gb: 128,
            cpu_cores: 24,
            disk_gb: 800,
            download_mbps: 1200,
            upload_mbps: 600,
            reliability: 0.995,
            rating: 4.9,
            rating_count: 21,
            country: "US",
            normalized_usd_per_hour: 0.3,
            base_usd_per_hour: 0.3,
            effective_usd_per_hour: 0.315,
            creation_fee_usd: 0.1,
            max_session_projected_total_usd: 2.095,
            original_on_demand_price: "7.2 USD/day",
            currently_rentable: true,
            risk_tier: "A",
            rejection_reasons: [],
          },
        ],
        raw_response_included: false,
        order_created: false,
        create_order_called: false,
      });
    }
    return NextResponse.json(await getLocalLabCloreCandidates(manualSilent4090 ? "manual_silent_4090" : "default"));
  } catch {
    return NextResponse.json({ error: "Clore candidates are temporarily unavailable. No order was created." }, { status: 500 });
  }
}
