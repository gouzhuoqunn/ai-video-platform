import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 24;
const CACHE_FILE_PATTERN = /^[a-f0-9]{64}\.[a-f0-9]{40}\.[a-f0-9]{64}\.bin$/;

export type ImmutableSourceEndpoint = {
  id: string;
  url: string;
};

export type ImmutableSourceEvidence = {
  source: "cache" | "endpoint";
  endpointId: string;
  httpStatus: number | null;
  contentType: string | null;
  responseByteLength: number | null;
  bodySha256: string | null;
  classification:
    | "cache_missing"
    | "cache_corrupt"
    | "cache_verified"
    | "transport_failed"
    | "http_failed"
    | "size_invalid"
    | "content_incompatible"
    | "sha256_mismatch"
    | "verified";
  transportCode: string | null;
};

export type ResolvedImmutableSource = {
  bytes: Buffer;
  sha256: string;
  source: "cache" | "endpoint";
  endpointId: string;
  evidence: ImmutableSourceEvidence[];
};

export class ImmutableSourceResolutionError extends Error {
  readonly evidence: ImmutableSourceEvidence[];

  constructor(code: string, evidence: ImmutableSourceEvidence[]) {
    super(code);
    this.name = "ImmutableSourceResolutionError";
    this.evidence = evidence;
  }
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertHex(value: string, length: number, label: string) {
  if (!new RegExp(`^[a-f0-9]{${length}}$`, "i").test(value)) {
    throw new Error(`immutable_source_${label}_invalid`);
  }
  return value.toLowerCase();
}

function assertSourcePath(sourcePath: string) {
  const normalized = sourcePath.replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
    || !/^[A-Za-z0-9._/-]+$/.test(normalized)
  ) {
    throw new Error("immutable_source_path_invalid");
  }
  return normalized;
}

export function immutablePublicSourceEndpoints(commit: string, sourcePath: string): ImmutableSourceEndpoint[] {
  const exactCommit = assertHex(commit, 40, "commit");
  const exactPath = assertSourcePath(sourcePath);
  return [
    {
      id: "jsdelivr_commit_cdn",
      url: `https://cdn.jsdelivr.net/gh/gouzhuoqunn/ai-video-platform@${exactCommit}/${exactPath}`,
    },
    {
      id: "github_raw_commit",
      url: `https://raw.githubusercontent.com/gouzhuoqunn/ai-video-platform/${exactCommit}/${exactPath}`,
    },
  ];
}

export function immutableSourceCacheRoot() {
  return path.join(process.cwd(), ".secrets", "immutable-source-cache");
}

export function immutableSourceCachePath(input: {
  cacheRoot?: string;
  profileFingerprint: string;
  commit: string;
  expectedSha256: string;
}) {
  const root = path.resolve(input.cacheRoot ?? immutableSourceCacheRoot());
  const profileFingerprint = assertHex(input.profileFingerprint, 64, "profile_fingerprint");
  const commit = assertHex(input.commit, 40, "commit");
  const expectedSha256 = assertHex(input.expectedSha256, 64, "sha256");
  return path.join(root, `${profileFingerprint}.${commit}.${expectedSha256}.bin`);
}

function cacheEvidence(classification: ImmutableSourceEvidence["classification"], bytes: Buffer | null): ImmutableSourceEvidence {
  return {
    source: "cache",
    endpointId: "immutable_cache",
    httpStatus: null,
    contentType: "application/octet-stream",
    responseByteLength: bytes?.length ?? null,
    bodySha256: bytes ? sha256(bytes) : null,
    classification,
    transportCode: null,
  };
}

function readVerifiedCache(
  cachePath: string,
  expectedSha256: string,
  maxBytes: number,
): { bytes: Buffer | null; evidence: ImmutableSourceEvidence } {
  if (!existsSync(cachePath)) return { bytes: null, evidence: cacheEvidence("cache_missing", null) };
  try {
    const size = statSync(cachePath).size;
    if (size < 1 || size > maxBytes) return { bytes: null, evidence: cacheEvidence("cache_corrupt", null) };
    const bytes = readFileSync(cachePath);
    if (sha256(bytes) !== expectedSha256) return { bytes: null, evidence: cacheEvidence("cache_corrupt", bytes) };
    return { bytes, evidence: cacheEvidence("cache_verified", bytes) };
  } catch {
    return { bytes: null, evidence: cacheEvidence("cache_corrupt", null) };
  }
}

