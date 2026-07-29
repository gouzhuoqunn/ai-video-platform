import { randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  BUILTIN_AIDMA_LORA,
  MAX_LORA_NAME_LENGTH,
  MAX_REGISTERED_LORAS,
  MAX_TASK_LORAS,
  assertImageTaskLoras,
  assertSafeLoraFilename,
  validImageLoraId,
  validLoraStrength,
  type ImageTaskLora,
  type LoraRegistrationSource,
  type LoraSourceLocator,
  type RegisteredLora,
} from "./image-loras";

const REGISTRY_SCHEMA_VERSION = 1;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_SAFETENSORS_HEADER_BYTES = 16 * 1024 * 1024;
const MIN_LORA_BYTES = 1_024;
const MAX_LORA_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const BODY_CANCEL_TIMEOUT_MS = 250;
const LOCK_WAIT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const SAFE_SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_HF_REVISION = /^[a-f0-9]{40}$/i;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_SOURCE_URL_LENGTH = 4_096;
const CIVITAI_HOSTS = new Set(["civitai.com", "www.civitai.com", "civitai.red", "www.civitai.red"]);
const HUGGINGFACE_HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf.co", "www.hf.co"]);
const DEFAULT_CREATED_AT = "2026-07-28T00:00:00.000Z";

export type LoraRegistryOptions = {
  registryPath?: string;
  fetchImpl?: typeof fetch;
  tokenProvider?: (name: "CIVITAI_API_TOKEN" | "HF_TOKEN") => string;
  timeoutMs?: number;
  resolveHostname?: (hostname: string) => Promise<string[]>;
};

export type ResolvedLoraDownload = {
  id: string;
  filename: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  provider: "civitai" | "huggingface";
  evidence: {
    status: number;
    finalHostname: string;
    contentLength: number;
    redirectCount: number;
    validatedMethod: "GET";
  };
};

const DEFAULT_LORAS: RegisteredLora[] = [
  {
    id: BUILTIN_AIDMA_LORA.id,
    name: BUILTIN_AIDMA_LORA.name,
    filename: BUILTIN_AIDMA_LORA.filename,
    defaultStrength: BUILTIN_AIDMA_LORA.defaultStrength,
    defaultEnabled: true,
    availability: "ready",
    sha256: BUILTIN_AIDMA_LORA.sha256,
    sizeBytes: BUILTIN_AIDMA_LORA.sizeBytes,
    source: {
      provider: "civitai",
      modelId: 674027,
      versionId: 780667,
      fileId: 694003,
    },
    registrationSource: null,
    builtIn: true,
    createdAt: DEFAULT_CREATED_AT,
    updatedAt: DEFAULT_CREATED_AT,
  },
  {
    id: "builtin-male-anatomy-correction",
    name: "解决男人女器官LoRA",
    filename: "",
    defaultStrength: 0.85,
    defaultEnabled: false,
    availability: "missing",
    sha256: null,
    sizeBytes: null,
    source: null,
    registrationSource: null,
    builtIn: true,
    createdAt: DEFAULT_CREATED_AT,
    updatedAt: DEFAULT_CREATED_AT,
  },
  {
    id: "builtin-masculine-muscle",
    name: "大肌肉阳刚LoRA",
    filename: "",
    defaultStrength: 0.75,
    defaultEnabled: false,
    availability: "missing",
    sha256: null,
    sizeBytes: null,
    source: null,
    registrationSource: null,
    builtIn: true,
    createdAt: DEFAULT_CREATED_AT,
    updatedAt: DEFAULT_CREATED_AT,
  },
];

function registryPath(options: LoraRegistryOptions) {
  return path.resolve(
    options.registryPath
      ?? process.env.AI_IMAGE_LORA_REGISTRY_PATH
      ?? path.join(process.cwd(), ".secrets", "image-studio", "loras.json"),
  );
}

