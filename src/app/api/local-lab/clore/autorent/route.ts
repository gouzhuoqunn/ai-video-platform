import { NextResponse, type NextRequest } from "next/server";
import { advanceMockAutorentRequests, listAutorentRequests } from "@/lib/local-lab/autorent";
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

  return NextResponse.json(await advanceMockAutorentRequests(userId));
}
