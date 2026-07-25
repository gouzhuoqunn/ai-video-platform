import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSourceAcquisitionManifest, type SourceArtifact } from "../image-executor/manifests";

const REQUIRED_IDS = ["fluxed-up-10.2", "aidma-lora", "flux-vae", "flux-clip-l", "flux-t5xxl-fp8"] as const;
const ROLE_BY_ID: Record<(typeof REQUIRED_IDS)[number], string> = {
  "fluxed-up-10.2": "transformer",
  "aidma-lora": "lora",
  "flux-vae": "vae",
  "flux-clip-l": "clip_l",
  "flux-t5xxl-fp8": "t5",
};

export type RemoteImageModel = {
  role: string;
  id: (typeof REQUIRED_IDS)[number];
  filename: string;
  url: string;
  sha256: string;
  size_bytes: number;
};

/** The only model shape the restricted Agent accepts over its public API. */
export type AgentModelEntry = {
  role: string;
  filename: string;
  url: string;
  sha256: string;
  size_bytes: number;
};

export type AgentModelManifest = { models: AgentModelEntry[] };

export type ImageModelPreflight = {
  models: RemoteImageModel[];
  checked: Array<{ id: string; status: number; contentLength: number; source: "civitai" | "huggingface" }>;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type TokenName = "CIVITAI_API_TOKEN" | "HF_TOKEN";
type TokenProvider = (name: TokenName) => string;
type HeaderResult = { status: number; location: string | null; contentLength: number | null };

function sourceManifestPath() {
  return path.join(process.cwd(), "comfy-runtime", "image-source-artifacts.json");
}

function localSecret(name: TokenName) {
  const fromEnvironment = process.env[name]?.trim();
  if (fromEnvironment) return fromEnvironment;
  const secretFile = path.join(process.cwd(), ".secrets", name === "CIVITAI_API_TOKEN" ? "civitai.env" : "huggingface.env");
  try {
    for (const line of readFileSync(secretFile, "utf8").split(/\r?\n/)) {
      const match = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`).exec(line);
      if (match?.[1]) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* the caller reports the missing local capability without leaking values */ }
  return "";
}

function exactFiveArtifacts(filePath = sourceManifestPath()) {
  const manifest = readSourceAcquisitionManifest(filePath);
  const byId = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  return REQUIRED_IDS.map((id) => {
    const artifact = byId.get(id) as SourceArtifact | undefined;
    if (!artifact || !artifact.filename || !artifact.sha256 || !artifact.size_bytes) throw new Error(`image_model_identity_missing:${id}`);
    return artifact;
  });
}

function initialUrl(artifact: SourceArtifact) {
  if (artifact.source === "civitai") return `https://civitai.com/api/download/models/${artifact.version_id}`;
  if (!artifact.repository || !artifact.revision) throw new Error(`image_model_source_missing:${artifact.id}`);
  return `https://huggingface.co/${artifact.repository}/resolve/${artifact.revision}/${artifact.filename}`;
}

function requireHttps(value: string, code: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(code);
  return parsed.toString();
}

function declaredLength(response: Response) {
  const contentRange = response.headers.get("content-range");
  const range = contentRange && /\/(\d+)$/.exec(contentRange);
  if (range) return Number(range[1]);
  const length = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}

async function fetchHeaders(fetchImpl: FetchLike, url: string, token = ""): Promise<HeaderResult> {
  const response = await fetchImpl(url, { method: "HEAD", redirect: "manual", headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  try {
    return { status: response.status, location: response.headers.get("location"), contentLength: declaredLength(response) };
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

function windowsHeaders(url: string, token = ""): HeaderResult {
  const script = [
    "Add-Type -AssemblyName System.Net.Http",
    "$h=[System.Net.Http.HttpClientHandler]::new();$h.AllowAutoRedirect=$false",
    "$c=[System.Net.Http.HttpClient]::new($h);$c.Timeout=[TimeSpan]::FromSeconds(45)",
    "$q=[System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Head,$env:AI_IMAGE_PREFLIGHT_URL)",
    "$q.Headers.UserAgent.ParseAdd('ai-video-platform-image-preflight')",
    "if($env:AI_IMAGE_PREFLIGHT_TOKEN){$q.Headers.Authorization=[System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$env:AI_IMAGE_PREFLIGHT_TOKEN)}",
    "$r=$c.SendAsync($q,[System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()",
    "$p=@{status=[int]$r.StatusCode;location=if($r.Headers.Location){$r.Headers.Location.AbsoluteUri}else{$null};contentLength=$r.Content.Headers.ContentLength}|ConvertTo-Json -Compress",
    "$r.Dispose();$q.Dispose();$c.Dispose();$h.Dispose();Write-Output $p",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: { ...process.env, AI_IMAGE_PREFLIGHT_URL: url, AI_IMAGE_PREFLIGHT_TOKEN: token },
  });
  if (result.status !== 0) throw new Error(`model_source_transport_failed:${String(result.stderr || result.stdout).trim().slice(0, 300)}`);
  const json = /\{[^{}]*\}/.exec(String(result.stdout))?.[0];
  if (!json) throw new Error("model_source_transport_invalid_response");
  const parsed = JSON.parse(json) as { status: number; location?: string | null; contentLength?: number | null };
  return { status: parsed.status, location: parsed.location ?? null, contentLength: parsed.contentLength ?? null };
}

async function headers(fetchImpl: FetchLike | undefined, url: string, token = "") {
  return fetchImpl ? fetchHeaders(fetchImpl, url, token) : os.platform() === "win32" ? windowsHeaders(url, token) : fetchHeaders(fetch, url, token);
}

function authTokenName(artifact: SourceArtifact): TokenName | null {
  if (artifact.auth === "civitai_token") return "CIVITAI_API_TOKEN";
  if (artifact.auth === "huggingface_token") return "HF_TOKEN";
  return null;
}

async function resolveDownloadUrl(input: { artifact: SourceArtifact; fetchImpl?: FetchLike; tokenProvider: TokenProvider }) {
  const url = initialUrl(input.artifact);
  const tokenName = authTokenName(input.artifact);
  const token = tokenName ? input.tokenProvider(tokenName) : "";
  if (tokenName && !token) throw new Error(`missing_local_${tokenName === "HF_TOKEN" ? "huggingface" : "civitai"}_download_capability`);
  const first = await headers(input.fetchImpl, url, token);
  if ([301, 302, 303, 307, 308].includes(first.status)) {
    if (!first.location) throw new Error(`${input.artifact.source}_signed_download_location_missing`);
    return requireHttps(new URL(first.location, url).toString(), `invalid_${input.artifact.source}_signed_download_url`);
  }
  if (first.status !== 200) throw new Error(`${input.artifact.source}_source_http_${first.status}`);
  return requireHttps(url, `invalid_${input.artifact.source}_source_url`);
}

/**
 * Validates the exact five files before a lease is claimed.  The Civitai
 * credential stays on this local machine: only the resulting time-limited
 * HTTPS download URL is returned for the restricted remote agent.
 */
export async function verifyFiveImageModelSources(input: { fetchImpl?: FetchLike; tokenProvider?: TokenProvider; manifestPath?: string } = {}): Promise<ImageModelPreflight> {
  const fetchImpl = input.fetchImpl;
  const tokenProvider = input.tokenProvider ?? localSecret;
  const models: RemoteImageModel[] = [];
  const checked: ImageModelPreflight["checked"] = [];
  for (const artifact of exactFiveArtifacts(input.manifestPath)) {
    const url = await resolveDownloadUrl({ artifact, fetchImpl, tokenProvider });
    const probe = await headers(fetchImpl, url);
    if (![200, 206].includes(probe.status) || !probe.contentLength) throw new Error(`model_source_http_${probe.status}`);
    if (probe.contentLength !== artifact.size_bytes) throw new Error(`model_source_size_mismatch:${artifact.id}:${probe.contentLength}`);
    const id = artifact.id as (typeof REQUIRED_IDS)[number];
    models.push({ role: ROLE_BY_ID[id], id, filename: artifact.filename, url, sha256: artifact.sha256, size_bytes: artifact.size_bytes });
    checked.push({ id, status: probe.status, contentLength: probe.contentLength, source: artifact.source });
  }
  return { models, checked };
}

/**
 * Projects the local resolver records onto the deliberately narrow remote
 * contract. Do not replace this with object spread: local identity and retry
 * metadata must never cross the Agent boundary.
 */
export function toAgentModelManifest(resolvedModels: ReadonlyArray<RemoteImageModel>): AgentModelManifest {
  if (resolvedModels.length !== REQUIRED_IDS.length) throw new Error("exactly_five_models_required");
  const expectedRoles = new Set(Object.values(ROLE_BY_ID));
  const seenRoles = new Set<string>();
  const models = resolvedModels.map((model) => {
    if (!expectedRoles.has(model.role) || seenRoles.has(model.role)) throw new Error("invalid_or_duplicate_model_role");
    if (!model.filename || /[\\/]|\.\./.test(model.filename)) throw new Error("invalid_model_filename");
    if (!/^[a-f0-9]{64}$/i.test(model.sha256) || !Number.isSafeInteger(model.size_bytes) || model.size_bytes <= 0) throw new Error("invalid_model_hash_or_size");
    requireHttps(model.url, "invalid_model_url");
    seenRoles.add(model.role);
    return {
      role: model.role,
      filename: model.filename,
      url: model.url,
      sha256: model.sha256,
      size_bytes: model.size_bytes,
    };
  });
  if (seenRoles.size !== expectedRoles.size) throw new Error("missing_approved_model_role");
  return { models };
}

/** Runs the committed restricted Agent validator locally before renting. */
export function validateAgentModelManifestContract(manifest: AgentModelManifest) {
  const agentPath = path.join(process.cwd(), "scripts", "clore", "diagnostic-agent.py");
  const script = [
    "import importlib.util,json,sys",
    "s=importlib.util.spec_from_file_location('agent',sys.argv[1])",
    "m=importlib.util.module_from_spec(s);s.loader.exec_module(m)",
    "m.validate_manifest(json.load(sys.stdin))",
  ].join(";");
  const candidates: Array<[string, string[]]> = process.platform === "win32"
    ? [["py", ["-3", "-c", script, agentPath]], ["python", ["-c", script, agentPath]]]
    : [["python3", ["-c", script, agentPath]], ["python", ["-c", script, agentPath]]];
  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, { cwd: process.cwd(), input: JSON.stringify(manifest), encoding: "utf8", windowsHide: true });
    if (result.status === 0) return;
    if (result.error?.code === "ENOENT") continue;
    throw new Error("agent_model_manifest_contract_rejected");
  }
  throw new Error("agent_model_manifest_validator_unavailable");
}

/** Keep local-only identity separate when a single signed URL must be refreshed. */
export function indexResolvedModelsById(resolvedModels: ReadonlyArray<RemoteImageModel>) {
  return new Map(resolvedModels.map((model) => [model.id, model] as const));
}

export function sanitizeImageModelPreflight(value: ImageModelPreflight) {
  return {
    models: value.models.map(({ url: _url, ...model }) => model),
    checked: value.checked,
  };
}