function secretToken(name: "CIVITAI_API_TOKEN" | "HF_TOKEN") {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const file = path.join(
    process.cwd(),
    ".secrets",
    name === "CIVITAI_API_TOKEN" ? "civitai.env" : "huggingface.env",
  );
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`).exec(line);
      if (match?.[1]) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Public sources remain usable without a token.
  }
  return "";
}

function normalizedName(value: unknown) {
  const name = String(value ?? "").trim();
  if (!name || name.length > MAX_LORA_NAME_LENGTH) throw new Error("invalid_lora_display_name");
  return name;
}

function safePublicHttps(value: string, allowedInitialHosts?: ReadonlySet<string>) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("unrecognized_lora_source_url");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || !hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    || hostname.includes(":")
    || (allowedInitialHosts && !allowedInitialHosts.has(hostname))
  ) {
    throw new Error("unsupported_lora_source_url");
  }
  return parsed;
}

function positiveInteger(value: string | null | undefined) {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeRegistrationFilename(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    return /\.safetensors$/i.test(decoded)
      ? assertSafeLoraFilename(path.posix.basename(decoded))
      : null;
  } catch {
    return null;
  }
}

function normalizedOriginalUrl(parsed: URL) {
  parsed.hash = "";
  return parsed.toString();
}

function assertNoCredentialQuery(parsed: URL) {
  const sensitive = /^(?:token|access[_-]?token|api[_-]?key|signature|credential|authorization|auth|x-amz-.+|x-goog-.+)$/i;
  if ([...parsed.searchParams.keys()].some((key) => sensitive.test(key))) {
    throw new Error("lora_source_url_contains_credentials");
  }
}

/**
 * Recognize a user source without performing DNS resolution or a network
 * request. This keeps adding a LoRA responsive even when a provider is
 * temporarily unavailable; immutable file identity is resolved separately at
 * the task-creation boundary.
 */
export function parseLoraRegistrationSource(value: unknown): LoraRegistrationSource {
  const sourceUrl = String(value ?? "").trim();
  if (!sourceUrl || sourceUrl.length > MAX_SOURCE_URL_LENGTH) {
    throw new Error("unrecognized_lora_source_url");
  }
  const parsed = safePublicHttps(sourceUrl);
  assertNoCredentialQuery(parsed);
  const hostname = parsed.hostname.toLowerCase();
  const originalUrl = normalizedOriginalUrl(parsed);

  if (CIVITAI_HOSTS.has(hostname)) {
    const modelMatch = /^\/models\/(\d+)(?:\/[^/]*)?\/?$/.exec(parsed.pathname);
    const versionMatch = /^\/api\/download\/models\/(\d+)\/?$/.exec(parsed.pathname);
    const modelId = positiveInteger(modelMatch?.[1]);
    const versionId = positiveInteger(
      versionMatch?.[1]
        ?? parsed.searchParams.get("modelVersionId")
        ?? parsed.searchParams.get("versionId"),
    );
    const fileId = positiveInteger(parsed.searchParams.get("fileId"));
    if (!modelId && !versionId && !fileId) throw new Error("unrecognized_lora_source_url");
    return {
      provider: "civitai",
      originalUrl,
      modelId,
      versionId,
      fileId,
    };
  }

  if (HUGGINGFACE_HOSTS.has(hostname)) {
    let parts: string[];
    try {
      parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new Error("unrecognized_lora_source_url");
    }
    if (parts.length < 2) throw new Error("unrecognized_lora_source_url");
    const repository = `${parts[0]}/${parts[1]}`;
    if (!SAFE_REPOSITORY.test(repository)) throw new Error("unrecognized_lora_source_url");
    if (parts.length === 2) {
      return {
        provider: "huggingface",
        originalUrl,
        repository,
        revision: null,
        path: null,
      };
    }
    if (!["blob", "resolve"].includes(parts[2]) || parts.length < 5) {
      throw new Error("unrecognized_lora_source_url");
    }
    const revision = parts[3] || null;
    const requestedPath = parts.slice(4).join("/");
    if (
      !revision
      || !requestedPath
      || requestedPath.includes("\\")
      || requestedPath.split("/").some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f]/.test(segment))
    ) {
      throw new Error("unrecognized_lora_source_url");
    }
    return {
      provider: "huggingface",
      originalUrl,
      repository,
      revision,
      path: requestedPath,
    };
  }

  const queryHasFileId = [...parsed.searchParams.keys()].some((key) =>
    key.toLowerCase() === "fileid" && positiveInteger(parsed.searchParams.get(key)));
  const obviousDownload = /\.safetensors$/i.test(parsed.pathname)
    || /(?:^|\/)download(?:\/|$)/i.test(parsed.pathname)
    || /(?:^|\/)models(?:\/|$)/i.test(parsed.pathname)
    || queryHasFileId;
  if (!obviousDownload) throw new Error("unrecognized_lora_source_url");
  return {
    provider: "direct",
    originalUrl,
    inferredFilename: safeRegistrationFilename(path.posix.basename(parsed.pathname)),
  };
}

function forbiddenNetworkAddress(address: string) {
  const normalized = address.toLowerCase();
  if (normalized.includes(":")) {
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith("ff")
      || normalized.startsWith("2001:db8:")
      || normalized.startsWith("::ffff:");
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && [0, 2, 168].includes(b))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0)
    || a >= 224;
}

async function publicAddresses(hostname: string, options: LoraRegistryOptions) {
  const resolver = options.resolveHostname ?? (async (name: string) =>
    (await lookup(name, { all: true, verbatim: true })).map((entry) => entry.address));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      resolver(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("lora_source_dns_timeout")), 3_000);
      }),
    ]);
    if (!addresses.length || addresses.some(forbiddenNetworkAddress)) {
      throw new Error("lora_source_nonpublic_address");
    }
    return addresses;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertPublicUrl(value: string, options: LoraRegistryOptions) {
  const parsed = safePublicHttps(value);
  await publicAddresses(parsed.hostname, options);
  return parsed;
}

async function readWithDeadline<T>(operation: Promise<T>, deadline: number) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("lora_source_timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("lora_source_timeout")), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancelWithBoundedWait(cancel: () => Promise<unknown>) {
  let operation: Promise<unknown>;
  try {
    operation = cancel();
  } catch {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BODY_CANCEL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancelReaderBounded(reader: ReadableStreamDefaultReader<Uint8Array>) {
  await cancelWithBoundedWait(() => reader.cancel());
}

async function cancelResponseBodyBounded(response: Response) {
  if (!response.body || response.body.locked) return;
  await cancelWithBoundedWait(() => response.body!.cancel());
}

async function readBoundedBody(response: Response, maximumBytes: number, deadline: number) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await readWithDeadline(reader.read(), deadline);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) throw new Error("lora_response_too_large");
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await cancelReaderBounded(reader);
  }
  return Buffer.concat(chunks, total);
}

async function boundedJson<T>(
  url: string,
  input: {
    fetchImpl: typeof fetch;
    token?: string;
    timeoutMs: number;
    registryOptions: LoraRegistryOptions;
  },
) {
  const parsed = await assertPublicUrl(url, input.registryOptions);
  const controller = new AbortController();
  const deadline = Date.now() + input.timeoutMs;
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await readWithDeadline(input.fetchImpl(parsed, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        "User-Agent": "ai-video-platform-lora-registry/1",
        ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
      },
      signal: controller.signal,
    }), deadline);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await cancelResponseBodyBounded(response);
      throw new Error("lora_metadata_redirect_forbidden");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) {
      await cancelResponseBodyBounded(response);
      throw new Error("lora_metadata_response_too_large");
    }
    const bytes = await readBoundedBody(response, MAX_METADATA_BYTES, deadline);
    if (!response.ok) throw new Error(`lora_metadata_http_${response.status}`);
    if (bytes.length > MAX_METADATA_BYTES) throw new Error("lora_metadata_response_too_large");
    const contentType = response.headers.get("content-type") ?? "";
    if (!/json/i.test(contentType)) throw new Error("lora_metadata_invalid_content_type");
    try {
      return JSON.parse(bytes.toString("utf8")) as T;
    } catch {
      throw new Error("lora_metadata_invalid_json");
    }
  } finally {
    clearTimeout(timer);
  }
}

function declaredLength(headers: Headers) {
  const range = /\/(\d+)$/.exec(headers.get("content-range") ?? "");
  if (range) return Number(range[1]);
  const length = Number(headers.get("content-length"));
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}

async function validateSafetensorsHeader(response: Response, deadline: number) {
  if (!response.body) throw new Error("lora_safetensors_header_missing");
  const reader = response.body.getReader();
  let bytes = Buffer.alloc(0);
  let required = 8;
  try {
    while (bytes.length < required) {
      const part = await readWithDeadline(reader.read(), deadline);
      if (part.done) break;
      bytes = Buffer.concat([bytes, Buffer.from(part.value)]);
      if (bytes.length >= 8 && required === 8) {
        const declaredLow = bytes.readUInt32LE(0);
        const declaredHigh = bytes.readUInt32LE(4);
        if (declaredHigh !== 0 || declaredLow <= 1 || declaredLow > MAX_SAFETENSORS_HEADER_BYTES) {
          throw new Error("invalid_safetensors_header_length");
        }
        required = 8 + declaredLow;
      }
      if (bytes.length > MAX_SAFETENSORS_HEADER_BYTES + 8 + 1024 * 1024) {
        throw new Error("invalid_safetensors_header_length");
      }
    }
  } finally {
    await cancelReaderBounded(reader);
  }
  if (bytes.length < required) throw new Error("lora_safetensors_header_incomplete");
  let header: unknown;
  try {
    header = JSON.parse(bytes.subarray(8, required).toString("utf8"));
  } catch {
    throw new Error("lora_safetensors_header_invalid_json");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw new Error("lora_safetensors_header_invalid");
  }
}

async function probeBinary(
  initialUrl: string,
  input: {
    fetchImpl: typeof fetch;
    token: string;
    tokenOrigin: string;
    timeoutMs: number;
    registryOptions: LoraRegistryOptions;
  },
) {
  let current = (await assertPublicUrl(initialUrl, input.registryOptions)).toString();
  let redirects = 0;
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    const controller = new AbortController();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("lora_source_timeout");
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let response: Response | undefined;
    try {
      const origin = new URL(current).origin;
      response = await readWithDeadline(input.fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
          Range: `bytes=0-${MAX_SAFETENSORS_HEADER_BYTES + 7}`,
          "User-Agent": "ai-video-platform-lora-registry/1",
          ...(input.token && origin === input.tokenOrigin ? { Authorization: `Bearer ${input.token}` } : {}),
        },
        signal: controller.signal,
      }), deadline);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("lora_source_redirect_missing");
        if (++redirects > 5) throw new Error("lora_source_redirect_limit");
        current = (await readWithDeadline(
          assertPublicUrl(new URL(location, current).toString(), input.registryOptions),
          deadline,
        )).toString();
        continue;
      }
      const contentLength = declaredLength(response.headers);
      if (![200, 206].includes(response.status)) throw new Error(`lora_source_http_${response.status}`);
      if (!contentLength) throw new Error("lora_source_content_length_missing");
      if (contentLength < MIN_LORA_BYTES || contentLength > MAX_LORA_BYTES) {
        throw new Error("lora_source_size_out_of_range");
      }
      await validateSafetensorsHeader(response, deadline);
      return {
        url: current,
        status: response.status,
        contentLength,
        finalHostname: new URL(current).hostname.toLowerCase(),
        redirectCount: redirects,
      };
    } finally {
      controller.abort();
      clearTimeout(timer);
      if (response) await cancelResponseBodyBounded(response);
    }
  }
}

type CivitaiFile = {
  id?: number;
  name?: string;
  primary?: boolean;
  type?: string;
  hashes?: { SHA256?: string };
  downloadUrl?: string;
  pickleScanResult?: string;
  virusScanResult?: string;
};
type CivitaiVersion = {
  id?: number;
  modelId?: number;
  files?: CivitaiFile[];
};
type CivitaiModel = {
  id?: number;
  type?: string;
  modelVersions?: CivitaiVersion[];
};
type HuggingFaceSibling = {
  rfilename?: string;
  size?: number;
  lfs?: { sha256?: string; oid?: string; size?: number };
};
type HuggingFaceModel = {
  sha?: string;
  siblings?: HuggingFaceSibling[];
};

function civitaiFile(version: CivitaiVersion, requestedFileId?: number) {
  const candidates = (version.files ?? []).filter((file) =>
    typeof file.name === "string"
    && /\.safetensors$/i.test(file.name)
    && String(file.type ?? "").toLowerCase() === "model"
    && String(file.pickleScanResult ?? "").toLowerCase() === "success"
    && String(file.virusScanResult ?? "").toLowerCase() === "success");
  const selected = requestedFileId !== undefined
    ? candidates.find((file) => file.id === requestedFileId)
    : candidates.find((file) => file.primary === true)
      ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!selected) throw new Error("civitai_lora_file_ambiguous_or_missing");
  const digest = selected.hashes?.SHA256?.toLowerCase();
  if (
    !Number.isSafeInteger(selected.id)
    || !SAFE_SHA256.test(digest ?? "")
    || typeof selected.name !== "string"
  ) {
    throw new Error("civitai_lora_identity_incomplete");
  }
  return {
    id: selected.id!,
    filename: assertSafeLoraFilename(path.basename(selected.name)),
    sha256: digest!,
    downloadUrl: selected.downloadUrl,
  };
}

async function resolveCivitaiSource(sourceUrl: URL, options: Required<Pick<LoraRegistryOptions, "fetchImpl" | "timeoutMs">> & { token: string; registryOptions: LoraRegistryOptions }) {
  const versionMatch = /^\/api\/download\/models\/(\d+)\/?$/.exec(sourceUrl.pathname);
  const modelMatch = /^\/models\/(\d+)(?:\/[^/]*)?\/?$/.exec(sourceUrl.pathname);
  const requestedVersion = Number(
    versionMatch?.[1]
      ?? sourceUrl.searchParams.get("modelVersionId")
      ?? sourceUrl.searchParams.get("versionId"),
  );
  const requestedFileId = Number(sourceUrl.searchParams.get("fileId"));
  let version: CivitaiVersion | undefined;
  let model: CivitaiModel | undefined;
  let modelId: number | null = modelMatch ? Number(modelMatch[1]) : null;
  if (Number.isSafeInteger(requestedVersion) && requestedVersion > 0) {
    version = await boundedJson<CivitaiVersion>(
      `https://civitai.com/api/v1/model-versions/${requestedVersion}`,
      options,
    );
    modelId = Number.isSafeInteger(version.modelId) ? version.modelId! : modelId;
  } else if (modelId && Number.isSafeInteger(modelId)) {
    model = await boundedJson<CivitaiModel>(
      `https://civitai.com/api/v1/models/${modelId}`,
      options,
    );
    version = model.modelVersions?.[0];
  }
  if (!version || !Number.isSafeInteger(version.id) || Number(version.id) <= 0) {
    throw new Error("civitai_lora_version_missing");
  }
  if (!model && modelId && Number.isSafeInteger(modelId)) {
    model = await boundedJson<CivitaiModel>(
      `https://civitai.com/api/v1/models/${modelId}`,
      options,
    );
  }
  if (String(model?.type ?? "").toUpperCase() !== "LORA") {
    throw new Error("civitai_model_is_not_lora");
  }
  const selected = civitaiFile(
    version,
    Number.isSafeInteger(requestedFileId) && requestedFileId > 0 ? requestedFileId : undefined,
  );
  const fallbackDownloadUrl = new URL(`https://civitai.com/api/download/models/${version.id}`);
  // Civitai's generic version endpoint may resolve a different file when a
  // version contains multiple safetensors files. Pin the selected file ID
  // even when the API did not provide a direct download URL.
  fallbackDownloadUrl.searchParams.set("fileId", String(selected.id));
  const downloadUrl = safePublicHttps(
    selected.downloadUrl
      ?? fallbackDownloadUrl.toString(),
  ).toString();
  return {
    filename: selected.filename,
    sha256: selected.sha256,
    source: {
      provider: "civitai",
      modelId,
      versionId: Number(version.id),
      fileId: selected.id,
    } satisfies LoraSourceLocator,
    downloadUrl,
  };
}

