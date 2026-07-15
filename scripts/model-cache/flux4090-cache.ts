import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
  type Part,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { FLUX_MODEL_FILES } from "../flux-first-image";
import { assertNoSecretOutput } from "../clore/client";
import { loadR2Credentials, type R2Credentials } from "./r2-presign";

const PREFIX = "production/rtx4090/image";
const PART_BYTES = 64 * 1024 * 1024;
const CONCURRENT_PARTS = 2;
const HTTP_TIMEOUT_MS = 120_000;
const STATE_DIR = process.env.FLUX_R2_SEED_STATE_DIR ? path.resolve(process.env.FLUX_R2_SEED_STATE_DIR) : path.join(process.cwd(), ".secrets");
const STATE_PATH = path.join(STATE_DIR, "flux4090-r2-seed-state.json");
const REVISION = "flux2-klein-4b-5b4408e59397-a9e4ca87c16d";

export type FluxCacheFile = (typeof FLUX_MODEL_FILES)[number] & { relativePath: string };
export type FluxCachePart = { number: number; etag: string; size?: number };
export type FluxCacheState = {
  session_id: string;
  revision: string;
  started_at: string;
  files: Record<
    string,
    {
      staging_key: string;
      upload_id?: string;
      parts: FluxCachePart[];
      expected_size?: number;
      expected_sha256?: string;
      uploaded_bytes?: number;
      source_sha256?: string;
      completed?: boolean;
    }
  >;
};

type Manifest = ReturnType<typeof buildFluxCacheManifest>;

export const fluxCacheFiles: FluxCacheFile[] = FLUX_MODEL_FILES.map((file) => ({ ...file, relativePath: `${file.targetDirectory}/${file.filename}` }));
export const fluxCacheCurrentKey = `${PREFIX}/current.json`;
export const fluxCacheManifestKey = `${PREFIX}/revisions/${REVISION}/manifest.json`;

function recoveryStagingKeys() {
  const raw = process.env.FLUX_R2_RECOVERY_STAGING_KEYS_JSON;
  if (!raw) return new Map<string, string>();
  const parsed = JSON.parse(raw) as Record<string, string>;
  return new Map(Object.entries(parsed));
}

function defaultEntry(sessionId: string, file: FluxCacheFile) {
  const recovery = recoveryStagingKeys().get(file.relativePath);
  return {
    staging_key: recovery ?? `${PREFIX}/staging/${sessionId}/files/${file.relativePath}`,
    parts: [],
    expected_size: file.size,
    expected_sha256: file.sha256,
    uploaded_bytes: 0,
  };
}

function readState(): FluxCacheState {
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")) as FluxCacheState;
  const sessionId = randomUUID();
  return {
    session_id: sessionId,
    revision: REVISION,
    started_at: new Date().toISOString(),
    files: Object.fromEntries(fluxCacheFiles.map((file) => [file.relativePath, defaultEntry(sessionId, file)])),
  };
}

function saveState(state: FluxCacheState) {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const temporary = `${STATE_PATH}.part`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, STATE_PATH);
}

function sourceUrl(file: FluxCacheFile) {
  return `https://huggingface.co/${file.repository}/resolve/${file.revision}/${file.remotePath}`;
}

