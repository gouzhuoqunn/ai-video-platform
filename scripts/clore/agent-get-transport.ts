import { createHash } from "node:crypto";

export type AgentResponseKind = "empty" | "html" | "invalid_json" | "wrong_schema" | "oversized";
export type AgentTransportDiagnostic = {
  route: string;
  stage: string | null;
  attempt: number;
  httpStatus: number | null;
  errorName: string | null;
  causeCode: string | null;
  message: string;
  timestamp: string;
  responseKind?: AgentResponseKind;
  contentType?: string | null;
  contentLength?: number | null;
  bodySha256?: string;
  bodyPreview?: string;
};

export type AgentGetSuccess = { ok: true; body: Record<string, unknown>; status: number };
export type AgentGetTransient = { ok: false; diagnostic: AgentTransportDiagnostic };
export type AgentGetResult = AgentGetSuccess | AgentGetTransient;
export type AgentResponseValidator = (body: Record<string, unknown>) => boolean;

const MAX_BODY_BYTES = 1024 * 1024;
const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "EAI_AGAIN", "ECONNABORTED"]);
const OBJECT = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const agentStatusResponse: AgentResponseValidator = (body) => body.alive === true && typeof body.current_stage === "string" && OBJECT(body.stages) && OBJECT(body.models) && (body.last_error === null || typeof body.last_error === "string");
export const agentHealthResponse: AgentResponseValidator = (body) => body.alive === true && body.agent === "restricted-clore-diagnostic" && typeof body.current_stage === "string";
export function agentArtifactMetadataResponse(taskId: string): AgentResponseValidator {
  return (body) => body.task_id === taskId && Number.isSafeInteger(body.width) && Number(body.width) > 0 && Number.isSafeInteger(body.height) && Number(body.height) > 0 && Number.isSafeInteger(body.byte_size) && Number(body.byte_size) > 0 && typeof body.sha256 === "string" && /^[a-f0-9]{64}$/i.test(body.sha256);
}

function endpointRoute(endpoint: string, route: string, attempt: number) {
  const suffix = route === "/status" || route === "/healthz" ? `?poll_attempt=${Math.max(1, Math.floor(attempt))}` : "";
  return `${endpoint.replace(/\/$/, "")}${route}${suffix}`;
}

function clean(value: unknown, limit = 300) {
  return String(value instanceof Error ? value.message : value ?? "agent_get_failed")
    .replace(/(bearer\s+)[^\s]+/gi, "$1<redacted>")
    .replace(/([?&](?:x-amz-|signature|token|credential)[^=&]*)=[^&\s]+/gi, "$1=<redacted>")
    .slice(0, limit);
}

function cleanBodyPreview(value: string, endpoint: string) {
  let preview = clean(value, 160);
  try {
    const parsed = new URL(endpoint);
    preview = preview.replaceAll(endpoint, "<redacted-endpoint>").replaceAll(parsed.host, "<redacted-host>");
  } catch { preview = preview.replaceAll(endpoint, "<redacted-endpoint>"); }
  return preview;
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

async function boundedText(response: Response, advertisedLength: number | null) {
  if (advertisedLength !== null && advertisedLength > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return { oversized: true, bytes: Buffer.alloc(0), text: "" };
  }
  const reader = response.body?.getReader();
  if (!reader) return { oversized: false, bytes: Buffer.alloc(0), text: "" };
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = MAX_BODY_BYTES - total;
      if (next.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(next.value.slice(0, remaining));
        await reader.cancel().catch(() => undefined);
        const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        return { oversized: true, bytes, text: new TextDecoder().decode(bytes) };
      }
      chunks.push(next.value); total += next.value.byteLength;
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { oversized: false, bytes, text: new TextDecoder().decode(bytes) };
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
  validator: AgentResponseValidator;
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
    const response = await (input.fetchImpl ?? fetch)(endpointRoute(input.endpoint, input.route, input.attempt), { method: "GET", headers: { Authorization: `Bearer ${input.token}`, "Cache-Control": "no-cache, no-store", Pragma: "no-cache", Accept: "application/json" }, signal: controller.signal });
    if (TRANSIENT_HTTP.has(response.status)) return { ok: false, diagnostic: diagnostic({ httpStatus: response.status, errorName: null, causeCode: null, message: `agent_http_${response.status}` }) };
    if (response.status !== 200) throw new AgentGetTerminalError(diagnostic({ httpStatus: response.status, errorName: null, causeCode: null, message: `agent_http_${response.status}` }));
    const contentType = response.headers.get("content-type");
    const rawLength = response.headers.get("content-length"); const parsedLength = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
    const bounded = await boundedText(response, parsedLength);
    const bodySha256 = createHash("sha256").update(bounded.bytes).digest("hex");
    let responseKind: AgentResponseKind | null = null; let body: Record<string, unknown> | null = null;
    if (bounded.oversized) responseKind = "oversized";
    else if (!bounded.text) responseKind = "empty";
    else if (/\btext\/html\b/i.test(contentType ?? "")) responseKind = "html";
    else {
      try {
        const parsed: unknown = JSON.parse(bounded.text);
        if (!OBJECT(parsed) || !input.validator(parsed)) responseKind = "wrong_schema";
        else body = parsed;
      } catch { responseKind = "invalid_json"; }
    }
    if (body) return { ok: true, body, status: response.status };
    return { ok: false, diagnostic: diagnostic({ httpStatus: response.status, errorName: null, causeCode: null, message: "agent_proxy_non_agent_response", responseKind: responseKind ?? "wrong_schema", contentType: contentType ? clean(contentType, 200) : null, contentLength: parsedLength, bodySha256, bodyPreview: cleanBodyPreview(bounded.text, input.endpoint) }) };
  } catch (error) {
    if (error instanceof AgentGetTerminalError) throw error;
    const timedOut = controller.signal.aborted;
    const message = timedOut ? "agent_get_timeout" : clean(error);
    const errorName = timedOut ? "AbortError" : error instanceof Error ? error.name : "Error";
    const causeCode = timedOut ? "ETIMEDOUT" : nestedCode(error);
    if (timedOut || transientError(error)) return { ok: false, diagnostic: diagnostic({ httpStatus: null, errorName, causeCode, message }) };
    throw new AgentGetTerminalError(diagnostic({ httpStatus: null, errorName, causeCode, message }));
  } finally { clearTimeout(timeout); }
}
