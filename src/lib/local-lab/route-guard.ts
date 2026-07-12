import { NextResponse, type NextRequest } from "next/server";
import { isLocalLabServerEnabled, isLoopbackHost, normalizeHost } from "@/lib/local-lab/host";

export function guardLocalLabRequest(request: NextRequest) {
  if (!isLocalLabServerEnabled()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (!isLoopbackHost(request.headers.get("host"))) {
    return NextResponse.json({ error: "local_lab only allows localhost or 127.0.0.1." }, { status: 403 });
  }

  return null;
}

export function guardLocalLabMutation(request: NextRequest) {
  const baseGuard = guardLocalLabRequest(request);
  if (baseGuard) {
    return baseGuard;
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const requestHost = normalizeHost(request.headers.get("host"));
  const source = origin || referer;

  if (!source) {
    return NextResponse.json({ error: "Missing same-origin header." }, { status: 403 });
  }

  try {
    const sourceHost = normalizeHost(new URL(source).host);
    if (sourceHost !== requestHost || !isLoopbackHost(sourceHost)) {
      return NextResponse.json({ error: "Same-origin check failed." }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid same-origin header." }, { status: 403 });
  }

  return null;
}
