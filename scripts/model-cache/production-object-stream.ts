import { createHash, type Hash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { loadProductionFamilies, type ProductionObject } from "./production-model-cache";
import { loadR2Credentials, type R2Credentials } from "./r2-presign";

export const STREAM_CHUNK_BYTES = 256 * 1024 * 1024;
export const MAX_STREAM_TEMP_BYTES = 768 * 1024 * 1024;
if (STREAM_CHUNK_BYTES * 2 > MAX_STREAM_TEMP_BYTES) throw new Error("stream_temp_bound_invalid");
const STALL_MS = 60_000;
const MAX_REDIRECTS = 8;
const MAX_RANGE_ATTEMPTS = 5;
const FALLBACK_MARGIN_BYTES = 6 * 1024 ** 3;

type Strategy = "ranged-stream" | "full-file";
type RangeResult = {
  response: Response;
  controller: AbortController;
  totalBytes: number;
  redirects: number;
  authorizationRedactedOnCrossOrigin: boolean;
};
type StreamState = {
  schemaVersion: 1;
  familyId: string;
  path: string;
  finalKey: string;
  uploadId: string;
  bytes: number;
  sha256: string;
  chunkBytes: number;
  completedPartNumbers: number[];
};

function secretFromFile(filePath: string, name: string) {
  if (!existsSync(filePath)) return "";
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`).exec(line);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

function sourceToken(source: string) {
  if (source.includes("civitai.com")) return process.env.CIVITAI_API_TOKEN?.trim() || secretFromFile(path.join(process.cwd(), ".secrets", "civitai.env"), "CIVITAI_API_TOKEN");
  if (source.includes("huggingface.co")) return process.env.HF_TOKEN?.trim() || secretFromFile(path.join(process.cwd(), ".secrets", "huggingface.env"), "HF_TOKEN");
  return "";
}

function sourceType(source: string) {
  if (source.includes("civitai.com")) return "civitai";
  if (source.includes("huggingface.co")) return "huggingface";
  return "unknown";
}

function createS3Client(creds: R2Credentials) {
  return new S3Client({
    region: creds.region || "auto",
    endpoint: creds.endpoint,
    forcePathStyle: true,
    maxAttempts: 4,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 15_000, socketTimeout: 120_000 }),
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}

async function bodyBuffer(body: unknown) {
  if (!body || typeof body !== "object" || !("transformToByteArray" in body)) throw new Error("r2_body_missing");
  return Buffer.from(await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
}

async function remoteExists(client: S3Client, bucket: string, key: string) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

function parseContentRange(value: string | null, start: number, end: number) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match || Number(match[1]) !== start || Number(match[2]) !== end) throw new Error("source_content_range_invalid");
  return Number(match[3]);
}

export async function requestSource(source: string, token: string, range?: { start: number; end: number }): Promise<RangeResult> {
  const sourceOrigin = new URL(source).origin;
  let current = source;
  let redirects = 0;
  let authorizationAllowed = true;
  let authorizationRedactedOnCrossOrigin = false;
  while (true) {
    const controller = new AbortController();
    const headerTimeout = setTimeout(() => controller.abort(), 30_000);
    const headers: Record<string, string> = { "User-Agent": "ai-video-platform-stage4b", "Accept-Encoding": "identity" };
    if (range) headers.Range = `bytes=${range.start}-${range.end}`;
    if (token && authorizationAllowed) headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      try {
        response = await fetch(current, { headers, redirect: "manual", signal: controller.signal });
      } catch (error) {
        const cause = (error as { cause?: { code?: string; name?: string } }).cause;
        const classification = cause?.code || cause?.name || (error instanceof Error ? error.name : "unknown");
        throw new Error(`source_fetch_failed:${sourceType(source)}:${classification}`);
      }
    } finally {
      clearTimeout(headerTimeout);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (++redirects > MAX_REDIRECTS) throw new Error("source_redirect_limit");
      const location = response.headers.get("location");
      if (!location) throw new Error("source_redirect_location_missing");
      const next = new URL(location, current).toString();
      if (new URL(next).origin !== sourceOrigin) {
        authorizationAllowed = false;
        authorizationRedactedOnCrossOrigin = true;
      }
      await response.body?.cancel();
      current = next;
      continue;
    }
    if (range && response.status !== 206) throw new Error(`source_range_unsupported:${response.status}`);
    if (!range && !response.ok) throw new Error(`source_get_failed:${response.status}`);
    const totalBytes = range
      ? parseContentRange(response.headers.get("content-range"), range.start, range.end)
      : Number(response.headers.get("content-length"));
    return { response, controller, totalBytes, redirects, authorizationRedactedOnCrossOrigin };
  }
}

async function responseToFile(result: RangeResult, filePath: string, expectedBytes: number, heartbeat: (bytes: number) => void) {
  if (!result.response.body) throw new Error("source_body_missing");
  const handle = await open(filePath, "w");
  const reader = result.response.body.getReader();
  let written = 0;
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("source_read_stalled")), STALL_MS);
      });
      const next = await Promise.race([reader.read(), stalled]);
      if (timer) clearTimeout(timer);
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      await handle.write(chunk);
      written += chunk.length;
      heartbeat(written);
    }
  } catch (error) {
    result.controller.abort();
    throw error;
  } finally {
    await handle.close();
  }
  if (written !== expectedBytes) throw new Error(`source_range_size_mismatch:${written}:${expectedBytes}`);
  return written;
}

async function hashFile(hash: Hash, filePath: string) {
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
}

async function downloadRange(
  file: ProductionObject,
  start: number,
  end: number,
  target: string,
  heartbeat: (bytes: number) => void,
) {
  const token = sourceToken(file.source);
  if (!token) throw new Error(`source_token_missing:${sourceType(file.source)}`);
  let retries = 0;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RANGE_ATTEMPTS; attempt += 1) {
    try {
      if (existsSync(target)) unlinkSync(target);
      const result = await requestSource(file.source, token, { start, end });
      if (result.totalBytes !== file.bytes) throw new Error(`source_total_size_mismatch:${result.totalBytes}:${file.bytes}`);
      await responseToFile(result, target, end - start + 1, heartbeat);
      return { redirects: result.redirects, authorizationRedactedOnCrossOrigin: result.authorizationRedactedOnCrossOrigin, retries };
    } catch (error) {
      lastError = error;
      retries += 1;
      if (existsSync(target)) unlinkSync(target);
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    }
  }
  throw new Error(`source_range_retry_exhausted:${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function updateState(client: S3Client, bucket: string, key: string, state: StreamState) {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: `${JSON.stringify(state)}\n`, ContentType: "application/json" }));
}