function huggingFaceUrlParts(sourceUrl: URL) {
  const parts = sourceUrl.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) throw new Error("huggingface_repository_missing");
  const repository = `${parts[0]}/${parts[1]}`;
  if (!SAFE_REPOSITORY.test(repository)) throw new Error("huggingface_repository_invalid");
  if (parts.length === 2) return { repository, requestedRevision: "main", requestedPath: null as string | null };
  if (!["blob", "resolve"].includes(parts[2]) || parts.length < 5) {
    throw new Error("huggingface_lora_file_url_required");
  }
  return {
    repository,
    requestedRevision: parts[3],
    requestedPath: parts.slice(4).join("/"),
  };
}

function huggingFaceFile(model: HuggingFaceModel, requestedPath: string | null) {
  const assertSafeHuggingFacePath = (value: string) => {
    if (
      !value
      || value.startsWith("/")
      || value.includes("\\")
      || value.split("/").some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f]/.test(segment))
    ) {
      throw new Error("huggingface_lora_path_invalid");
    }
    return value;
  };
  const safeRequestedPath = requestedPath ? assertSafeHuggingFacePath(requestedPath) : null;
  const candidates = (model.siblings ?? []).filter((file) =>
    typeof file.rfilename === "string"
    && /\.safetensors$/i.test(file.rfilename)
    && (() => {
      try { assertSafeHuggingFacePath(file.rfilename); return true; } catch { return false; }
    })());
  const selected = safeRequestedPath
    ? candidates.find((file) => file.rfilename === safeRequestedPath)
    : candidates.length === 1 ? candidates[0] : undefined;
  if (!selected?.rfilename) throw new Error("huggingface_lora_file_ambiguous_or_missing");
  const digest = (selected.lfs?.sha256 ?? selected.lfs?.oid?.replace(/^sha256:/, ""))?.toLowerCase();
  const size = selected.lfs?.size ?? selected.size;
  if (!SAFE_SHA256.test(digest ?? "") || !Number.isSafeInteger(size) || Number(size) <= 0) {
    throw new Error("huggingface_lora_identity_incomplete");
  }
  return {
    path: selected.rfilename,
    filename: assertSafeLoraFilename(path.posix.basename(selected.rfilename)),
    sha256: digest!,
    declaredSize: Number(size),
  };
}

