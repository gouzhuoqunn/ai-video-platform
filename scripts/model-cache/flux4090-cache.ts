import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { FLUX_MODEL_FILES } from "../flux-first-image";
import { assertNoSecretOutput } from "../clore/client";
import { loadR2Credentials, type R2Credentials } from "./r2-presign";

const PREFIX = "production/rtx4090/image";
const REVISION = "flux2-klein-4b-5b4408e59397-a9e4ca87c16d";
const UPLOAD_PART_BYTES = 128 * 1024 * 1024;
const UPLOAD_QUEUE_SIZE = 4;
const HTTP_TIMEOUT_MS = 120_000;
const RANGE_BYTES = 1024;

export type FluxCacheFile = (typeof FLUX_MODEL_FILES)[number] & { relativePath: string };
export type FluxCacheManifest = ReturnType<typeof buildFluxCacheManifest>;
export type FluxCacheCurrent = { revision: string; manifest_key: string; published_at: string };

type SeedState = {
  files?: Record<string, { staging_key?: string; upload_id?: string; parts?: Array<{ number: number; etag: string }> }>;
};

export const fluxCacheFiles: FluxCacheFile[] = FLUX_MODEL_FILES.map((file) => ({
  ...file,
  relativePath: `${file.targetDirectory}/${file.filename}`,
}));
export const fluxCacheCurrentKey = `${PREFIX}/current.json`;
export const fluxCacheManifestKey = `${PREFIX}/revisions/${REVISION}/manifest.json`;

export function finalKey(file: FluxCacheFile) {
  return `${PREFIX}/revisions/${REVISION}/files/${file.relativePath}`;
}

export function selectFluxCacheFile(value: string) {
  const aliases: Record<string, string> = {
    flux: "flux-2-klein-4b-fp8.safetensors",
    qwen: "qwen_3_4b.safetensors",
    vae: "flux2-vae.safetensors",
  };
  const filename = aliases[value] ?? value;
  const file = fluxCacheFiles.find((candidate) => candidate.filename === filename || candidate.relativePath === filename);
  if (!file) throw new Error(`Unknown FLUX cache model: ${value}`);
  return file;
}

export function createS3Client(creds: R2Credentials) {
  return new S3Client({
    region: creds.region || "auto",
    endpoint: creds.endpoint,
    forcePathStyle: true,
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 15_000, socketTimeout: HTTP_TIMEOUT_MS }),
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}

export function sanitizeS3Error(error: unknown) {
  const candidate = error as {
    name?: string;
    Code?: string;
    code?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number; requestId?: string; attempts?: number };
  };
  return {
    name: candidate?.name ?? "Error",
    code: candidate?.Code ?? candidate?.code ?? candidate?.name ?? "unknown",
    message: String(candidate?.message ?? "").slice(0, 500),
    http_status: candidate?.$metadata?.httpStatusCode ?? null,
    request_id: candidate?.$metadata?.requestId ?? null,
    attempts: candidate?.$metadata?.attempts ?? null,
  };
}

function metadataSha(metadata: Record<string, string | undefined>) {
  return metadata.sha256 ?? metadata["expected-sha256"] ?? "";
}

async function headObject(client: S3Client, bucket: string, key: string) {
  try {
    const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, size: response.ContentLength ?? 0, metadata: response.Metadata ?? {} };
  } catch (error) {
    if (sanitizeS3Error(error).http_status === 404) return { exists: false, size: 0, metadata: {} };
    throw error;
  }
}

async function readObject(client: S3Client, bucket: string, key: string) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await response.Body?.transformToByteArray();
  if (!bytes) throw new Error(`R2 GET ${key} returned no body`);
  return Buffer.from(bytes);
}

async function readJson<T>(client: S3Client, bucket: string, key: string): Promise<T> {
  return JSON.parse((await readObject(client, bucket, key)).toString("utf8")) as T;
}

