import { NextResponse, type NextRequest } from "next/server";
import { cancelAutorentRequest } from "@/lib/local-lab/autorent";
import { guardLocalLabMutation } from "@/lib/local-lab/route-guard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = {
  params: Promise<{ requestId: string }>;
};

export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;

  const { requestId } = await context.params;
  if (!UUID_PATTERN.test(requestId)) {
    return NextResponse.json({ error: "Invalid auto-rent request id." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 500 });
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Please restore the local lab session first." }, { status: 401 });
  }

  const result = await cancelAutorentRequest(user.id, requestId);
  return NextResponse.json({ cancelled: Boolean(result), request: result, create_order_called: false });
}