async function resolveHuggingFaceSource(
  sourceUrl: URL,
  options: Required<Pick<LoraRegistryOptions, "fetchImpl" | "timeoutMs">> & { token: string; registryOptions: LoraRegistryOptions },
) {
  const parts = huggingFaceUrlParts(sourceUrl);
  const model = await boundedJson<HuggingFaceModel>(
    `https://huggingface.co/api/models/${parts.repository}/revision/${encodeURIComponent(parts.requestedRevision)}?blobs=true`,
    options,
  );
  if (!SAFE_HF_REVISION.test(model.sha ?? "")) throw new Error("huggingface_immutable_revision_missing");
  const selected = huggingFaceFile(model, parts.requestedPath);
  return {
    filename: selected.filename,
    sha256: selected.sha256,
    declaredSize: selected.declaredSize,
    source: {
      provider: "huggingface",
      repository: parts.repository,
      revision: model.sha!.toLowerCase(),
      path: selected.path,
    } satisfies LoraSourceLocator,
    downloadUrl: `https://huggingface.co/${parts.repository}/resolve/${model.sha}/${selected.path.split("/").map(encodeURIComponent).join("/")}`,
  };
}

async function resolveSourceUrl(sourceUrl: string, options: LoraRegistryOptions) {
  const registrationSource = parseLoraRegistrationSource(sourceUrl);
  if (registrationSource.provider === "direct") {
    throw new Error("direct_lora_source_identity_unavailable");
  }
  const parsed = safePublicHttps(registrationSource.originalUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokenProvider = options.tokenProvider ?? secretToken;
  if (registrationSource.provider === "huggingface") {
    const token = tokenProvider("HF_TOKEN");
    const resolved = await resolveHuggingFaceSource(parsed, { fetchImpl, timeoutMs, token, registryOptions: options });
    let probe = await probeBinary(resolved.downloadUrl, {
      fetchImpl,
      token,
      tokenOrigin: "https://huggingface.co",
      timeoutMs,
      registryOptions: options,
    });
    if (token && new URL(probe.url).origin === "https://huggingface.co") {
      try {
        probe = await probeBinary(probe.url, {
          fetchImpl,
          token: "",
          tokenOrigin: "",
          timeoutMs,
          registryOptions: options,
        });
      } catch {
        // The paid Agent intentionally never receives the user's HF token.
        // Registration must therefore prove a tokenless immutable delivery URL.
        throw new Error("huggingface_lora_remote_delivery_requires_local_token");
      }
    }
    if (probe.contentLength !== resolved.declaredSize) throw new Error("huggingface_lora_size_mismatch");
    return { ...resolved, sizeBytes: probe.contentLength, probe, provider: "huggingface" as const };
  }
  const token = tokenProvider("CIVITAI_API_TOKEN");
  const resolved = await resolveCivitaiSource(parsed, { fetchImpl, timeoutMs, token, registryOptions: options });
  const probe = await probeBinary(resolved.downloadUrl, {
    fetchImpl,
    token,
    tokenOrigin: "https://civitai.com",
    timeoutMs,
    registryOptions: options,
  });
  return { ...resolved, sizeBytes: probe.contentLength, probe, provider: "civitai" as const };
}

function sourceValid(value: unknown): value is LoraSourceLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (source.provider === "civitai") {
    return (source.modelId === null || (Number.isSafeInteger(source.modelId) && Number(source.modelId) > 0))
      && Number.isSafeInteger(source.versionId)
      && Number(source.versionId) > 0
      && Number.isSafeInteger(source.fileId)
      && Number(source.fileId) > 0;
  }
  const sourcePath = typeof source.path === "string" ? source.path : "";
  const safeSegments = sourcePath.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".." && !/[\u0000-\u001f]/.test(segment));
  return source.provider === "huggingface"
    && typeof source.repository === "string"
    && SAFE_REPOSITORY.test(source.repository)
    && typeof source.revision === "string"
    && SAFE_HF_REVISION.test(source.revision)
    && sourcePath.length > 0
    && sourcePath.length <= 1_024
    && safeSegments;
}