async function readRange(client: S3Client, bucket: string, key: string, start: number, end: number) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` }));
  const bytes = await response.Body?.transformToByteArray();
  if (!bytes || bytes.byteLength !== end - start + 1) throw new Error(`R2 range length mismatch for ${key}`);
  return bytes.byteLength;
}

export async function verifyLocalModelFile(filePath: string, file: FluxCacheFile) {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) throw new Error(`Local model file is missing: ${file.filename}`);
  const size = statSync(resolved).size;
  if (size !== file.size) throw new Error(`Local model size mismatch for ${file.filename}: ${size}`);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(resolved);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  const sha256 = hash.digest("hex");
  if (sha256 !== file.sha256) throw new Error(`Local model sha256 mismatch for ${file.filename}`);
  return { path: resolved, size, sha256 };
}

export function assertFreeDisk(targetPath: string, minimumGiB: number, availableBytesOverride?: number) {
  if (!Number.isFinite(minimumGiB) || minimumGiB <= 0) throw new Error("minimumGiB must be positive");
  const fileSystem = availableBytesOverride === undefined ? statfsSync(path.resolve(targetPath)) : undefined;
  const availableBytes = availableBytesOverride ?? Number(fileSystem?.bavail) * Number(fileSystem?.bsize);
  const requiredBytes = Math.ceil(minimumGiB * 1024 ** 3);
  if (availableBytes < requiredBytes) throw new Error(`runner_disk_gate_failed: available=${availableBytes} required=${requiredBytes}`);
  return { disk_gate_passed: true, available_bytes: availableBytes, minimum_gib: minimumGiB };
}

export async function verifyFinalObject(client: S3Client, bucket: string, file: FluxCacheFile) {
  const key = finalKey(file);
  const head = await headObject(client, bucket, key);
  if (!head.exists) throw new Error(`R2 final object missing: ${file.filename}`);
  if (head.size !== file.size) throw new Error(`R2 final object size mismatch for ${file.filename}: ${head.size}`);
  const sha256 = metadataSha(head.metadata);
  if (sha256 !== file.sha256) throw new Error(`R2 sha256 metadata mismatch for ${file.filename}`);
  const firstRangeBytes = await readRange(client, bucket, key, 0, Math.min(RANGE_BYTES - 1, file.size - 1));
  const lastRangeBytes = await readRange(client, bucket, key, Math.max(0, file.size - RANGE_BYTES), file.size - 1);
  return { filename: file.filename, key, size: head.size, sha256, first_range_bytes: firstRangeBytes, last_range_bytes: lastRangeBytes };
}

export async function verifyExistingModel(model: string) {
  const file = selectFluxCacheFile(model);
  const creds = loadR2Credentials("model-cache-readonly.env");
  const object = await verifyFinalObject(createS3Client(creds), creds.bucket, file);
  return { model_verified: true, [`${model}_verified`]: true, object };
}

export async function uploadLocalModel(model: string, filePath: string) {
  const file = selectFluxCacheFile(model);
  const local = await verifyLocalModelFile(filePath, file);
  const creds = loadR2Credentials("model-cache-admin.env");
  const client = createS3Client(creds);
  const existing = await headObject(client, creds.bucket, finalKey(file));
  if (existing.exists) {
    const object = await verifyFinalObject(client, creds.bucket, file);
    return { uploaded: false, reused: true, local, object };
  }

  const upload = new Upload({
    client,
    params: {
      Bucket: creds.bucket,
      Key: finalKey(file),
      Body: createReadStream(local.path),
      ContentType: "application/octet-stream",
      Metadata: { sha256: file.sha256, "expected-sha256": file.sha256, "expected-size": String(file.size), revision: REVISION },
    },
    partSize: UPLOAD_PART_BYTES,
    queueSize: UPLOAD_QUEUE_SIZE,
    leavePartsOnError: true,
  });
  let lastProgressAt = 0;
  upload.on("httpUploadProgress", (progress) => {
    const now = Date.now();
    const loaded = progress.loaded ?? 0;
    if (now - lastProgressAt >= 60_000 || loaded === file.size) {
      lastProgressAt = now;
      console.log(JSON.stringify({ stage: "r2_upload", filename: file.filename, uploaded_bytes: loaded, ratio: Number((loaded / file.size).toFixed(6)), at: new Date(now).toISOString() }));
    }
  });
  await upload.done();
  const object = await verifyFinalObject(client, creds.bucket, file);
  return { uploaded: true, reused: false, local, object };
}

export function buildFluxCacheManifest() {
  return {
    schema_version: 1,
    model: "FLUX.2-klein-4b",
    revision: REVISION,
    generated_at: new Date().toISOString(),
    files: fluxCacheFiles.map((file) => ({
      repository: file.repository,
      revision: file.revision,
      filename: file.filename,
      relative_path: file.relativePath,
      key: finalKey(file),
      size_bytes: file.size,
      sha256: file.sha256,
    })),
  };
}

function assertManifest(manifest: FluxCacheManifest) {
  if (manifest.revision !== REVISION || manifest.files.length !== fluxCacheFiles.length) throw new Error("R2 revision manifest mismatch");
  for (const file of fluxCacheFiles) {
    const entry = manifest.files.find((candidate) => candidate.relative_path === file.relativePath);
    if (!entry || entry.key !== finalKey(file) || entry.key.includes("/staging/") || entry.size_bytes !== file.size || entry.sha256 !== file.sha256 || entry.repository !== file.repository || entry.revision !== file.revision) {
      throw new Error(`R2 revision manifest entry mismatch for ${file.filename}`);
    }
  }
}

async function putJson(client: S3Client, bucket: string, key: string, value: unknown) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }));
  return body;
}

export async function publishFlux4090Cache() {
  const admin = loadR2Credentials("model-cache-admin.env");
  const client = createS3Client(admin);
  const objects = [];
  for (const file of fluxCacheFiles) objects.push(await verifyFinalObject(client, admin.bucket, file));
  const manifest = buildFluxCacheManifest();
  assertManifest(manifest);
  await putJson(client, admin.bucket, fluxCacheManifestKey, manifest);
  assertManifest(await readJson<FluxCacheManifest>(client, admin.bucket, fluxCacheManifestKey));
  const current: FluxCacheCurrent = { revision: REVISION, manifest_key: fluxCacheManifestKey, published_at: new Date().toISOString() };
  await putJson(client, admin.bucket, fluxCacheCurrentKey, current);
  const currentCheck = await readJson<FluxCacheCurrent>(client, admin.bucket, fluxCacheCurrentKey);
  if (currentCheck.revision !== REVISION || currentCheck.manifest_key !== fluxCacheManifestKey) throw new Error("R2 current.json verification failed");
  return { manifest_published: true, current_json_published: true, manifest_key: fluxCacheManifestKey, current_key: fluxCacheCurrentKey, objects };
}

function isAccessDenied(error: unknown) {
  const sanitized = sanitizeS3Error(error);
  return sanitized.http_status === 401 || sanitized.http_status === 403 || sanitized.code === "AccessDenied";
}

async function expectDenied(operation: () => Promise<unknown>, label: string) {
  try {
    await operation();
    return { label, denied: false, error: null };
  } catch (error) {
    if (!isAccessDenied(error)) throw error;
    return { label, denied: true, error: sanitizeS3Error(error) };
  }
}

export async function loadPublishedFluxCache() {
  const readonly = loadR2Credentials("model-cache-readonly.env");
  const client = createS3Client(readonly);
  const current = await readJson<FluxCacheCurrent>(client, readonly.bucket, fluxCacheCurrentKey);
  if (current.revision !== REVISION || current.manifest_key !== fluxCacheManifestKey) throw new Error("R2 current.json does not point to the locked FLUX revision");
  const manifest = await readJson<FluxCacheManifest>(client, readonly.bucket, current.manifest_key);
  assertManifest(manifest);
  return { readonly, client, current, manifest };
}

export async function verifyFlux4090Cache() {
  const published = await loadPublishedFluxCache();
  const objects = [];
  for (const file of fluxCacheFiles) objects.push(await verifyFinalObject(published.client, published.readonly.bucket, file));

  const admin = loadR2Credentials("model-cache-admin.env");
  const adminClient = createS3Client(admin);
  const putProbeKey = `${PREFIX}/probes/readonly-put-${randomUUID()}.txt`;
  const deleteProbeKey = `${PREFIX}/probes/readonly-delete-${randomUUID()}.txt`;
  const currentBody = await readObject(published.client, published.readonly.bucket, fluxCacheCurrentKey);
  await adminClient.send(new PutObjectCommand({ Bucket: admin.bucket, Key: deleteProbeKey, Body: Buffer.from("delete-probe\n") }));
  let putDenied;
  let deleteDenied;
  let overwriteDenied;
  try {
    putDenied = await expectDenied(() => published.client.send(new PutObjectCommand({ Bucket: published.readonly.bucket, Key: putProbeKey, Body: Buffer.from("blocked\n") })), "PutObject");
    deleteDenied = await expectDenied(() => published.client.send(new DeleteObjectCommand({ Bucket: published.readonly.bucket, Key: deleteProbeKey })), "DeleteObject");
    overwriteDenied = await expectDenied(() => published.client.send(new PutObjectCommand({ Bucket: published.readonly.bucket, Key: fluxCacheCurrentKey, Body: currentBody, ContentType: "application/json" })), "overwrite current.json");
  } finally {
    await adminClient.send(new DeleteObjectCommand({ Bucket: admin.bucket, Key: putProbeKey })).catch(() => undefined);
    await adminClient.send(new DeleteObjectCommand({ Bucket: admin.bucket, Key: deleteProbeKey })).catch(() => undefined);
  }
  if (!putDenied?.denied || !deleteDenied?.denied || !overwriteDenied?.denied) {
    await adminClient.send(new PutObjectCommand({ Bucket: admin.bucket, Key: fluxCacheCurrentKey, Body: currentBody, ContentType: "application/json" }));
    throw new Error("GPU readonly R2 credentials allowed a write operation");
  }
  return {
    flux4090_cache_complete: true,
    gpu_readonly_restore_probe: true,
    gpu_restore_ready: true,
    revision: REVISION,
    current_key: fluxCacheCurrentKey,
    manifest_key: fluxCacheManifestKey,
    objects,
    readonly_denials: [putDenied.label, deleteDenied.label, overwriteDenied.label],
  };
}

export function buildFirstImageRestorePlan(manifest: FluxCacheManifest) {
  assertManifest(manifest);
  const downloads = manifest.files.map((entry) => ({
    filename: entry.filename,
    object_key: entry.key,
    target_path: `/workspace/models/${entry.relative_path}`,
    size_bytes: entry.size_bytes,
    sha256: entry.sha256,
    source: "r2",
    fallback: `https://huggingface.co/${entry.repository}/resolve/${entry.revision}/${selectFluxCacheFile(entry.filename).remotePath}`,
  }));
  return {
    r2_restore_plan_valid: true,
    revision: manifest.revision,
    total_size_bytes: downloads.reduce((total, entry) => total + entry.size_bytes, 0),
    downloads,
    fallback_policy: "huggingface_only_after_r2_failure",
  };
}