async function loadState(client: S3Client, bucket: string, key: string) {
  if (!await remoteExists(client, bucket, key)) return null;
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse((await bodyBuffer(response.Body)).toString("utf8")) as StreamState;
}

async function listUploadedParts(client: S3Client, bucket: string, key: string, uploadId: string) {
  const parts: Array<{ ETag: string; PartNumber: number; Size: number }> = [];
  let marker: string | undefined;
  do {
    const page = await client.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }));
    for (const part of page.Parts ?? []) {
      if (!part.ETag || !part.PartNumber || part.Size === undefined) throw new Error("multipart_list_part_invalid");
      parts.push({ ETag: part.ETag, PartNumber: part.PartNumber, Size: part.Size });
    }
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (marker);
  return parts;
}

async function verifyFinal(client: S3Client, bucket: string, key: string, file: ProductionObject) {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (head.ContentLength !== file.bytes || head.Metadata?.sha256 !== file.sha256) throw new Error("r2_final_identity_mismatch");
  const first = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: "bytes=0-0" }));
  const last = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${file.bytes - 1}-${file.bytes - 1}` }));
  if ((await bodyBuffer(first.Body)).length !== 1 || (await bodyBuffer(last.Body)).length !== 1) throw new Error("r2_final_range_mismatch");
}

export async function streamObject(familyId: string, objectPath: string, strategy: Strategy = "ranged-stream") {
  const family = loadProductionFamilies().find((entry) => entry.id === familyId);
  const file = family?.objects.find((entry) => entry.path === objectPath);
  if (!family || !file) throw new Error("unknown_production_object");
  const key = `${family.r2Prefix}/objects/${file.sha256}`;
  const stateKey = `production/streaming-state/${file.sha256}.json`;
  const creds = loadR2Credentials("model-cache-admin.env");
  const client = createS3Client(creds);
  const started = Date.now();
  try {
    if (await remoteExists(client, creds.bucket, key)) {
      await verifyFinal(client, creds.bucket, key, file);
      const staleState = await loadState(client, creds.bucket, stateKey);
      if (staleState) {
        await client.send(new AbortMultipartUploadCommand({
          Bucket: creds.bucket,
          Key: staleState.finalKey,
          UploadId: staleState.uploadId,
        })).catch(() => undefined);
        await client.send(new DeleteObjectCommand({ Bucket: creds.bucket, Key: stateKey }));
      }
      console.log(JSON.stringify({ stage: "object_transfer_metrics", logicalObjectKey: file.path, downloadedBytes: 0, reusedBytes: file.bytes, durationSeconds: 0, averageBytesPerSecond: 0, retries: 0, peakLocalBytes: 0 }));
      return { logicalObjectKey: file.path, finalR2Key: key, size: file.bytes, sha256: file.sha256, sourceType: sourceType(file.source), status: "reused", completionStatus: "completed" };
    }
    if (strategy === "full-file") return await fullFileFallback(client, creds.bucket, family.id, file, key, started);
    const tempRoot = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "stage4b-stream", file.sha256.slice(0, 12));
    mkdirSync(tempRoot, { recursive: true });
    let state = await loadState(client, creds.bucket, stateKey);
    if (state && (state.schemaVersion !== 1 || state.familyId !== family.id || state.path !== file.path || state.finalKey !== key || state.bytes !== file.bytes || state.sha256 !== file.sha256 || state.chunkBytes !== STREAM_CHUNK_BYTES)) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: creds.bucket, Key: state.finalKey, UploadId: state.uploadId })).catch(() => undefined);
      await client.send(new DeleteObjectCommand({ Bucket: creds.bucket, Key: stateKey }));
      throw new Error("multipart_stream_state_mismatch");
    }
    if (!state) {
      const created = await client.send(new CreateMultipartUploadCommand({ Bucket: creds.bucket, Key: key, ContentType: "application/octet-stream", Metadata: { sha256: file.sha256, family: family.id, role: file.role, source: sourceType(file.source) } }));
      if (!created.UploadId) throw new Error("multipart_upload_id_missing");
      state = { schemaVersion: 1, familyId: family.id, path: file.path, finalKey: key, uploadId: created.UploadId, bytes: file.bytes, sha256: file.sha256, chunkBytes: STREAM_CHUNK_BYTES, completedPartNumbers: [] };
      await updateState(client, creds.bucket, stateKey, state);
    }
    const ranges = Array.from({ length: Math.ceil(file.bytes / STREAM_CHUNK_BYTES) }, (_, index) => ({ partNumber: index + 1, start: index * STREAM_CHUNK_BYTES, end: Math.min(file.bytes, (index + 1) * STREAM_CHUNK_BYTES) - 1 }));
    const listed = await listUploadedParts(client, creds.bucket, key, state.uploadId);
    const uploaded = new Map(listed.map((part) => [part.PartNumber, part]));
    for (const range of ranges) {
      const existing = uploaded.get(range.partNumber);
      if (existing && existing.Size !== range.end - range.start + 1) {
        await client.send(new AbortMultipartUploadCommand({ Bucket: creds.bucket, Key: key, UploadId: state.uploadId }));
        await client.send(new DeleteObjectCommand({ Bucket: creds.bucket, Key: stateKey }));
        throw new Error(`multipart_part_size_mismatch:${range.partNumber}`);
      }
    }
    const hash = createHash("sha256");
    let retries = 0;
    let downloadedBytes = 0;
    let rangeProgress = 0;
    const heartbeat = setInterval(() => console.log(JSON.stringify({ stage: "object_stream_heartbeat", logicalObjectKey: file.path, downloadedBytes, currentRangeBytes: rangeProgress, expectedBytes: file.bytes, at: new Date().toISOString() })), 45_000);
    try {
      for (const range of ranges) {
        const chunkPath = path.join(tempRoot, `part-${String(range.partNumber).padStart(5, "0")}.chunk`);
        rangeProgress = 0;
        const transfer = await downloadRange(file, range.start, range.end, chunkPath, (bytes) => { rangeProgress = bytes; });
        retries += transfer.retries;
        downloadedBytes += range.end - range.start + 1;
        await hashFile(hash, chunkPath);
        if (!uploaded.has(range.partNumber)) {
          let uploadedPart: { ETag?: string } | undefined;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
              uploadedPart = await client.send(new UploadPartCommand({ Bucket: creds.bucket, Key: key, UploadId: state.uploadId, PartNumber: range.partNumber, Body: createReadStream(chunkPath), ContentLength: range.end - range.start + 1 }));
              break;
            } catch (error) {
              retries += 1;
              if (attempt === 3) throw error;
              await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
            }
          }
          if (!uploadedPart?.ETag) throw new Error(`multipart_part_etag_missing:${range.partNumber}`);
          uploaded.set(range.partNumber, { ETag: uploadedPart.ETag, PartNumber: range.partNumber, Size: range.end - range.start + 1 });
          state.completedPartNumbers = [...uploaded.keys()].sort((left, right) => left - right);
          await updateState(client, creds.bucket, stateKey, state);
        }
        unlinkSync(chunkPath);
      }
    } finally {
      clearInterval(heartbeat);
    }
    const digest = hash.digest("hex");
    if (digest !== file.sha256 || downloadedBytes !== file.bytes) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: creds.bucket, Key: key, UploadId: state.uploadId }));
      await client.send(new DeleteObjectCommand({ Bucket: creds.bucket, Key: stateKey }));
      throw new Error(`stream_identity_mismatch:${downloadedBytes}:${digest}`);
    }
    const orderedParts = ranges.map((range) => {
      const part = uploaded.get(range.partNumber);
      if (!part) throw new Error(`multipart_part_missing:${range.partNumber}`);
      return { PartNumber: part.PartNumber, ETag: part.ETag };
    });
    await client.send(new CompleteMultipartUploadCommand({ Bucket: creds.bucket, Key: key, UploadId: state.uploadId, MultipartUpload: { Parts: orderedParts } }));
    await client.send(new DeleteObjectCommand({ Bucket: creds.bucket, Key: stateKey }));
    await verifyFinal(client, creds.bucket, key, file);
    const durationSeconds = (Date.now() - started) / 1000;
    console.log(JSON.stringify({ stage: "object_transfer_metrics", logicalObjectKey: file.path, strategy: "ranged-stream", downloadedBytes, reusedBytes: 0, durationSeconds: Number(durationSeconds.toFixed(3)), averageBytesPerSecond: Math.round(downloadedBytes / Math.max(durationSeconds, 0.001)), retries, peakLocalBytes: Math.min(STREAM_CHUNK_BYTES, file.bytes) }));
    return { logicalObjectKey: file.path, finalR2Key: key, size: file.bytes, sha256: file.sha256, sourceType: sourceType(file.source), status: "downloaded", completionStatus: "completed" };
  } finally {
    client.destroy();
  }
}

async function fullFileFallback(client: S3Client, bucket: string, familyId: string, file: ProductionObject, key: string, started: number) {
  const tempRoot = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "stage4b-fallback");
  mkdirSync(tempRoot, { recursive: true });
  const required = file.bytes + FALLBACK_MARGIN_BYTES;
  const stats = statfsSync(tempRoot);
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (available < required) throw new Error(`fallback_disk_insufficient:${available}:${required}`);
  const target = path.join(tempRoot, `${file.sha256}.part`);
  const token = sourceToken(file.source);
  if (!token) throw new Error(`source_token_missing:${sourceType(file.source)}`);
  const result = await requestSource(file.source, token);
  if (Number.isFinite(result.totalBytes) && result.totalBytes !== file.bytes) throw new Error("fallback_source_size_mismatch");
  let progress = 0;
  await responseToFile(result, target, file.bytes, (bytes) => { progress = bytes; });
  const digest = createHash("sha256");
  await hashFile(digest, target);
  if (statSync(target).size !== file.bytes || digest.digest("hex") !== file.sha256) {
    unlinkSync(target);
    throw new Error("fallback_identity_mismatch");
  }
  const upload = new Upload({ client, params: { Bucket: bucket, Key: key, Body: createReadStream(target), ContentType: "application/octet-stream", Metadata: { sha256: file.sha256, family: familyId, role: file.role, source: sourceType(file.source) } }, queueSize: 2, partSize: STREAM_CHUNK_BYTES, leavePartsOnError: false });
  const heartbeat = setInterval(() => console.log(JSON.stringify({ stage: "full_file_upload_heartbeat", logicalObjectKey: file.path, localBytes: progress, expectedBytes: file.bytes, at: new Date().toISOString() })), 45_000);
  try { await upload.done(); } finally { clearInterval(heartbeat); unlinkSync(target); }
  await verifyFinal(client, bucket, key, file);
  const durationSeconds = (Date.now() - started) / 1000;
  console.log(JSON.stringify({ stage: "object_transfer_metrics", logicalObjectKey: file.path, strategy: "full-file", downloadedBytes: file.bytes, reusedBytes: 0, durationSeconds: Number(durationSeconds.toFixed(3)), averageBytesPerSecond: Math.round(file.bytes / Math.max(durationSeconds, 0.001)), retries: 0, peakLocalBytes: file.bytes }));
  return { logicalObjectKey: file.path, finalR2Key: key, size: file.bytes, sha256: file.sha256, sourceType: sourceType(file.source), status: "downloaded", completionStatus: "completed" };
}

async function probeFile(file: ProductionObject) {
  const token = sourceToken(file.source);
  if (!token) throw new Error(`source_token_missing:${sourceType(file.source)}`);
  try {
    const first = await requestSource(file.source, token, { start: 0, end: 0 });
    const firstBytes = Buffer.from(await first.response.arrayBuffer());
    const offset = Math.min(4096, file.bytes - 1);
    const resumed = await requestSource(file.source, token, { start: offset, end: Math.min(offset + 1023, file.bytes - 1) });
    const resumedBytes = Buffer.from(await resumed.response.arrayBuffer());
    if (first.totalBytes !== file.bytes || resumed.totalBytes !== file.bytes || firstBytes.length !== 1 || resumedBytes.length < 1) throw new Error(`source_probe_failed:${file.path}`);
    return { logicalObjectKey: file.path, sourceType: sourceType(file.source), strategy: "ranged-stream", rangeSupported: true, sourceSize: file.bytes, resumeOffset: offset, redirects: Math.max(first.redirects, resumed.redirects), authorizationRedactedOnCrossOrigin: first.authorizationRedactedOnCrossOrigin || resumed.authorizationRedactedOnCrossOrigin };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("source_range_unsupported:")) throw error;
    const fallback = await requestSource(file.source, token);
    await fallback.response.body?.cancel();
    fallback.controller.abort();
    if (!Number.isFinite(fallback.totalBytes) || fallback.totalBytes !== file.bytes) {
      throw new Error(`source_fallback_size_unverified:${file.path}`);
    }
    return { logicalObjectKey: file.path, sourceType: sourceType(file.source), strategy: "full-file", rangeSupported: false, sourceSize: file.bytes, resumeOffset: null, redirects: fallback.redirects, authorizationRedactedOnCrossOrigin: fallback.authorizationRedactedOnCrossOrigin };
  }
}

export async function probeAllSources() {
  const files = loadProductionFamilies().flatMap((family) => family.objects.map((file) => ({ familyId: family.id, file }))).filter(({ file }) => file.role !== "umt5");
  const results = [];
  for (const { familyId, file } of files) {
    console.log(JSON.stringify({ stage: "source_range_probe", familyId, logicalObjectKey: file.path, sourceType: sourceType(file.source) }));
    results.push({ familyId, ...(await probeFile(file)) });
  }
  return {
    allSourcesReady: results.every((result) => ["ranged-stream", "full-file"].includes(result.strategy)),
    rangedObjectCount: results.filter((result) => result.strategy === "ranged-stream").length,
    fallbackObjectCount: results.filter((result) => result.strategy === "full-file").length,
    imageMatrix: results.filter((result) => result.familyId === "ultrareal-flux1-dev-fp8").map((result) => ({
      logical_object_key: result.logicalObjectKey,
      strategy: result.strategy,
    })),
    videoMatrix: results.filter((result) => result.familyId === "wan22-remix-14b-i2v-fp8").map((result) => ({
      logical_object_key: result.logicalObjectKey,
      strategy: result.strategy,
    })),
    results,
  };
}

export async function multipartUploadAbortProbe() {
  const creds = loadR2Credentials("model-cache-admin.env");
  const client = createS3Client(creds);
  const key = `production/probes/stage4b-upload-abort-${randomUUID()}`;
  let uploadId: string | undefined;
  try {
    const created = await client.send(new CreateMultipartUploadCommand({ Bucket: creds.bucket, Key: key, Metadata: { probe: "stage4b" } }));
    uploadId = created.UploadId;
    if (!uploadId) throw new Error("abort_probe_upload_id_missing");
    await client.send(new UploadPartCommand({ Bucket: creds.bucket, Key: key, UploadId: uploadId, PartNumber: 1, Body: Buffer.alloc(1024, 0x4b), ContentLength: 1024 }));
    const parts = await listUploadedParts(client, creds.bucket, key, uploadId);
    if (parts.length !== 1 || parts[0].Size !== 1024) throw new Error("abort_probe_part_mismatch");
    await client.send(new AbortMultipartUploadCommand({ Bucket: creds.bucket, Key: key, UploadId: uploadId }));
    uploadId = undefined;
    if (await remoteExists(client, creds.bucket, key)) throw new Error("abort_probe_object_exists");
    return { multipartUploadAbortReady: true, uploadedProbeBytes: 1024, finalObjectExists: false };
  } finally {
    if (uploadId) await client.send(new AbortMultipartUploadCommand({ Bucket: creds.bucket, Key: key, UploadId: uploadId })).catch(() => undefined);
    await client.send(new DeleteObjectCommand({ Bucket: creds.bucket, Key: key })).catch(() => undefined);
    client.destroy();
  }
}

export function incrementalSha256(chunks: Buffer[]) {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const command = process.argv[2];
  if (command === "probe-sources") {
    const report = await probeAllSources();
    const output = process.argv[3];
    if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  }
  else if (command === "multipart-abort-probe") console.log(JSON.stringify(await multipartUploadAbortProbe(), null, 2));
  else if (command === "stream") {
    const familyId = process.argv[3];
    const objectPath = process.argv[4];
    const strategy = (process.argv[5] ?? "ranged-stream") as Strategy;
    if (!familyId || !objectPath || !["ranged-stream", "full-file"].includes(strategy)) throw new Error("usage: production-object-stream.ts stream <family> <path> [ranged-stream|full-file]");
    console.log(JSON.stringify(await streamObject(familyId, objectPath, strategy)));
  } else throw new Error("usage: production-object-stream.ts <probe-sources|multipart-abort-probe|stream>");
}

if (process.argv[1]?.endsWith("production-object-stream.ts")) void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
