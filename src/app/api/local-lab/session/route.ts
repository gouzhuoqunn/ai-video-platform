import { NextResponse, type NextRequest } from "next/server";
import { readLocalLabCredentials } from "@/lib/local-lab/config";
import { isLocalLabServerEnabled, isLoopbackHost } from "@/lib/local-lab/host";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  if (!isLocalLabServerEnabled()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (!isLoopbackHost(request.headers.get("host"))) {
    return NextResponse.json({ error: "本地实验模式禁止远程访问。" }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase 尚未配置。" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    return NextResponse.json({ ok: true, alreadySignedIn: true });
  }

  try {
    const credentials = readLocalLabCredentials();
    const { error } = await supabase.auth.signInWithPassword({
      email: credentials.email,
      password: credentials.password,
    });

    if (error) {
      return NextResponse.json({ error: "本地测试账号登录失败。请重新运行 npm run local-lab:setup -- --reset。" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, alreadySignedIn: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "本地实验账号配置无效。" }, { status: 500 });
  }
}

export async function GET() {
  if (!isLocalLabServerEnabled()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({ error: "Use POST." }, { status: 405 });
}