export async function firstImageRestorePreflight() {
  const published = await loadPublishedFluxCache();
  const plan = buildFirstImageRestorePlan(published.manifest);
  for (const file of fluxCacheFiles) await verifyFinalObject(published.client, published.readonly.bucket, file);
  return plan;
}

export async function fluxCacheStatus() {
  try {
    const published = await loadPublishedFluxCache();
    const objects = [];
    for (const file of fluxCacheFiles) objects.push(await verifyFinalObject(published.client, published.readonly.bucket, file));
    return { ready: true, revision: REVISION, current_key: fluxCacheCurrentKey, manifest_key: fluxCacheManifestKey, total_size_bytes: fluxCacheFiles.reduce((total, file) => total + file.size, 0), objects };
  } catch (error) {
    return { ready: false, revision: REVISION, current_key: fluxCacheCurrentKey, error: sanitizeS3Error(error) };
  }
}

export async function abortEmptyMultipart(model: string, statePath: string) {
  const file = selectFluxCacheFile(model);
  const state = JSON.parse(readFileSync(path.resolve(statePath), "utf8")) as SeedState;
  const entry = state.files?.[file.relativePath];
  if (!entry?.staging_key || !entry.upload_id) throw new Error(`No recoverable multipart state for ${file.filename}`);
  const creds = loadR2Credentials("model-cache-admin.env");
  const client = createS3Client(creds);
  const listed = await client.send(new ListPartsCommand({ Bucket: creds.bucket, Key: entry.staging_key, UploadId: entry.upload_id }));
  const count = listed.Parts?.length ?? 0;
  if (count !== 0) throw new Error(`Refusing to abort multipart with ${count} parts for ${file.filename}`);
  await client.send(new AbortMultipartUploadCommand({ Bucket: creds.bucket, Key: entry.staging_key, UploadId: entry.upload_id }));
  const uploadIdHash = createHash("sha256").update(entry.upload_id).digest("hex").slice(0, 12);
  return { aborted: true, filename: file.filename, listed_parts: count, upload_id_hash: uploadIdHash };
}

async function main() {
  const [mode = "status", model = "", argument = ""] = process.argv.slice(2);
  const output =
    mode === "status"
      ? await fluxCacheStatus()
      : mode === "verify-object"
        ? await verifyExistingModel(model)
        : mode === "validate-local"
          ? await verifyLocalModelFile(argument, selectFluxCacheFile(model))
          : mode === "upload-local"
            ? await uploadLocalModel(model, argument)
            : mode === "publish"
              ? await publishFlux4090Cache()
              : mode === "verify"
                ? await verifyFlux4090Cache()
                : mode === "preflight"
                  ? await firstImageRestorePreflight()
                  : mode === "disk-guard"
                    ? assertFreeDisk(process.cwd(), Number(model))
                    : mode === "abort-empty-upload"
                      ? await abortEmptyMultipart(model, argument)
                      : (() => {
                          throw new Error(`Unknown FLUX cache command: ${mode}`);
                        })();
  const text = JSON.stringify(output, null, 2);
  assertNoSecretOutput(text);
  console.log(text);
}

if (process.argv[1]?.endsWith("flux4090-cache.ts")) {
  void main().catch((error) => {
    console.error(JSON.stringify({ error: sanitizeS3Error(error) }, null, 2));
    process.exitCode = 1;
  });
}