function finalKey(file: FluxCacheFile) {
  return `${PREFIX}/revisions/${REVISION}/files/${file.relativePath}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createS3Client(creds: R2Credentials) {
  return new S3Client({
    region: creds.region || "auto",
    endpoint: creds.endpoint,
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 15_000, socketTimeout: Number(process.env.FLUX_R2_HTTP_TIMEOUT_MS ?? HTTP_TIMEOUT_MS) }),
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}

export function sanitizeS3Error(error: unknown) {
  const candidate = error as { name?: string; Code?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
  return {
    name: candidate?.name ?? "Error",
    code: candidate?.Code ?? candidate?.code ?? candidate?.name ?? "unknown",
    message: String(candidate?.message ?? "").slice(0, 500),
    http_status: candidate?.$metadata?.httpStatusCode ?? null,
    request_id: candidate?.$metadata?.requestId ?? null,
  };
}

function assertCompleteParts(parts: FluxCachePart[], expectedTotalParts?: number): CompletedPart[] {
  const sorted = [...parts].sort((a, b) => a.number - b.number);
  const seen = new Set<number>();
  for (let index = 0; index < sorted.length; index += 1) {
    const part = sorted[index];
    if (!part.number || part.number < 1) throw new Error("invalid multipart part number");
    if (seen.has(part.number)) throw new Error(`duplicate multipart part ${part.number}`);
    if (!part.etag) throw new Error(`multipart part ${part.number} is missing ETag`);
    if (expectedTotalParts && part.number !== index + 1) throw new Error(`missing multipart part ${index + 1}`);
    seen.add(part.number);
  }
  if (expectedTotalParts && sorted.length !== expectedTotalParts) throw new Error(`missing multipart part ${sorted.length + 1}`);
  return sorted.map((part) => ({ PartNumber: part.number, ETag: part.etag }));
}

async function headSize(client: S3Client, bucket: string, key: string) {
  try {
    const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, size: response.ContentLength ?? 0, metadata: response.Metadata ?? {} };
  } catch (error) {
    if (sanitizeS3Error(error).http_status === 404) return { exists: false, size: 0, metadata: {} };
    throw error;
  }
}

async function getJson<T>(client: S3Client, bucket: string, key: string): Promise<T> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await response.Body?.transformToString();
  if (!text) throw new Error(`R2 GET ${key} returned empty body`);
  return JSON.parse(text) as T;
}

async function fetchSourcePart(file: FluxCacheFile, number: number, start: number, end: number) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.FLUX_R2_HTTP_TIMEOUT_MS ?? HTTP_TIMEOUT_MS));
    try {
      const source = await fetch(sourceUrl(file), { headers: { Range: `bytes=${start}-${end}` }, redirect: "follow", signal: controller.signal });
      if (!(source.ok || source.status === 206)) throw new Error(`HF part ${number} status ${source.status}`);
      const body = Buffer.from(await source.arrayBuffer());
      if (body.byteLength !== end - start + 1) throw new Error(`HF part ${number} length mismatch`);
      return { number, body };
    } catch (error) {
      lastError = error;
      await sleep(1000 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function listAllParts(client: S3Client, bucket: string, key: string, uploadId: string): Promise<FluxCachePart[]> {
  const parts: FluxCachePart[] = [];
  let marker: string | undefined;
  do {
    const response = await client.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }));
    for (const part of response.Parts ?? []) {
      if (!part.PartNumber || !part.ETag) throw new Error("R2 ListParts returned an incomplete part entry");
      parts.push({ number: part.PartNumber, etag: part.ETag, size: part.Size });
    }
    marker = response.NextPartNumberMarker;
  } while (marker);
  return parts;
}

async function createMultipart(client: S3Client, bucket: string, key: string, file: FluxCacheFile) {
  const response = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: "application/octet-stream",
      Metadata: { "expected-sha256": file.sha256, "expected-size": String(file.size), revision: REVISION },
    }),
  );
  if (!response.UploadId) throw new Error("CreateMultipartUpload did not return UploadId");
  return response.UploadId;
}

async function uploadPart(client: S3Client, bucket: string, key: string, uploadId: string, number: number, body: Buffer) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const uploaded = await client.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: number, Body: body }));
      if (!uploaded.ETag) throw new Error(`UploadPart ${number} did not return ETag`);
      return uploaded.ETag;
    } catch (error) {
      lastError = error;
      await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

async function copyToFinal(client: S3Client, bucket: string, sourceKey: string, targetKey: string, file: FluxCacheFile) {
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: targetKey,
      CopySource: `${bucket}/${sourceKey}`,
      MetadataDirective: "REPLACE",
      Metadata: { "expected-sha256": file.sha256, "expected-size": String(file.size), revision: REVISION },
    }),
  );
  const final = await headSize(client, bucket, targetKey);
  if (!final.exists || final.size !== file.size) throw new Error(`R2 final object size mismatch for ${file.filename}`);
}

async function reuseCompletedObjectIfPossible(client: S3Client, bucket: string, state: FluxCacheState, file: FluxCacheFile) {
  const entry = state.files[file.relativePath];
  const final = await headSize(client, bucket, finalKey(file));
  if (final.exists) {
    if (final.size !== file.size) throw new Error(`R2 final object size mismatch for ${file.filename}`);
    entry.completed = true;
    entry.uploaded_bytes = file.size;
    entry.source_sha256 = file.sha256;
    saveState(state);
    return { reused: true, source: "final" };
  }
  const staging = await headSize(client, bucket, entry.staging_key);
  if (staging.exists) {
    if (staging.size !== file.size) throw new Error(`R2 staging object size mismatch for ${file.filename}`);
    await copyToFinal(client, bucket, entry.staging_key, finalKey(file), file);
    entry.completed = true;
    entry.uploaded_bytes = file.size;
    entry.source_sha256 = file.sha256;
    saveState(state);
    return { reused: true, source: "completed_staging" };
  }
  return { reused: false, source: "none" };
}

async function streamFileToMultipart(client: S3Client, bucket: string, state: FluxCacheState, file: FluxCacheFile, deadline: number) {
  const entry = state.files[file.relativePath] ?? defaultEntry(state.session_id, file);
  state.files[file.relativePath] = entry;
  if (entry.completed) return { file: file.filename, uploaded: false, reused: "state_completed" };
  const reused = await reuseCompletedObjectIfPossible(client, bucket, state, file);
  if (reused.reused) return { file: file.filename, uploaded: false, reused: reused.source };

  entry.expected_size = file.size;
  entry.expected_sha256 = file.sha256;
  entry.upload_id ??= await createMultipart(client, bucket, entry.staging_key, file);
  saveState(state);

  const existing = await listAllParts(client, bucket, entry.staging_key, entry.upload_id).catch((error) => {
    if (sanitizeS3Error(error).code === "NoSuchUpload") return [];
    throw error;
  });
  const completed = new Map(existing.map((part) => [part.number, part]));
  entry.parts = existing;
  entry.uploaded_bytes = existing.reduce((total, part) => total + (part.size ?? Math.min(PART_BYTES, Math.max(0, file.size - (part.number - 1) * PART_BYTES))), 0);
  saveState(state);

  const totalParts = Math.ceil(file.size / PART_BYTES);
  const hash = createHash("sha256");
  for (let number = 1; number <= totalParts; number += CONCURRENT_PARTS) {
    if (Date.now() > deadline) throw new Error("seed_time_limit_reached");
    const batchNumbers = Array.from({ length: Math.min(CONCURRENT_PARTS, totalParts - number + 1) }, (_, index) => number + index);
    const batch = await Promise.all(
      batchNumbers.map((partNumber) => {
        const start = (partNumber - 1) * PART_BYTES;
        const end = Math.min(file.size - 1, start + PART_BYTES - 1);
        return fetchSourcePart(file, partNumber, start, end);
      }),
    );
    for (const { number: partNumber, body } of batch.sort((a, b) => a.number - b.number)) {
      hash.update(body);
      if (completed.has(partNumber)) continue;
      const etag = await uploadPart(client, bucket, entry.staging_key, entry.upload_id, partNumber, body);
      const part = { number: partNumber, etag, size: body.byteLength };
      completed.set(partNumber, part);
      entry.parts = [...completed.values()].sort((a, b) => a.number - b.number);
      entry.uploaded_bytes = (entry.uploaded_bytes ?? 0) + body.byteLength;
      saveState(state);
    }
  }

  entry.source_sha256 = hash.digest("hex");
  if (entry.source_sha256 !== file.sha256) throw new Error(`HF source sha256 mismatch for ${file.filename}`);
  const parts = assertCompleteParts([...completed.values()], totalParts);
  await client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: entry.staging_key, UploadId: entry.upload_id, MultipartUpload: { Parts: parts } }));
  const staging = await headSize(client, bucket, entry.staging_key);
  if (!staging.exists || staging.size !== file.size) throw new Error(`R2 staging size mismatch for ${file.filename}`);
  await copyToFinal(client, bucket, entry.staging_key, finalKey(file), file);
  entry.completed = true;
  entry.uploaded_bytes = file.size;
  saveState(state);
  return { file: file.filename, uploaded: true, reused: false };
}

export function buildFluxCacheManifest() {
  return {
    schema_version: 1,
    model: "FLUX.2-klein-4b",
    revision: REVISION,
    generated_at: new Date().toISOString(),
    files: fluxCacheFiles.map((file) => ({ relative_path: file.relativePath, repository: file.repository, revision: file.revision, size_bytes: file.size, sha256: file.sha256, key: finalKey(file) })),
  };
}

async function publishJson(client: S3Client, bucket: string, key: string, body: unknown) {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from(`${JSON.stringify(body, null, 2)}\n`), ContentType: "application/json" }));
}

export async function seedFlux4090Cache(maxMinutes = 120) {
  const creds = loadR2Credentials("model-cache-admin.env");
  const client = createS3Client(creds);
  const state = readState();
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  const fileResults = [];
  for (const file of fluxCacheFiles) fileResults.push(await streamFileToMultipart(client, creds.bucket, state, file, deadline));
  for (const file of fluxCacheFiles) {
    const head = await headSize(client, creds.bucket, finalKey(file));
    if (!head.exists || head.size !== file.size) throw new Error(`R2 final object missing before manifest publish: ${file.filename}`);
  }
  const manifest = buildFluxCacheManifest();
  await publishJson(client, creds.bucket, fluxCacheManifestKey, manifest);
  const manifestCheck = await getJson<Manifest>(client, creds.bucket, fluxCacheManifestKey);
  if (manifestCheck.revision !== REVISION || manifestCheck.files.length !== fluxCacheFiles.length) throw new Error("R2 revision manifest verification failed");
  await publishJson(client, creds.bucket, fluxCacheCurrentKey, { revision: REVISION, manifest_key: fluxCacheManifestKey, published_at: new Date().toISOString() });
  const current = await getJson<{ revision: string; manifest_key: string }>(client, creds.bucket, fluxCacheCurrentKey);
  if (current.revision !== REVISION || current.manifest_key !== fluxCacheManifestKey) throw new Error("R2 current.json verification failed");
  return { complete: true, revision: REVISION, current_json_published: true, file_results: fileResults, files: fluxCacheFiles.map((file) => ({ filename: file.filename, sha256: file.sha256, size: file.size, key: finalKey(file) })) };
}

export function fluxCacheStatus() {
  const state = readState();
  return {
    revision: state.revision,
    current_key: fluxCacheCurrentKey,
    local_temp_bytes: 0,
    state_path: STATE_PATH.replace(process.cwd(), "."),
    files: fluxCacheFiles.map((file) => ({ filename: file.filename, expected_size: file.size, expected_sha256: file.sha256, uploaded_parts: state.files[file.relativePath]?.parts.length ?? 0, uploaded_bytes: state.files[file.relativePath]?.uploaded_bytes ?? 0, completed: state.files[file.relativePath]?.completed === true })),
  };
}

async function readRange(client: S3Client, bucket: string, key: string, start: number, end: number) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` }));
  const body = await response.Body?.transformToByteArray();
  if (!body || body.byteLength !== end - start + 1) throw new Error(`R2 range length mismatch for ${key}`);
  return body.byteLength;
}