function normalizedRegistrationSource(value: unknown): LoraRegistrationSource | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("lora_registration_source_invalid");
  }
  const stored = value as Record<string, unknown>;
  const parsed = parseLoraRegistrationSource(stored.originalUrl);
  if (stored.provider !== parsed.provider) throw new Error("lora_registration_source_invalid");
  if (parsed.provider === "civitai") {
    if (
      stored.modelId !== parsed.modelId
      || stored.versionId !== parsed.versionId
      || stored.fileId !== parsed.fileId
    ) throw new Error("lora_registration_source_invalid");
  } else if (parsed.provider === "huggingface") {
    if (
      stored.repository !== parsed.repository
      || stored.revision !== parsed.revision
      || stored.path !== parsed.path
    ) throw new Error("lora_registration_source_invalid");
  } else if (stored.inferredFilename !== parsed.inferredFilename) {
    throw new Error("lora_registration_source_invalid");
  }
  return parsed;
}

function registeredLora(value: unknown): RegisteredLora | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const availability = item.availability;
  const ready = availability === "ready";
  const registered = availability === "registered";
  const missing = availability === "missing";
  try {
    if (!ready && !registered && !missing) return null;
    const registrationSource = normalizedRegistrationSource(item.registrationSource);
    const registeredFilename = registered && typeof item.filename === "string" && item.filename
      ? assertSafeLoraFilename(item.filename)
      : "";
    const parsed: RegisteredLora = {
      id: String(item.id ?? ""),
      name: normalizedName(item.name),
      filename: ready ? assertSafeLoraFilename(item.filename) : registeredFilename,
      defaultStrength: Number(item.defaultStrength),
      defaultEnabled: item.defaultEnabled === true,
      availability,
      sha256: ready && typeof item.sha256 === "string" && SAFE_SHA256.test(item.sha256)
        ? item.sha256.toLowerCase()
        : null,
      sizeBytes: ready && Number.isSafeInteger(item.sizeBytes) && Number(item.sizeBytes) >= MIN_LORA_BYTES && Number(item.sizeBytes) <= MAX_LORA_BYTES
        ? Number(item.sizeBytes)
        : null,
      source: ready && sourceValid(item.source) ? item.source : null,
      registrationSource,
      builtIn: item.builtIn === true,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : DEFAULT_CREATED_AT,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : DEFAULT_CREATED_AT,
    };
    if (
      !validImageLoraId(parsed.id)
      || !validLoraStrength(parsed.defaultStrength)
      || (ready && (!parsed.sha256 || !parsed.sizeBytes || !parsed.source))
      || (registered && !parsed.registrationSource)
      || (missing && parsed.registrationSource !== null)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function mergedDefaults(items: RegisteredLora[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return [
    ...DEFAULT_LORAS.map((item) => {
      const stored = byId.get(item.id);
      if (!stored) return structuredClone(item);
      if (item.id !== BUILTIN_AIDMA_LORA.id) return stored;
      return {
        ...structuredClone(item),
        name: stored.name,
        defaultStrength: stored.defaultStrength,
        defaultEnabled: stored.defaultEnabled,
        updatedAt: stored.updatedAt,
      };
    }),
    ...items.filter((item) => !DEFAULT_LORAS.some((preset) => preset.id === item.id)),
  ].slice(0, MAX_REGISTERED_LORAS);
}

function readRegistryFile(file: string) {
  if (!existsSync(file)) return structuredClone(DEFAULT_LORAS);
  if (statSync(file).size > MAX_REGISTRY_BYTES) throw new Error("lora_registry_too_large");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion?: unknown; items?: unknown };
  if (parsed.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(parsed.items)) {
    throw new Error("lora_registry_invalid");
  }
  const items = parsed.items.map(registeredLora);
  if (items.some((item) => !item)) throw new Error("lora_registry_invalid");
  return mergedDefaults(items as RegisteredLora[]);
}

function atomicWriteRegistry(file: string, items: RegisteredLora[]) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const descriptor = openSync(temporary, "w", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, items }, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
}

function withRegistryLock<T>(
  options: LoraRegistryOptions,
  operation: (items: RegisteredLora[], write: (items: RegisteredLora[]) => void) => T,
) {
  const file = registryPath(options);
  mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          rmSync(lock, { recursive: true, force: true });
        }
      } catch {
        // Another local process completed lock recovery.
      }
      if (Date.now() >= deadline) throw new Error("lora_registry_lock_timeout");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const items = readRegistryFile(file);
    return operation(structuredClone(items), (next) => atomicWriteRegistry(file, next));
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function listRegisteredLoras(options: LoraRegistryOptions = {}) {
  return withRegistryLock(options, (items) => structuredClone(items));
}

