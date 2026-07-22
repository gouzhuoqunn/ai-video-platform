import { NextResponse, type NextRequest } from "next/server";
import { listAutorentRequests } from "@/lib/local-lab/autorent";
import { armGenerationPool, generationPoolSummary } from "@/lib/generation/task-pool";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

async function getUser() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { userId: null, error: "Supabase is not configured." };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { userId: user?.id ?? null, error: user ? null : "Please restore the local lab session first." };
}

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;

  const { userId, error } = await getUser();
  if (!userId) return NextResponse.json({ error }, { status: 401 });

  return NextResponse.json({
    requests: await listAutorentRequests(userId),
    create_order_called: false,
    real_clore_create_enabled: process.env.CLORE_AUTORENT_ENABLED === "true",
  });
}

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;

  const { userId, error } = await getUser();
  if (!userId) return NextResponse.json({ error }, { status: 401 });

  const armed = armGenerationPool();
  return NextResponse.json({
    note: armed.armed ? "调度批次已持久化；部署暂停期间只观察市场，不会创建订单。" : armed.reason,
    scheduler_armed: armed.armed,
    reused_persisted_batch: armed.reusedPersistedBatch,
    pool: generationPoolSummary(armed.state),
    create_order_called: false,
  });
}