export async function verifyFlux4090Cache() {
  const creds = loadR2Credentials("model-cache-readonly.env");
  const client = createS3Client(creds);
  const current = await getJson<{ revision: string; manifest_key: string }>(client, creds.bucket, fluxCacheCurrentKey);
  if (current.revision !== REVISION || current.manifest_key !== fluxCacheManifestKey) throw new Error("R2 current.json does not point to the expected FLUX4090 revision");
  const manifest = await getJson<Manifest>(client, creds.bucket, current.manifest_key);
  if (manifest.revision !== REVISION || manifest.files.length !== fluxCacheFiles.length) throw new Error("R2 revision manifest mismatch");
  const objects = [];
  for (const file of fluxCacheFiles) {
    const manifestFile = manifest.files.find((item) => item.relative_path === file.relativePath);
    if (!manifestFile) throw new Error(`R2 revision manifest missing ${file.filename}`);
    if (manifestFile.size_bytes !== file.size || manifestFile.sha256 !== file.sha256 || manifestFile.key.includes("/staging/")) throw new Error(`R2 manifest metadata mismatch for ${file.filename}`);
    const head = await headSize(client, creds.bucket, manifestFile.key);
    if (!head.exists || head.size !== file.size) throw new Error(`R2 final object size mismatch for ${file.filename}`);
    const first_range_bytes = await readRange(client, creds.bucket, manifestFile.key, 0, Math.min(1023, file.size - 1));
    const last_range_bytes = await readRange(client, creds.bucket, manifestFile.key, Math.max(0, file.size - 1024), file.size - 1);
    objects.push({ filename: file.filename, key: manifestFile.key, size: head.size, sha256: file.sha256, first_range_bytes, last_range_bytes });
  }
  const writeProbe = await client.send(new PutObjectCommand({ Bucket: creds.bucket, Key: `${PREFIX}/readonly-probe-blocked.txt`, Body: Buffer.from("blocked\n") })).then(() => ({ ok: true }), (error) => ({ ok: false, error: sanitizeS3Error(error) }));
  if (writeProbe.ok) throw new Error("GPU readonly R2 credentials unexpectedly allowed PUT");
  return { flux4090_cache_complete: true, gpu_readonly_restore_probe: true, revision: REVISION, current_key: fluxCacheCurrentKey, manifest_key: fluxCacheManifestKey, objects };
}

