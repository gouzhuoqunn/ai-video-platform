export function isLocalLabServerEnabled() {
  return process.env.LOCAL_LAB_ENABLED === "true";
}

export function normalizeHost(host: string | null) {
  return (host ?? "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
}

export function isLoopbackHost(host: string | null) {
  const normalized = normalizeHost(host);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