function registrationSourceIdentity(source: LoraRegistrationSource) {
  if (source.provider === "civitai") {
    return `civitai:model=${source.modelId ?? ""}:version=${source.versionId ?? ""}:file=${source.fileId ?? ""}`;
  }
  if (source.provider === "huggingface") {
    return `huggingface:${source.repository}:revision=${source.revision ?? ""}:path=${source.path ?? ""}`;
  }
  return `direct:${source.originalUrl}`;
}

function registrationMatchesReady(source: LoraRegistrationSource, item: RegisteredLora) {
  if (item.availability !== "ready" || !item.source) return false;
  if (
    item.registrationSource
    && registrationSourceIdentity(item.registrationSource) === registrationSourceIdentity(source)
  ) return true;
  if (source.provider === "civitai" && item.source.provider === "civitai") {
    const fields = [
      source.modelId === null || source.modelId === item.source.modelId,
      source.versionId === null || source.versionId === item.source.versionId,
      source.fileId === null || source.fileId === item.source.fileId,
    ];
    return fields.every(Boolean);
  }
  if (source.provider === "huggingface" && item.source.provider === "huggingface") {
    const immutableRevisionRequested = SAFE_HF_REVISION.test(source.revision ?? "");
    return source.repository === item.source.repository
      && (source.path === null || source.path === item.source.path)
      && (!immutableRevisionRequested || source.revision!.toLowerCase() === item.source.revision);
  }
  return false;
}

function inferredRegistrationFilename(source: LoraRegistrationSource) {
  if (source.provider === "direct") return source.inferredFilename ?? "";
  if (source.provider === "huggingface" && source.path) {
    return safeRegistrationFilename(path.posix.basename(source.path)) ?? "";
  }
  return "";
}

