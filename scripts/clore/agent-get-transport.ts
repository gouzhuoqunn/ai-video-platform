export type AgentTransportDiagnostic = {
  route: string;
  stage: string | null;
  attempt: number;
  httpStatus: number | null;
  errorName: string | null;
  causeCode: string | null;
  message: string;
  timestamp: string;
};

export type AgentGetSuccess = { ok: true; body: Record<string, unknown>; status: number };
export type AgentGetTransient = { ok: false; diagnostic: AgentTransportDiagnostic };
export type AgentGetResult = AgentGetSuccess | AgentGetTransient;

const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "EAI_AGAIN", "ECONNABORTED"]);

function endpointRoute(endpoint: string, route: string) { return `${endpoint.replace(/\/$/, "")}${route}`; }

function clean(value: unknown) {
  return String(value instanceof Error ? value.message : value ?? "agent_get_failed")
    .replace(/(bearer\s+)[^\s]+/gi, "$1<redacted>")
    .replace(/([?&](?:x-amz-|signature|token|credential)[^=&]*=)[^&\s]+/gi, "$1<redacted>")
    .slice(0, 300);
}

function nestedCode(error: unknown) {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : typeof candidate?.cause?.code === "string" ? candidate.cause.code : null;
  return code && /^[A-Z0-9_]+$/i.test(code) ? code : null;
}

function transientError(error: unknown) {
  const message = clean(error);
  const code = nestedCode(error);
  return error instanceof TypeError || Boolean(code && TRANSIENT_CODES.has(code)) || /fetch failed|premature close|socket|tls|timeout|econnreset|eai_again/i.test(message);
}

export class AgentGetTerminalError extends Error {
  readonly diagnostic: AgentTransportDiagnostic;
  constructor(diagnostic: AgentTransportDiagnostic) { super(`agent_get_terminal:${diagnostic.route}:${diagnostic.httpStatus ?? diagnostic.errorName ?? "unknown"}`); this.diagnostic = diagnostic; }
}

/** Performs exactly one safe GET attempt. The stage poller owns the bounded retry schedule. */
export async function agentGetJsonWithRetry(input: {
  endpoint: string;
  token: string;
  route: string;
  stage?: string | null;
  attempt: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  timestamp?: () => string;
}): Promise<AgentGetResult> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const timestamp = input.timestamp ?? (() => new Date().toISOString());
  const diagnostic = (patch: Omit<AgentTransportDiagnostic, "route" | "stage" | "attempt" | "timestamp">): AgentTransportDiagnostic => ({ route: input.route, stage: input.stage ?? null, attempt: input.attempt, timestamp: timestamp(), ...patch });
  try {
    const response = await (input.fetchImpl ?? fetch)(endpointRoute(input.endpoint, input.route), { method: "GET", headers: { Authorization: `Bearer ${input.token}` }, signal: controller.signal });
    if (TRANSIENT_HTTP.has(response.status)) return { ok: false, diagnostic: diagnostic({ httpStatus: response.status, errorName: null, causeCode: null, message: `agent_http_${response.status}` }) };
    if (!response.ok) throw new AgentGetTerminalError(diagnostic({ httpStatus: response.status, errorName: null, causeCode: null, message: `agent_http_${response.status}` }));
    try {
      const body = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_agent_json");
      return { ok: true, body: body as Record<string, unknown>, status: response.status };
    } catch (error) {
      throw new AgentGetTerminalError(diagnostic({ httpStatus: response.status, errorName: error instanceof Error ? error.name : "Error", causeCode: nestedCode(error), message: "invalid_agent_json" }));
    }
  } catch (error) {
    if (error instanceof AgentGetTerminalError) throw error;
    const timedOut = controller.signal.aborted;
    const message = timedOut ? "agent_get_timeout" : clean(error);
    const errorName = timedOut ? "AbortError" : error instanceof Error ? error.name : "Error";
    const causeCode = timedOut ? "ETIMEDOUT" : nestedCode(error);
    if (timedOut || transientError(error)) return { ok: false, diagnostic: diagnostic({ httpStatus: null, errorName, causeCode, message }) };
    throw new AgentGetTerminalError(diagnostic({ httpStatus: null, errorName, causeCode, message }));
  } finally {
    clearTimeout(timeout);
  }
}