export async function probeFlux4090Multipart() {
  const creds = loadR2Credentials("model-cache-admin.env");
  const client = createS3Client(creds);
  const key = `${PREFIX}/probes/sdk-multipart-${Date.now()}-${randomUUID()}.bin`;
  const first = Buffer.alloc(8 * 1024 * 1024, 0x31);
  const second = Buffer.alloc(4 * 1024 * 1024, 0x32);
  let uploadId: string | undefined;
  const steps: Array<Record<string, unknown>> = [];
  try {
    const created = await client.send(new CreateMultipartUploadCommand({ Bucket: creds.bucket, Key: key, ContentType: "application/octet-stream" }));
    uploadId = created.UploadId;
    steps.push({ step: "CreateMultipartUpload", ok: true });
    const part1 = await client.send(new UploadPartCommand({ Bucket: creds.bucket, Key: key, UploadId: uploadId, PartNumber: 1, Body: first }));
    const part2 = await client.send(new UploadPartCommand({ Bucket: creds.bucket, Key: key, UploadId: uploadId, PartNumber: 2, Body: second }));
    steps.push({ step: "UploadPart", ok: true, parts: 2, etags_present: Boolean(part1.ETag && part2.ETag) });
    const listed = await client.send(new ListPartsCommand({ Bucket: creds.bucket, Key: key, UploadId: uploadId }));
    steps.push({ step: "ListParts", ok: true, count: listed.Parts?.length ?? 0 });
    await client.send(new CompleteMultipartUploadCommand({ Bucket: creds.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part1.ETag }, { PartNumber: 2, ETag: part2.ETag }] } }));
    steps.push({ step: "CompleteMultipartUpload", ok: true });
    const head = await headSize(client, creds.bucket, key);
    steps.push({ step: "HeadObject", ok: true, content_length: head.size });
    await client.send(new DeleteObjectCommand({ Bucket: creds.bucket, Key: key }));
    steps.push({ step: "DeleteObject", ok: true });
    return { sdk_multipart_probe_success: true, steps };
  } catch (error) {
    if (uploadId) {
      // Preserve real cache uploads, but clean up the tiny probe if it is still open.
      await client.send(new DeleteObjectCommand({ Bucket: creds.bucket, Key: key })).catch(() => undefined);
    }
    return { sdk_multipart_probe_success: false, steps, error: sanitizeS3Error(error) };
  }
}

async function main() {
  const mode = process.argv[2] ?? "status";
  const output =
    mode === "status"
      ? fluxCacheStatus()
      : mode === "verify"
        ? await verifyFlux4090Cache()
        : mode === "probe"
          ? await probeFlux4090Multipart()
          : await seedFlux4090Cache(Number(process.env.FLUX_R2_SEED_MAX_MINUTES ?? 120));
  const text = JSON.stringify(output, null, 2);
  assertNoSecretOutput(text);
  console.log(text);
  if (mode === "probe" && "sdk_multipart_probe_success" in output && !output.sdk_multipart_probe_success) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("flux4090-cache.ts")) {
  void main().catch((error) => {
    console.error(JSON.stringify({ error: sanitizeS3Error(error) }, null, 2));
    process.exitCode = 1;
  });
}