export async function registerLoraFromUrl(
  input: {
    name: unknown;
    sourceUrl: unknown;
    defaultStrength: unknown;
    presetId?: unknown;
  },
  options: LoraRegistryOptions = {},
) {
  const name = normalizedName(input.name);
  const sourceUrl = String(input.sourceUrl ?? "").trim();
  const defaultStrength = Number(input.defaultStrength);
  if (!sourceUrl || !validLoraStrength(defaultStrength)) throw new Error("invalid_lora_registration");
  const registrationSource = parseLoraRegistrationSource(sourceUrl);
  const now = new Date().toISOString();
  const result = withRegistryLock(options, (items, write) => {
    const presetId = typeof input.presetId === "string" ? input.presetId : null;
    const sourceIdentity = registrationSourceIdentity(registrationSource);
    const exactRegistered = items.find((item) =>
      item.registrationSource
      && registrationSourceIdentity(item.registrationSource) === sourceIdentity);
    const matchingReady = items.find((item) => registrationMatchesReady(registrationSource, item));
    const placeholder = items.find((item) =>
      item.availability === "missing"
      && ((presetId && item.id === presetId) || item.name === name));
    const existing = exactRegistered ?? matchingReady ?? placeholder;
    const id = existing?.id ?? randomUUID();
    const createdAt = existing?.createdAt ?? now;
    const registered: RegisteredLora = existing?.availability === "ready"
      ? {
        ...existing,
        name,
        defaultStrength,
        registrationSource,
        updatedAt: now,
      }
      : {
      id,
      name,
      filename: inferredRegistrationFilename(registrationSource),
      defaultStrength,
      defaultEnabled: existing?.defaultEnabled ?? false,
      availability: "registered",
      sha256: null,
      sizeBytes: null,
      source: null,
      registrationSource,
      builtIn: existing?.builtIn ?? false,
      createdAt,
      updatedAt: now,
    };
    const next = items.some((item) => item.id === id)
      ? items.map((item) => item.id === id ? registered : item)
      : [...items, registered];
    if (next.length > MAX_REGISTERED_LORAS) throw new Error("lora_registry_capacity_exceeded");
    write(next);
    return { item: registered, items: next };
  });
  return {
    ...result,
    verification: {
      provider: registrationSource.provider,
      classification: result.item.availability === "ready"
        ? "already_ready"
        : "registered_for_generation_validation",
    },
  };
}

export function updateRegisteredLora(
  input: { id: unknown; name: unknown; defaultStrength: unknown },
  options: LoraRegistryOptions = {},
) {
  const id = String(input.id ?? "");
  const name = normalizedName(input.name);
  const defaultStrength = Number(input.defaultStrength);
  if (!validLoraStrength(defaultStrength)) throw new Error("invalid_lora_strength");
  return withRegistryLock(options, (items, write) => {
    const existing = items.find((item) => item.id === id);
    if (!existing) throw new Error("lora_registry_item_not_found");
    const item = { ...existing, name, defaultStrength, updatedAt: new Date().toISOString() };
    const next = items.map((candidate) => candidate.id === id ? item : candidate);
    write(next);
    return { item, items: next };
  });
}

async function promoteRegisteredLora(
  id: string,
  expectedRegistrationSource: LoraRegistrationSource,
  options: LoraRegistryOptions,
) {
  if (expectedRegistrationSource.provider === "direct") {
    throw new Error("direct_lora_source_identity_unavailable");
  }
  const resolved = await resolveSourceUrl(expectedRegistrationSource.originalUrl, options);
  return withRegistryLock(options, (items, write) => {
    const current = items.find((item) => item.id === id);
    if (!current) throw new Error("lora_registry_item_not_found");
    if (current.availability === "ready") return current;
    if (
      current.availability !== "registered"
      || !current.registrationSource
      || registrationSourceIdentity(current.registrationSource) !== registrationSourceIdentity(expectedRegistrationSource)
    ) {
      throw new Error("lora_registration_changed_during_resolution");
    }
    const filenameMatch = items.find((item) =>
      item.id !== id
      && item.availability === "ready"
      && item.filename.toLowerCase() === resolved.filename.toLowerCase());
    const digestMatch = items.find((item) =>
      item.id !== id
      && item.availability === "ready"
      && item.sha256 === resolved.sha256);
    if (filenameMatch && filenameMatch.sha256 !== resolved.sha256) {
      throw new Error("lora_filename_identity_conflict");
    }
    if (
      digestMatch
      && (
        digestMatch.filename !== resolved.filename
        || JSON.stringify(digestMatch.source) !== JSON.stringify(resolved.source)
        || digestMatch.sizeBytes !== resolved.sizeBytes
      )
    ) {
      throw new Error("lora_digest_identity_conflict");
    }
    const ready: RegisteredLora = {
      ...current,
      filename: resolved.filename,
      availability: "ready",
      sha256: resolved.sha256,
      sizeBytes: resolved.sizeBytes,
      source: resolved.source,
      updatedAt: new Date().toISOString(),
    };
    const next = items.map((item) => item.id === id ? ready : item);
    write(next);
    return ready;
  });
}

/**
 * Browser-supplied names, filenames, hashes and sizes are never trusted.
 * Only id/strength/enabled are accepted; immutable identity comes from the
 * local registry snapshot.
 */
