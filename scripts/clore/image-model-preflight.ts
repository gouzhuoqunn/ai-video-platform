import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readSourceAcquisitionManifest, type SourceArtifact } from "../image-executor/manifests";
import type { ImageTaskLora } from "../../src/lib/image-generation/image-loras";
import {
  resolveTaskLoraDownloads,
  systemProxyAwareProviderFetch,
} from "../../src/lib/image-generation/local-lora-registry";

const REQUIRED_IDS = ["fluxed-up-10.2", "aidma-lora", "flux-vae", "flux-clip-l", "flux-t5xxl-fp8"] as const;
const ROLE_BY_ID: Record<(typeof REQUIRED_IDS)[number], string> = { "fluxed-up-10.2": "transformer", "aidma-lora": "lora", "flux-vae": "vae", "flux-clip-l": "clip_l", "flux-t5xxl-fp8": "t5" };
const PREFLIGHT_USER_AGENT = "ai-video-platform-model-preflight/1";
const RESPONSE_CANCEL_TIMEOUT_MS = 250;

export type RemoteImageModel = { role: string; id: (typeof REQUIRED_IDS)[number]; filename: string; url: string; sha256: string; size_bytes: number };
export type AgentModelEntry = { role: string; filename: string; url: string; sha256: string; size_bytes: number };
export type AgentAdditionalLoraEntry = { id: string; filename: string; url: string; sha256: string; size_bytes: number };
export type AgentModelManifest = { models: AgentModelEntry[]; loras?: AgentAdditionalLoraEntry[] };
export type ImageModelPreflight = {
  models: RemoteImageModel[];
  checked: Array<{ id: string; status: number; contentLength: number; source: "civitai" | "huggingface"; finalHostname: string; redirectCount: number; validatedMethod: "GET" }>;
};
export type AdditionalLoraPreflight = {
  loras: AgentAdditionalLoraEntry[];
  checked: Array<{ id: string; status: number; contentLength: number; source: "civitai" | "huggingface"; finalHostname: string; redirectCount: number; validatedMethod: "GET" }>;
};

type FetchLike = typeof fetch;
type TokenName = "CIVITAI_API_TOKEN" | "HF_TOKEN";
type TokenProvider = (name: TokenName) => string;
type HeaderResult = { status: number; location: string | null; contentLength: number | null; finalUrl: string; finalHostname: string; redirectCount: number };
type ProbeOptions = { fetchImpl?: FetchLike; authorizationToken?: string; redirect?: "manual" | "follow" };