function pruneCache(root: string, keepPath: string) {
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && CACHE_FILE_PATTERN.test(entry.name))
    .map((entry) => {
      const file = path.join(root, entry.name);
      return { file, mtimeMs: statSync(file).mtimeMs };
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  while (entries.length > MAX_CACHE_ENTRIES) {
    const oldest = entries.shift();
    if (!oldest || oldest.file === keepPath || path.dirname(oldest.file) !== root) continue;
    unlinkSync(oldest.file);
  }
}

function writeVerifiedCache(cachePath: string, bytes: Buffer) {
  const root = path.dirname(cachePath);
  mkdirSync(root, { recursive: true });
  const temporaryPath = path.join(root, `.${path.basename(cachePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(temporaryPath, "wx", 0o600);
  let closed = false;
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    closed = true;
  } finally {
    // A failed write must not leave a file that can be mistaken for a cache
    // entry on a later preflight.
    if (!closed) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write or fsync error.
      }
    }
  }
  try {
    if (existsSync(cachePath)) unlinkSync(cachePath);
    renameSync(temporaryPath, cachePath);
    pruneCache(root, cachePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original filesystem error.
    }
    throw error;
  }
}

async function readBoundedBody(response: Response, maxBytes: number) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function safeTextBody(bytes: Buffer) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const start = text.trimStart().slice(0, 32).toLowerCase();
    return !text.includes("\0")
      && !/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
      && !start.startsWith("<!doctype html")
      && !start.startsWith("<html");
  } catch {
    return false;
  }
}

function acceptableContent(contentType: string | null, bytes: Buffer) {
  const normalized = (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  return [
    "application/octet-stream",
    "application/x-python",
    "text/plain",
    "text/x-python",
  ].includes(normalized) || safeTextBody(bytes);
}

function transportCode(error: unknown, timedOut: boolean) {
  const candidate = error as { cause?: { code?: unknown }; code?: unknown; name?: unknown };
  const value = typeof candidate.cause?.code === "string"
    ? candidate.cause.code
    : typeof candidate.code === "string"
      ? candidate.code
      : timedOut
        ? "ETIMEDOUT"
        : typeof candidate.name === "string"
          ? candidate.name
          : "unknown";
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "unknown";
}

export async function resolveImmutableSource(input: {
  profileFingerprint: string;
  commit: string;
  sourcePath: string;
  expectedSha256: string;
  endpoints?: ImmutableSourceEndpoint[];
  cacheRoot?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<ResolvedImmutableSource> {
  const expectedSha256 = assertHex(input.expectedSha256, 64, "sha256");
  const cachePath = immutableSourceCachePath(input);
  const maxBytes = Math.max(1, Math.min(DEFAULT_MAX_SOURCE_BYTES, Math.floor(input.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES)));
  const evidence: ImmutableSourceEvidence[] = [];
  const cached = readVerifiedCache(cachePath, expectedSha256, maxBytes);
  evidence.push(cached.evidence);
  if (cached.bytes) {
    return {
      bytes: cached.bytes,
      sha256: expectedSha256,
      source: "cache",
      endpointId: "immutable_cache",
      evidence,
    };
  }

  const endpoints = input.endpoints ?? immutablePublicSourceEndpoints(input.commit, input.sourcePath);
  if (!endpoints.length || endpoints.length > 4 || new Set(endpoints.map((endpoint) => endpoint.id)).size !== endpoints.length) {
    throw new Error("immutable_source_endpoints_invalid");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1_000, Math.min(30_000, Math.floor(input.timeoutMs ?? 20_000)));
  for (const endpoint of endpoints) {
    if (!/^[a-z0-9_-]{1,48}$/.test(endpoint.id)) throw new Error("immutable_source_endpoint_id_invalid");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint.url, {
        method: "GET",
        headers: { Accept: "application/octet-stream, text/plain;q=0.9" },
        signal: controller.signal,
      });
      const advertised = response.headers.get("content-length");
      const advertisedOversized = advertised !== null
        && /^\d+$/.test(advertised)
        && Number(advertised) > maxBytes;
      if (advertisedOversized) {
        try {
          await response.body?.cancel();
        } catch {
          // The response is already unusable; continue with the next mirror.
        }
      }
      const bytes = advertisedOversized ? null : await readBoundedBody(response, maxBytes);
      const digest = bytes ? sha256(bytes) : null;
      const base = {
        source: "endpoint" as const,
        endpointId: endpoint.id,
        httpStatus: response.status,
        contentType: response.headers.get("content-type")?.slice(0, 160) ?? null,
        responseByteLength: bytes?.length ?? (advertisedOversized ? Number(advertised) : null),
        bodySha256: digest,
        transportCode: null,
      };
      if (!response.ok) {
        evidence.push({ ...base, classification: "http_failed" });
        continue;
      }
      if (!bytes || bytes.length < 1) {
        evidence.push({ ...base, classification: "size_invalid" });
        continue;
      }
      if (digest !== expectedSha256) {
        evidence.push({ ...base, classification: "sha256_mismatch" });
        throw new ImmutableSourceResolutionError("immutable_source_sha256_mismatch", evidence);
      }
      if (!acceptableContent(base.contentType, bytes)) {
        evidence.push({ ...base, classification: "content_incompatible" });
        continue;
      }
      evidence.push({ ...base, classification: "verified" });
      writeVerifiedCache(cachePath, bytes);
      return {
        bytes,
        sha256: digest,
        source: "endpoint",
        endpointId: endpoint.id,
        evidence,
      };
    } catch (error) {
      if (error instanceof ImmutableSourceResolutionError) throw error;
      evidence.push({
        source: "endpoint",
        endpointId: endpoint.id,
        httpStatus: null,
        contentType: null,
        responseByteLength: null,
        bodySha256: null,
        classification: "transport_failed",
        transportCode: transportCode(error, controller.signal.aborted),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new ImmutableSourceResolutionError("immutable_source_unavailable", evidence);
}