export function snapshotTaskLoras(value: unknown, options: LoraRegistryOptions = {}): ImageTaskLora[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_REGISTERED_LORAS) throw new Error("invalid_image_task_loras");
  const registry = listRegisteredLoras(options);
  const byId = new Map(registry.map((item) => [item.id, item]));
  const seen = new Set<string>();
  let enabledCount = 0;
  const snapshots = value.map((raw): ImageTaskLora | null => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_image_task_lora");
    const selection = raw as Record<string, unknown>;
    const id = String(selection.id ?? "");
    const item = byId.get(id);
    const strength = Number(selection.strength);
    const enabled = selection.enabled;
    if (!item || !validLoraStrength(strength) || typeof enabled !== "boolean" || seen.has(id)) {
      throw new Error("invalid_or_unavailable_task_lora");
    }
    seen.add(id);
    // The built-in recommendation placeholders are intentionally allowed to
    // remain unchecked while disabled. They have no immutable file identity
    // yet, so omit them from the persisted task snapshot; enabling one still
    // fails closed until the user registers a verified source.
    if (item.availability !== "ready" || !item.filename || !item.sha256 || !item.sizeBytes) {
      if (!enabled) return null;
      throw new Error("invalid_or_unavailable_task_lora");
    }
    if (enabled) enabledCount += 1;
    return {
      id: item.id,
      name: item.name,
      filename: item.filename,
      strength,
      enabled,
      sha256: item.sha256,
      sizeBytes: item.sizeBytes,
    };
  }).filter((item): item is ImageTaskLora => item !== null);
  if (enabledCount > MAX_TASK_LORAS) throw new Error("too_many_enabled_loras");
  return assertImageTaskLoras(snapshots);
}

/**
 * Resolve only enabled `registered` selections immediately before task
 * persistence. The resulting task remains on the existing immutable
 * filename/size/SHA contract, so all paid-runtime and Agent checks continue
 * unchanged. Direct URLs without a trusted provider identity stay registered
 * but fail clearly before a task or order can be created.
 */
export async function resolveAndSnapshotTaskLoras(
  value: unknown,
  options: LoraRegistryOptions = {},
): Promise<ImageTaskLora[] | undefined> {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_REGISTERED_LORAS) {
    throw new Error("invalid_image_task_loras");
  }
  const registry = listRegisteredLoras(options);
  const byId = new Map(registry.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const pending: Array<{ id: string; source: LoraRegistrationSource }> = [];
  let enabledCount = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_image_task_lora");
    const selection = raw as Record<string, unknown>;
    const id = String(selection.id ?? "");
    const strength = Number(selection.strength);
    const enabled = selection.enabled;
    const item = byId.get(id);
    if (
      !item
      || !validLoraStrength(strength)
      || typeof enabled !== "boolean"
      || seen.has(id)
    ) {
      throw new Error("invalid_or_unavailable_task_lora");
    }
    seen.add(id);
    if (!enabled) continue;
    enabledCount += 1;
    if (item.availability === "registered" && item.registrationSource) {
      pending.push({ id, source: item.registrationSource });
    } else if (item.availability !== "ready") {
      throw new Error("invalid_or_unavailable_task_lora");
    }
  }
  if (enabledCount > MAX_TASK_LORAS) throw new Error("too_many_enabled_loras");
  for (const item of pending) {
    await promoteRegisteredLora(item.id, item.source, options);
  }
  return snapshotTaskLoras(value, options);
}

export async function resolveTaskLoraDownloads(
  taskLoras: unknown,
  options: LoraRegistryOptions = {},
): Promise<ResolvedLoraDownload[]> {
  const selected = assertImageTaskLoras(taskLoras).filter((item) => item.enabled);
  const registry = listRegisteredLoras(options);
  const byId = new Map(registry.map((item) => [item.id, item]));
  const result: ResolvedLoraDownload[] = [];
  for (const taskLora of selected) {
    if (taskLora.filename === BUILTIN_AIDMA_LORA.filename && taskLora.sha256 === BUILTIN_AIDMA_LORA.sha256) {
      continue;
    }
    const registered = byId.get(taskLora.id);
    if (
      !registered
      || registered.availability !== "ready"
      || registered.filename !== taskLora.filename
      || registered.sha256 !== taskLora.sha256
      || registered.sizeBytes !== taskLora.sizeBytes
      || !registered.source
    ) {
      throw new Error(`task_lora_registry_identity_mismatch:${taskLora.id}`);
    }
    const sourceUrl = registered.source.provider === "civitai"
      ? `https://civitai.com/api/download/models/${registered.source.versionId}?fileId=${registered.source.fileId}`
      : `https://huggingface.co/${registered.source.repository}/resolve/${registered.source.revision}/${registered.source.path.split("/").map(encodeURIComponent).join("/")}`;
    const resolved = await resolveSourceUrl(sourceUrl, options);
    if (
      resolved.filename !== registered.filename
      || resolved.sha256 !== registered.sha256
      || resolved.sizeBytes !== registered.sizeBytes
    ) {
      throw new Error(`task_lora_source_identity_mismatch:${taskLora.id}`);
    }
    result.push({
      id: taskLora.id,
      filename: registered.filename,
      url: resolved.probe.url,
      sha256: registered.sha256,
      sizeBytes: registered.sizeBytes,
      provider: resolved.provider,
      evidence: {
        status: resolved.probe.status,
        finalHostname: resolved.probe.finalHostname,
        contentLength: resolved.probe.contentLength,
        redirectCount: resolved.probe.redirectCount,
        validatedMethod: "GET",
      },
    });
  }
  return result;
}