function sourceManifestPath() { return path.join(process.cwd(), "comfy-runtime", "image-source-artifacts.json"); }
function localSecret(name: TokenName) {
  const fromEnvironment = process.env[name]?.trim(); if (fromEnvironment) return fromEnvironment;
  const secretFile = path.join(process.cwd(), ".secrets", name === "CIVITAI_API_TOKEN" ? "civitai.env" : "huggingface.env");
  try { for (const line of readFileSync(secretFile, "utf8").split(/\r?\n/)) { const match = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`).exec(line); if (match?.[1]) return match[1].trim().replace(/^["']|["']$/g, ""); } } catch { /* missing local-only capability is reported by caller */ }
  return "";
}
type VerifiedArtifact = SourceArtifact & { filename: string; sha256: string; size_bytes: number };
function exactFiveArtifacts(filePath = sourceManifestPath()): VerifiedArtifact[] {
  const byId = new Map(readSourceAcquisitionManifest(filePath).artifacts.map((artifact) => [artifact.id, artifact]));
  return REQUIRED_IDS.map((id) => {
    const artifact = byId.get(id);
    const size = artifact?.size_bytes;
    if (!artifact || typeof artifact.filename !== "string" || !artifact.filename || typeof artifact.sha256 !== "string" || !artifact.sha256 || typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) throw new Error(`image_model_identity_missing:${id}`);
    return { ...artifact, size_bytes: size } as VerifiedArtifact;
  });
}
function initialUrl(artifact: SourceArtifact) { if (artifact.source === "civitai") return `https://civitai.com/api/download/models/${artifact.version_id}`; if (!artifact.repository || !artifact.revision) throw new Error(`image_model_source_missing:${artifact.id}`); return `https://huggingface.co/${artifact.repository}/resolve/${artifact.revision}/${artifact.filename}`; }
function requireHttps(value: string, code: string) { const parsed = new URL(value); if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(code); return parsed.toString(); }
function declaredLength(headers: Headers) { const range = /\/(\d+)$/.exec(headers.get("content-range") ?? ""); if (range) return Number(range[1]); const length = Number(headers.get("content-length")); return Number.isSafeInteger(length) && length > 0 ? length : null; }
function resultFromHeaders(input: { status: number; location: string | null; contentLength: number | null; finalUrl: string; redirectCount: number }): HeaderResult { const parsed = new URL(input.finalUrl); return { ...input, finalHostname: parsed.hostname.toLowerCase() }; }
async function cancelResponseBody(response: Response, controller: AbortController) {
  if (!response.body) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelled = await Promise.race([
    response.body.cancel().then(() => true, () => true),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), RESPONSE_CANCEL_TIMEOUT_MS); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!cancelled) controller.abort();
}

async function nodeProbeOnce(fetchImpl: FetchLike, url: string, token: string): Promise<HeaderResult> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "manual", headers: { "User-Agent": PREFLIGHT_USER_AGENT, Accept: "application/octet-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: controller.signal });
    try { return resultFromHeaders({ status: response.status, location: response.headers.get("location"), contentLength: declaredLength(response.headers), finalUrl: response.url || url, redirectCount: 0 }); }
    finally { await cancelResponseBody(response, controller); }
  } finally { clearTimeout(timer); }
}

/** GET only: responses are disposed at headers, so full model bodies are never downloaded locally. */
export async function probeGetHeaders(url: string, options: ProbeOptions = {}): Promise<HeaderResult> {
  const redirect = options.redirect ?? "manual"; const initial = requireHttps(url, "invalid_model_source_url"); const initialOrigin = new URL(initial).origin;
  const fetchImpl = options.fetchImpl ?? systemProxyAwareProviderFetch();
  let current = initial; let redirects = 0;
  for (;;) {
    const token = options.authorizationToken && new URL(current).origin === initialOrigin ? options.authorizationToken : "";
    const once = await nodeProbeOnce(fetchImpl, current, token);
    const location = once.location ? requireHttps(new URL(once.location, current).toString(), "invalid_model_redirect_url") : null;
    if (redirect !== "follow" || ![301, 302, 303, 307, 308].includes(once.status)) return { ...once, finalUrl: current, finalHostname: new URL(current).hostname.toLowerCase(), redirectCount: redirects };
    if (!location) throw new Error("model_source_redirect_location_missing"); if (++redirects > 8) throw new Error("model_source_redirect_limit_exceeded"); current = location;
  }
}

function authTokenName(artifact: SourceArtifact): TokenName | null { if (artifact.auth === "civitai_token") return "CIVITAI_API_TOKEN"; if (artifact.auth === "huggingface_token") return "HF_TOKEN"; return null; }
function requireDownloadable(artifact: SourceArtifact, probe: HeaderResult) { if (![200, 206].includes(probe.status) || !probe.contentLength) throw new Error(`model_source_http_${probe.status}`); if (probe.contentLength !== artifact.size_bytes) throw new Error(`model_source_size_mismatch:${artifact.id}:${probe.contentLength}`); }
async function resolveDownloadUrl(input: { artifact: SourceArtifact; fetchImpl?: FetchLike; tokenProvider: TokenProvider }) {
  const initial = initialUrl(input.artifact); const tokenName = authTokenName(input.artifact); const token = tokenName ? input.tokenProvider(tokenName) : "";
  if (tokenName && !token) throw new Error(`missing_local_${tokenName === "HF_TOKEN" ? "huggingface" : "civitai"}_download_capability`);
  if (input.artifact.source === "civitai") {
    const redirect = await probeGetHeaders(initial, { fetchImpl: input.fetchImpl, authorizationToken: token, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(redirect.status) || !redirect.location) throw new Error(`civitai_source_http_${redirect.status}`);
    const signed = requireHttps(new URL(redirect.location, initial).toString(), "invalid_civitai_signed_download_url");
    const probe = await probeGetHeaders(signed, { fetchImpl: input.fetchImpl, redirect: "follow" }); requireDownloadable(input.artifact, probe); return { url: probe.finalUrl, probe };
  }
  let probe = await probeGetHeaders(initial, { fetchImpl: input.fetchImpl, authorizationToken: token, redirect: "follow" });
  requireDownloadable(input.artifact, probe);
  if (token && new URL(probe.finalUrl).origin === new URL(initial).origin) {
    try {
      const tokenless = await probeGetHeaders(probe.finalUrl, { fetchImpl: input.fetchImpl, redirect: "follow" });
      requireDownloadable(input.artifact, tokenless);
      probe = tokenless;
    } catch {
      throw new Error(`huggingface_remote_delivery_requires_local_token:${input.artifact.id}`);
    }
  }
  return { url: requireHttps(probe.finalUrl, "invalid_huggingface_source_url"), probe };
}

export async function verifyFiveImageModelSources(input: { fetchImpl?: FetchLike; tokenProvider?: TokenProvider; manifestPath?: string } = {}): Promise<ImageModelPreflight> {
  const tokenProvider = input.tokenProvider ?? localSecret; const models: RemoteImageModel[] = []; const checked: ImageModelPreflight["checked"] = [];
  for (const artifact of exactFiveArtifacts(input.manifestPath)) {
    const resolved = await resolveDownloadUrl({ artifact, fetchImpl: input.fetchImpl, tokenProvider }); const id = artifact.id as (typeof REQUIRED_IDS)[number];
    if (resolved.probe.contentLength === null) throw new Error(`model_source_content_length_missing:${id}`);
    models.push({ role: ROLE_BY_ID[id], id, filename: artifact.filename, url: resolved.url, sha256: artifact.sha256, size_bytes: artifact.size_bytes });
    checked.push({ id, status: resolved.probe.status, contentLength: resolved.probe.contentLength, source: artifact.source, finalHostname: resolved.probe.finalHostname, redirectCount: resolved.probe.redirectCount, validatedMethod: "GET" });
  }
  return { models, checked };
}

export async function verifyAdditionalTaskLoraSources(
  taskLoras: ImageTaskLora[] | undefined,
  input: { fetchImpl?: FetchLike; tokenProvider?: TokenProvider; registryPath?: string } = {},
): Promise<AdditionalLoraPreflight> {
  if (taskLoras === undefined) return { loras: [], checked: [] };
  const resolved = await resolveTaskLoraDownloads(taskLoras, {
    fetchImpl: input.fetchImpl,
    tokenProvider: input.tokenProvider,
    registryPath: input.registryPath,
  });
  return {
    loras: resolved.map((lora) => ({
      id: lora.id,
      filename: lora.filename,
      url: lora.url,
      sha256: lora.sha256,
      size_bytes: lora.sizeBytes,
    })),
    checked: resolved.map((lora) => ({
      id: lora.id,
      status: lora.evidence.status,
      contentLength: lora.evidence.contentLength,
      source: lora.provider,
      finalHostname: lora.evidence.finalHostname,
      redirectCount: lora.evidence.redirectCount,
      validatedMethod: lora.evidence.validatedMethod,
    })),
  };
}

export function toAgentModelManifest(
  resolvedModels: ReadonlyArray<RemoteImageModel>,
  additionalLoras: ReadonlyArray<AgentAdditionalLoraEntry> = [],
): AgentModelManifest {
  if (resolvedModels.length !== REQUIRED_IDS.length) throw new Error("exactly_five_models_required"); const expectedRoles = new Set(Object.values(ROLE_BY_ID)); const seenRoles = new Set<string>();
  const models = resolvedModels.map((model) => { if (!expectedRoles.has(model.role) || seenRoles.has(model.role)) throw new Error("invalid_or_duplicate_model_role"); if (!model.filename || /[\\/]|\.\./.test(model.filename)) throw new Error("invalid_model_filename"); if (!/^[a-f0-9]{64}$/i.test(model.sha256) || !Number.isSafeInteger(model.size_bytes) || model.size_bytes <= 0) throw new Error("invalid_model_hash_or_size"); requireHttps(model.url, "invalid_model_url"); seenRoles.add(model.role); return { role: model.role, filename: model.filename, url: model.url, sha256: model.sha256, size_bytes: model.size_bytes }; });
  if (seenRoles.size !== expectedRoles.size) throw new Error("missing_approved_model_role");
  if (additionalLoras.length > 16) throw new Error("too_many_additional_loras");
  const loraIds = new Set<string>(); const loraFilenames = new Set<string>(); let totalLoraBytes = 0;
  const loras = additionalLoras.map((lora) => {
    if (!/^(?:builtin-[a-z0-9-]{1,80}|[0-9a-f-]{36})$/i.test(lora.id) || loraIds.has(lora.id)) throw new Error("invalid_or_duplicate_lora_id");
    if (!/^[^/\\\u0000-\u001f]{1,180}\.safetensors$/i.test(lora.filename) || loraFilenames.has(lora.filename.toLowerCase())) throw new Error("invalid_or_duplicate_lora_filename");
    if (!/^[a-f0-9]{64}$/i.test(lora.sha256) || !Number.isSafeInteger(lora.size_bytes) || lora.size_bytes <= 0 || lora.size_bytes > 4 * 1024 * 1024 * 1024) throw new Error("invalid_lora_hash_or_size");
    totalLoraBytes += lora.size_bytes;
    if (totalLoraBytes > 8 * 1024 * 1024 * 1024) throw new Error("additional_loras_too_large");
    requireHttps(lora.url, "invalid_lora_url");
    loraIds.add(lora.id); loraFilenames.add(lora.filename.toLowerCase());
    return { id: lora.id, filename: lora.filename, url: lora.url, sha256: lora.sha256.toLowerCase(), size_bytes: lora.size_bytes };
  });
  return loras.length ? { models, loras } : { models };
}

function immutableAgentManifestIdentity(manifest: AgentModelManifest) {
  return {
    models: manifest.models.map(({ role, filename, sha256, size_bytes }) => ({
      role,
      filename,
      sha256: sha256.toLowerCase(),
      size_bytes,
    })),
    loras: (manifest.loras ?? []).map(({ id, filename, sha256, size_bytes }) => ({
      id,
      filename,
      sha256: sha256.toLowerCase(),
      size_bytes,
    })),
  };
}

/**
 * Signed delivery URLs are intentionally refreshed immediately before the
 * paid model stage. Only the transport URL may change; the complete immutable
 * model/LoRA identity and deterministic order must remain byte-for-byte
 * equivalent to the pre-order gate.
 */
export function assertAgentModelManifestIdentityUnchanged(
  preOrder: AgentModelManifest,
  refreshed: AgentModelManifest,
) {
  if (
    JSON.stringify(immutableAgentManifestIdentity(preOrder))
    !== JSON.stringify(immutableAgentManifestIdentity(refreshed))
  ) {
    throw new Error("agent_model_manifest_identity_changed_before_install");
  }
  return refreshed;
}

export function validateAgentModelManifestContract(manifest: AgentModelManifest) {
  const agentPath = path.join(process.cwd(), "scripts", "clore", "diagnostic-agent.py"); const script = ["import importlib.util,json,sys", "s=importlib.util.spec_from_file_location('agent',sys.argv[1])", "m=importlib.util.module_from_spec(s);s.loader.exec_module(m)", "m.validate_manifest(json.load(sys.stdin))"].join(";");
  const candidates: Array<[string, string[]]> = process.platform === "win32" ? [["py", ["-3", "-c", script, agentPath]], ["python", ["-c", script, agentPath]]] : [["python3", ["-c", script, agentPath]], ["python", ["-c", script, agentPath]]];
  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, {
      cwd: process.cwd(),
      input: JSON.stringify(manifest),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      killSignal: "SIGTERM",
    });
    if (result.signal || (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw new Error("agent_model_manifest_child_timeout");
    if (result.status === 0) return;
    const spawnError = result.error as NodeJS.ErrnoException | undefined;
    if (spawnError?.code === "ENOENT") continue;
    throw new Error("agent_model_manifest_contract_rejected");
  }
  throw new Error("agent_model_manifest_validator_unavailable");
}
export function indexResolvedModelsById(resolvedModels: ReadonlyArray<RemoteImageModel>) { return new Map(resolvedModels.map((model) => [model.id, model] as const)); }
export function sanitizeImageModelPreflight(value: ImageModelPreflight) {
  return {
    models: value.models.map((model) => ({
      role: model.role,
      filename: model.filename,
      sha256: model.sha256,
      size_bytes: model.size_bytes,
    })),
    checked: value.checked,
  };
}
