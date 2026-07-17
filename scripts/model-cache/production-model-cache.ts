import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AbortMultipartUploadCommand,
  CopyObjectCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { loadR2Credentials, type R2Credentials } from "./r2-presign";

export type ProductionObject = {
  role: string;
  path: string;
  source: string;
  bytes: number;
  sha256: string;
  sourceModelId?: number;
  sourceVersionId?: number;
  sourceFileId?: number;
};

export type ProductionFamily = {
  id: string;
  r2Prefix: string;
  currentKey: string;
  revision: string;
  restoreBytes: number;
  parallelDownloads: number;
  objects: ProductionObject[];
};

export type ProductionManifest = {
  schemaVersion: 1;
  familyId: string;
  revision: string;
  generatedAt: string;
  totalSizeBytes: number;
  files: ProductionManifestFile[];
};

export type SharedObjectSource = {
  familyId: string;
  objectKey: string;
  bytes: number;
  sha256: string;
  retentionKey: string;
};

export type ProductionManifestFile = ProductionObject & {
  objectKey: string;
  shared?: boolean;
  sharedSource?: SharedObjectSource;
};

export function loadProductionFamilies(filePath = path.join(process.cwd(), "comfy-runtime", "production-model-registry.json")) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { families: ProductionFamily[] };
  return parsed.families;
}

export function buildProductionManifest(family: ProductionFamily, generatedAt = new Date().toISOString()): ProductionManifest {
  const files = family.objects.map((object) => ({ ...object, objectKey: `${family.r2Prefix}/objects/${object.sha256}` }));
  const totalSizeBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (totalSizeBytes !== family.restoreBytes) throw new Error(`restore_size_mismatch:${family.id}`);
  return { schemaVersion: 1, familyId: family.id, revision: family.revision, generatedAt, totalSizeBytes, files };
}

function sourceFamilyId(key: string) {
  if (key.startsWith("production/rtx4090/video/")) return "wan22-ti2v-5b";
  if (key.startsWith("production/rtx4090/image/")) return "flux2-klein-4b";
  if (key.startsWith("production/models/")) return key.split("/")[2] ?? "production-model";
  return "existing-r2-object";
}

function retentionKey(family: ProductionFamily, file: ProductionManifestFile) {
  return `production/retention-references/${family.id}/${file.sha256}.json`;
}

export function buildCurrentPointer(family: ProductionFamily, manifest: ProductionManifest) {
  const manifestPayload = `${JSON.stringify(manifest, null, 2)}\n`;
  return {
    schemaVersion: 1,
    familyId: family.id,
    revision: family.revision,
    manifestKey: `${family.r2Prefix}/manifests/${family.revision}.json`,
    manifestSha256: createHash("sha256").update(manifestPayload).digest("hex"),
    publishedAt: manifest.generatedAt,
  };
}

export function productionPublishPlan(family: ProductionFamily) {
  const manifest = buildProductionManifest(family);
  return {
    familyId: family.id,
    uploadOrder: [
      ...manifest.files.map((file) => ({ kind: "object", key: file.objectKey, verify: ["HEAD:size", "Range:bytes=0-0"] })),
      { kind: "manifest", key: `${family.r2Prefix}/manifests/${family.revision}.json`, verify: ["HEAD:size", "GET:sha256"] },
      { kind: "current", key: family.currentKey, verify: ["HEAD:size", "GET:json"] },
    ],
    currentPublishedLast: true,
    immutableObjects: true,
  };
}

export function assertProductionCredentialGate(env = process.env) {
  const token = env.CIVITAI_API_TOKEN?.trim();
  if (!token) throw new Error("CIVITAI_API_TOKEN_missing_download_and_dispatch_blocked");
  return token;
}

function createProductionS3Client(creds: R2Credentials) {
  return new S3Client({
    region: creds.region || "auto",
    endpoint: creds.endpoint,
    forcePathStyle: true,
    maxAttempts: 4,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 15_000, socketTimeout: 120_000 }),
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}

async function streamSha256(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function bodyBuffer(body: unknown) {
  if (!body || typeof body !== "object" || !("transformToByteArray" in body)) throw new Error("r2_response_body_missing");
  return Buffer.from(await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
}

async function verifyRemoteObject(client: S3Client, bucket: string, file: ProductionManifest["files"][number]) {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: file.objectKey }));
  if (head.ContentLength !== file.bytes) throw new Error(`r2_size_mismatch:${file.objectKey}`);
  if (head.Metadata?.sha256 !== file.sha256) throw new Error(`r2_sha_metadata_mismatch:${file.objectKey}`);
  const first = await client.send(new GetObjectCommand({ Bucket: bucket, Key: file.objectKey, Range: "bytes=0-0" }));
  const last = await client.send(new GetObjectCommand({ Bucket: bucket, Key: file.objectKey, Range: `bytes=${file.bytes - 1}-${file.bytes - 1}` }));
  if ((await bodyBuffer(first.Body)).length !== 1 || (await bodyBuffer(last.Body)).length !== 1) throw new Error(`r2_range_probe_failed:${file.objectKey}`);
}

async function remoteObjectExists(client: S3Client, bucket: string, key: string) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return false;
    throw error;
  }
}

function metadataSha256(metadata: Record<string, string | undefined> | undefined) {
  return (metadata?.sha256 ?? metadata?.["expected-sha256"] ?? "").toLowerCase();
}

async function listAllObjects(client: S3Client, bucket: string) {
  const objects: Array<{ key: string; bytes: number }> = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    for (const object of page.Contents ?? []) {
      if (object.Key && object.Size !== undefined) objects.push({ key: object.Key, bytes: object.Size });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

async function matchingExistingObject(
  client: S3Client,
  bucket: string,
  candidates: Array<{ key: string; bytes: number }>,
  file: ProductionManifest["files"][number],
) {
  for (const candidate of candidates.filter((object) => object.bytes === file.bytes).sort((left, right) => left.key.localeCompare(right.key))) {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: candidate.key }));
    if (head.ContentLength === file.bytes && metadataSha256(head.Metadata) === file.sha256) return candidate.key;
  }
  return null;
}

async function resolveProductionManifest(
  client: S3Client,
  bucket: string,
  family: ProductionFamily,
  generatedAt = new Date().toISOString(),
) {
  const inventory = await listAllObjects(client, bucket);
  const manifest = buildProductionManifest(family, generatedAt);
  manifest.files = await Promise.all(manifest.files.map(async (file) => {
    if (inventory.some((object) => object.key === file.objectKey)) {
      await verifyRemoteObject(client, bucket, file);
      return file;
    }
    const sharedKey = await matchingExistingObject(client, bucket, inventory, file);
    if (!sharedKey) return file;
    const sharedSource: SharedObjectSource = {
      familyId: sourceFamilyId(sharedKey),
      objectKey: sharedKey,
      bytes: file.bytes,
      sha256: file.sha256,
      retentionKey: retentionKey(family, file),
    };
    const sharedFile = { ...file, objectKey: sharedKey, shared: true, sharedSource };
    await verifyRemoteObject(client, bucket, sharedFile);
    return sharedFile;
  }));
  return manifest;
}

function copySource(bucket: string, key: string) {
  return `${bucket}/${key.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

export async function copyExistingObject(
  client: S3Client,
  bucket: string,
  sourceKey: string,
  file: ProductionManifest["files"][number],
  familyId: string,
) {
  const metadata = { sha256: file.sha256, family: familyId, role: file.role, "deduplicated-from": sourceKey };
  if (file.bytes <= 5 * 1024 ** 3) {
    await client.send(new CopyObjectCommand({
      Bucket: bucket,
      Key: file.objectKey,
      CopySource: copySource(bucket, sourceKey),
      MetadataDirective: "REPLACE",
      ContentType: "application/octet-stream",
      Metadata: metadata,
    }));
    return { method: "CopyObject", partCount: 1 };
  }
  const stateKey = `production/multipart-copy-state/${file.sha256}.json`;
  type MultipartCopyState = { schemaVersion: 1; uploadId: string; sourceKey: string; objectKey: string; bytes: number; sha256: string };
  let state: MultipartCopyState | null = null;
  if (await remoteObjectExists(client, bucket, stateKey)) {
    const saved = await client.send(new GetObjectCommand({ Bucket: bucket, Key: stateKey }));
    state = JSON.parse((await bodyBuffer(saved.Body)).toString("utf8")) as MultipartCopyState;
    const valid = state.schemaVersion === 1 && state.sourceKey === sourceKey && state.objectKey === file.objectKey && state.bytes === file.bytes && state.sha256 === file.sha256;
    if (!valid) {
      if (state.uploadId) {
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: state.objectKey, UploadId: state.uploadId })).catch(() => undefined);
      }
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: stateKey }));
      throw new Error(`r2_multipart_copy_state_mismatch:${file.objectKey}`);
    }
  }
  if (!state) {
    const created = await client.send(new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: file.objectKey,
      ContentType: "application/octet-stream",
      Metadata: metadata,
    }));
    if (!created.UploadId) throw new Error(`r2_multipart_copy_upload_id_missing:${file.objectKey}`);
    state = { schemaVersion: 1, uploadId: created.UploadId, sourceKey, objectKey: file.objectKey, bytes: file.bytes, sha256: file.sha256 };
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: stateKey, Body: `${JSON.stringify(state)}\n`, ContentType: "application/json" }));
  }
  const partSize = 128 * 1024 * 1024;
  const ranges = Array.from({ length: Math.ceil(file.bytes / partSize) }, (_, index) => ({
    PartNumber: index + 1,
    start: index * partSize,
    end: Math.min(file.bytes, (index + 1) * partSize) - 1,
  }));
  const completedParts: Array<{ ETag: string; PartNumber: number }> = [];
  let partNumberMarker: string | undefined;
  do {
    const listed = await client.send(new ListPartsCommand({
      Bucket: bucket,
      Key: file.objectKey,
      UploadId: state.uploadId,
      PartNumberMarker: partNumberMarker,
    }));
    for (const part of listed.Parts ?? []) {
      if (!part.ETag || !part.PartNumber) throw new Error(`r2_multipart_copy_listed_part_invalid:${file.objectKey}`);
      const expected = ranges[part.PartNumber - 1];
      if (!expected || part.Size !== expected.end - expected.start + 1) {
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: file.objectKey, UploadId: state.uploadId }));
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: stateKey }));
        throw new Error(`r2_multipart_copy_part_size_mismatch:${file.objectKey}:${part.PartNumber}`);
      }
      completedParts.push({ ETag: part.ETag, PartNumber: part.PartNumber });
    }
    partNumberMarker = listed.IsTruncated ? listed.NextPartNumberMarker : undefined;
  } while (partNumberMarker);
  const completedNumbers = new Set(completedParts.map((part) => part.PartNumber));
  const missingRanges = ranges.filter((range) => !completedNumbers.has(range.PartNumber));
  for (let offset = 0; offset < missingRanges.length; offset += 4) {
    const copied = await Promise.all(missingRanges.slice(offset, offset + 4).map(async (range) => {
      const response = await client.send(new UploadPartCopyCommand({
        Bucket: bucket,
        Key: file.objectKey,
        UploadId: state.uploadId,
        PartNumber: range.PartNumber,
        CopySource: copySource(bucket, sourceKey),
        CopySourceRange: `bytes=${range.start}-${range.end}`,
      }));
      const ETag = response.CopyPartResult?.ETag;
      if (!ETag) throw new Error(`r2_multipart_copy_etag_missing:${file.objectKey}:${range.PartNumber}`);
      return { ETag, PartNumber: range.PartNumber };
    }));
    completedParts.push(...copied);
    console.log(JSON.stringify({
      stage: "r2_multipart_copy",
      objectKey: file.objectKey,
      copiedParts: completedParts.length,
      totalParts: ranges.length,
      at: new Date().toISOString(),
    }));
  }
  await client.send(new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: file.objectKey,
    UploadId: state.uploadId,
    MultipartUpload: { Parts: completedParts.sort((left, right) => left.PartNumber - right.PartNumber) },
  }));
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: stateKey }));
  await verifyRemoteObject(client, bucket, file);
  return { method: "UploadPartCopy", partCount: ranges.length, resumedParts: ranges.length - missingRanges.length };
}

function retentionPayload(family: ProductionFamily, file: ProductionManifestFile) {
  if (!file.shared || !file.sharedSource) throw new Error(`retention_reference_requires_shared_file:${file.path}`);
  return {
    schemaVersion: 1,
    productionFamilyId: family.id,
    productionRevision: family.revision,
    sourceFamilyId: file.sharedSource.familyId,
    sourceKey: file.sharedSource.objectKey,
    bytes: file.bytes,
    sha256: file.sha256,
    retainedForProduction: true,
  };
}

async function publishSharedRetentionReferences(client: S3Client, bucket: string, family: ProductionFamily, manifest: ProductionManifest) {
  const references = [];
  for (const file of manifest.files.filter((entry) => entry.shared)) {
    if (!file.sharedSource) throw new Error(`shared_source_missing:${file.path}`);
    const payload = retentionPayload(family, file);
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    if (!await remoteObjectExists(client, bucket, file.sharedSource.retentionKey)) {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: file.sharedSource.retentionKey,
        Body: serialized,
        ContentType: "application/json",
        Metadata: { sha256: createHash("sha256").update(serialized).digest("hex") },
      }));
    }
    const read = await client.send(new GetObjectCommand({ Bucket: bucket, Key: file.sharedSource.retentionKey }));
    const published = JSON.parse((await bodyBuffer(read.Body)).toString("utf8")) as typeof payload;
    if (
      published.productionFamilyId !== payload.productionFamilyId
      || published.productionRevision !== payload.productionRevision
      || published.sourceFamilyId !== payload.sourceFamilyId
      || published.sourceKey !== payload.sourceKey
      || published.bytes !== payload.bytes
      || published.sha256 !== payload.sha256
      || published.retainedForProduction !== true
    ) throw new Error(`retention_reference_mismatch:${file.path}`);
    references.push({ path: file.path, retentionKey: file.sharedSource.retentionKey, sourceKey: file.objectKey });
  }
  return references;
}

async function verifySharedRetentionReferences(client: S3Client, bucket: string, family: ProductionFamily, manifest: ProductionManifest) {
  for (const file of manifest.files.filter((entry) => entry.shared)) {
    if (!file.sharedSource || file.objectKey !== file.sharedSource.objectKey || file.bytes !== file.sharedSource.bytes || file.sha256 !== file.sharedSource.sha256) {
      throw new Error(`shared_manifest_identity_mismatch:${file.path}`);
    }
    const payload = retentionPayload(family, file);
    const read = await client.send(new GetObjectCommand({ Bucket: bucket, Key: file.sharedSource.retentionKey }));
    const published = JSON.parse((await bodyBuffer(read.Body)).toString("utf8")) as typeof payload;
    if (published.sourceKey !== payload.sourceKey || published.bytes !== payload.bytes || published.sha256 !== payload.sha256 || published.retainedForProduction !== true) {
      throw new Error(`readonly_retention_reference_mismatch:${file.path}`);
    }
  }
}

export async function runMultipartCopyProbe() {
  const creds = loadR2Credentials("model-cache-admin.env");
  const client = createProductionS3Client(creds);
  const probeKey = `production/probes/stage4a-multipart-copy-${randomUUID()}`;
  let uploadId: string | undefined;
  try {
    const inventory = await listAllObjects(client, creds.bucket);
    const source = inventory
      .filter((object) => object.bytes > 0 && object.bytes <= 1024 * 1024 && !object.key.startsWith("production/probes/"))
      .sort((left, right) => left.bytes - right.bytes)[0];
    if (!source) throw new Error("multipart_copy_probe_source_missing");
    const sourceRead = await client.send(new GetObjectCommand({ Bucket: creds.bucket, Key: source.key }));
    const sourceBytes = await bodyBuffer(sourceRead.Body);
    if (sourceBytes.length !== source.bytes) throw new Error("multipart_copy_probe_source_size_mismatch");
    const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const created = await client.send(new CreateMultipartUploadCommand({
      Bucket: creds.bucket,
      Key: probeKey,
      ContentType: "application/octet-stream",
      Metadata: { sha256, probe: "stage4a" },
    }));
    uploadId = created.UploadId;
    if (!uploadId) throw new Error("multipart_copy_probe_upload_id_missing");
    const copied = await client.send(new UploadPartCopyCommand({
      Bucket: creds.bucket,
      Key: probeKey,
      UploadId: uploadId,
      PartNumber: 1,
      CopySource: copySource(creds.bucket, source.key),
      CopySourceRange: `bytes=0-${source.bytes - 1}`,
    }));
    const ETag = copied.CopyPartResult?.ETag;
    if (!ETag) throw new Error("multipart_copy_probe_etag_missing");
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: creds.bucket,
      Key: probeKey,
      UploadId: uploadId,
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag }] },
    }));
    uploadId = undefined;
    const head = await client.send(new HeadObjectCommand({ Bucket: creds.bucket, Key: probeKey }));
    if (head.ContentLength !== source.bytes || head.Metadata?.sha256 !== sha256) throw new Error("multipart_copy_probe_head_mismatch");
    await client.send(new DeleteObjectCommand({ Bucket: creds.bucket, Key: probeKey }));
    if (await remoteObjectExists(client, creds.bucket, probeKey)) throw new Error("multipart_copy_probe_delete_failed");
    return { multipartCopyProbeReady: true, sourceKey: source.key, bytes: source.bytes, partCount: 1, destinationDeleted: true };
  } catch (error) {
    if (uploadId) await client.send(new AbortMultipartUploadCommand({ Bucket: creds.bucket, Key: probeKey, UploadId: uploadId })).catch(() => undefined);
    await client.send(new DeleteObjectCommand({ Bucket: creds.bucket, Key: probeKey })).catch(() => undefined);
    throw error;
  } finally {
    client.destroy();
  }
}

export async function inventoryAndDeduplicateProductionObjects() {
  const creds = loadR2Credentials("model-cache-admin.env");
  const client = createProductionS3Client(creds);
  try {
    const inventory = await listAllObjects(client, creds.bucket);
    const reusedObjects: Array<{ familyId: string; path: string; objectKey: string; bytes: number; sha256: string }> = [];
    const sharedObjects: Array<{ familyId: string; path: string; sourceFamilyId: string; objectKey: string; retentionKey: string; bytes: number; sha256: string }> = [];
    const newlyDownloadedObjects: Array<{ familyId: string; path: string; objectKey: string; bytes: number; sha256: string }> = [];
    for (const family of loadProductionFamilies()) {
      for (const file of buildProductionManifest(family).files) {
        const destination = inventory.find((object) => object.key === file.objectKey);
        if (destination) {
          await verifyRemoteObject(client, creds.bucket, file);
          reusedObjects.push({ familyId: family.id, path: file.path, objectKey: file.objectKey, bytes: file.bytes, sha256: file.sha256 });
          continue;
        }
        const sourceKey = await matchingExistingObject(client, creds.bucket, inventory, file);
        if (!sourceKey) {
          newlyDownloadedObjects.push({ familyId: family.id, path: file.path, objectKey: file.objectKey, bytes: file.bytes, sha256: file.sha256 });
          continue;
        }
        sharedObjects.push({
          familyId: family.id,
          path: file.path,
          sourceFamilyId: sourceFamilyId(sourceKey),
          objectKey: sourceKey,
          retentionKey: retentionKey(family, file),
          bytes: file.bytes,
          sha256: file.sha256,
        });
      }
    }
    const avoided = [...reusedObjects, ...sharedObjects];
    return {
      schemaVersion: 1,
      mode: "shared-object-reference-preferred",
      inventory: {
        objectCount: inventory.length,
        totalBytes: inventory.reduce((total, object) => total + object.bytes, 0),
        legacyObjectCount: inventory.filter((object) => !object.key.startsWith("production/models/")).length,
        productionObjectCount: inventory.filter((object) => object.key.startsWith("production/models/")).length,
      },
      reusedObjects,
      sharedObjects,
      newlyDownloadedObjects,
      retentionReferences: sharedObjects.map((object) => ({
        productionFamilyId: object.familyId,
        sourceFamilyId: object.sourceFamilyId,
        sourceKey: object.objectKey,
        retentionKey: object.retentionKey,
        bytes: object.bytes,
        sha256: object.sha256,
      })),
      bytesAvoided: avoided.reduce((total, object) => total + object.bytes, 0),
    };
  } finally {
    client.destroy();
  }
}

export async function buildRemoteDownloadPlan(familyId: string) {
  const family = loadProductionFamilies().find((entry) => entry.id === familyId);
  if (!family) throw new Error(`unknown_family:${familyId}`);
  const creds = loadR2Credentials("model-cache-admin.env");
  const client = createProductionS3Client(creds);
  try {
    const skipPaths: string[] = [];
    const downloadPaths: string[] = [];
    const manifest = await resolveProductionManifest(client, creds.bucket, family);
    for (const file of manifest.files) {
      if (file.shared || await remoteObjectExists(client, creds.bucket, file.objectKey)) {
        await verifyRemoteObject(client, creds.bucket, file);
        skipPaths.push(file.path);
      } else {
        downloadPaths.push(file.path);
      }
    }
    return {
      schemaVersion: 1,
      familyId,
      skipPaths,
      downloadPaths,
      sharedObjects: manifest.files.filter((file) => file.shared).map((file) => ({
        path: file.path,
        objectKey: file.objectKey,
        bytes: file.bytes,
        sha256: file.sha256,
        sharedSource: file.sharedSource,
      })),
    };
  } finally {
    client.destroy();
  }
}

export async function publishProductionFamily(familyId: string, localRoot: string, generatedAt = new Date().toISOString()) {
  const family = loadProductionFamilies().find((entry) => entry.id === familyId);
  if (!family) throw new Error(`unknown_family:${familyId}`);
  assertProductionCredentialGate();
  const creds = loadR2Credentials("model-cache-admin.env");
  const client = createProductionS3Client(creds);
  try {
    const manifest = await resolveProductionManifest(client, creds.bucket, family, generatedAt);
    for (const file of manifest.files) {
      if (file.shared) {
        await verifyRemoteObject(client, creds.bucket, file);
        continue;
      }
      const reusable = await remoteObjectExists(client, creds.bucket, file.objectKey);
      if (reusable) {
        await verifyRemoteObject(client, creds.bucket, file);
        continue;
      }
      const localPath = path.join(localRoot, ...file.path.split("/"));
      if (statSync(localPath).size !== file.bytes) throw new Error(`local_size_mismatch:${file.path}`);
      if (await streamSha256(localPath) !== file.sha256) throw new Error(`local_sha256_mismatch:${file.path}`);
      const upload = new Upload({
        client,
        params: {
          Bucket: creds.bucket,
          Key: file.objectKey,
          Body: createReadStream(localPath),
          ContentType: "application/octet-stream",
          Metadata: { sha256: file.sha256, family: family.id, role: file.role },
        },
        queueSize: 4,
        partSize: 128 * 1024 * 1024,
        leavePartsOnError: true,
      });
      let uploadedBytes = 0;
      upload.on("httpUploadProgress", (progress) => { uploadedBytes = progress.loaded ?? uploadedBytes; });
      const uploadHeartbeat = setInterval(() => {
        console.log(JSON.stringify({
          stage: "r2_upload_heartbeat",
          familyId: family.id,
          path: file.path,
          uploadedBytes,
          expectedBytes: file.bytes,
          at: new Date().toISOString(),
        }));
      }, 30_000);
      try {
        await upload.done();
      } finally {
        clearInterval(uploadHeartbeat);
      }
      await verifyRemoteObject(client, creds.bucket, file);
    }
    const retentionReferences = await publishSharedRetentionReferences(client, creds.bucket, family, manifest);
    const manifestPayload = `${JSON.stringify(manifest, null, 2)}\n`;
    const current = buildCurrentPointer(family, manifest);
    const manifestKey = current.manifestKey;
    if (!await remoteObjectExists(client, creds.bucket, manifestKey)) {
      await client.send(new PutObjectCommand({ Bucket: creds.bucket, Key: manifestKey, Body: manifestPayload, ContentType: "application/json", Metadata: { sha256: current.manifestSha256 } }));
    }
    const manifestRead = await client.send(new GetObjectCommand({ Bucket: creds.bucket, Key: manifestKey }));
    if (createHash("sha256").update(await bodyBuffer(manifestRead.Body)).digest("hex") !== current.manifestSha256) throw new Error(`manifest_verify_failed:${family.id}`);
    const currentPayload = `${JSON.stringify(current, null, 2)}\n`;
    if (!await remoteObjectExists(client, creds.bucket, family.currentKey)) {
      await client.send(new PutObjectCommand({ Bucket: creds.bucket, Key: family.currentKey, Body: currentPayload, ContentType: "application/json" }));
    }
    const currentRead = await client.send(new GetObjectCommand({ Bucket: creds.bucket, Key: family.currentKey }));
    const publishedCurrent = JSON.parse((await bodyBuffer(currentRead.Body)).toString("utf8")) as typeof current;
    if (publishedCurrent.familyId !== family.id || publishedCurrent.revision !== family.revision || publishedCurrent.manifestSha256 !== current.manifestSha256) throw new Error(`current_verify_failed:${family.id}`);
    return {
      familyId: family.id,
      manifestKey,
      currentKey: family.currentKey,
      totalSizeBytes: manifest.totalSizeBytes,
      objectCount: manifest.files.length,
      sharedObjectCount: manifest.files.filter((file) => file.shared).length,
      sharedBytes: manifest.files.filter((file) => file.shared).reduce((total, file) => total + file.bytes, 0),
      retentionReferences,
    };
  } finally {
    client.destroy();
  }
}

export async function publishProductionFamilyFromR2(familyId: string, generatedAt = new Date().toISOString()) {
  const family = loadProductionFamilies().find((entry) => entry.id === familyId);
  if (!family) throw new Error(`unknown_family:${familyId}`);
  const creds = loadR2Credentials("model-cache-admin.env");
  const client = createProductionS3Client(creds);
  try {
    const manifest = await resolveProductionManifest(client, creds.bucket, family, generatedAt);
    for (const file of manifest.files) {
      if (!await remoteObjectExists(client, creds.bucket, file.objectKey)) {
        throw new Error(`production_object_missing:${family.id}:${file.path}`);
      }
      await verifyRemoteObject(client, creds.bucket, file);
    }
    const retentionReferences = await publishSharedRetentionReferences(client, creds.bucket, family, manifest);
    const manifestPayload = `${JSON.stringify(manifest, null, 2)}\n`;
    const current = buildCurrentPointer(family, manifest);
    if (!await remoteObjectExists(client, creds.bucket, current.manifestKey)) {
      await client.send(new PutObjectCommand({
        Bucket: creds.bucket,
        Key: current.manifestKey,
        Body: manifestPayload,
        ContentType: "application/json",
        Metadata: { sha256: current.manifestSha256 },
      }));
    }
    const manifestRead = await client.send(new GetObjectCommand({
      Bucket: creds.bucket,
      Key: current.manifestKey,
    }));
    if (createHash("sha256").update(await bodyBuffer(manifestRead.Body)).digest("hex") !== current.manifestSha256) {
      throw new Error(`manifest_verify_failed:${family.id}`);
    }
    const currentPayload = `${JSON.stringify(current, null, 2)}\n`;
    if (!await remoteObjectExists(client, creds.bucket, family.currentKey)) {
      await client.send(new PutObjectCommand({
        Bucket: creds.bucket,
        Key: family.currentKey,
        Body: currentPayload,
        ContentType: "application/json",
      }));
    }
    const currentRead = await client.send(new GetObjectCommand({
      Bucket: creds.bucket,
      Key: family.currentKey,
    }));
    const publishedCurrent = JSON.parse((await bodyBuffer(currentRead.Body)).toString("utf8")) as typeof current;
    if (
      publishedCurrent.familyId !== family.id
      || publishedCurrent.revision !== family.revision
      || publishedCurrent.manifestSha256 !== current.manifestSha256
    ) throw new Error(`current_verify_failed:${family.id}`);
    return {
      familyId: family.id,
      manifestKey: current.manifestKey,
      currentKey: family.currentKey,
      totalSizeBytes: manifest.totalSizeBytes,
      objectCount: manifest.files.length,
      sharedObjectCount: manifest.files.filter((file) => file.shared).length,
      sharedBytes: manifest.files.filter((file) => file.shared).reduce((total, file) => total + file.bytes, 0),
      retentionReferences,
      publicationSource: "verified-r2-objects",
      currentPublishedLast: true,
    };
  } finally {
    client.destroy();
  }
}

async function expectDenied(operation: () => Promise<unknown>, label: string) {
  try {
    await operation();
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 401 || status === 403) return;
    throw error;
  }
  throw new Error(`readonly_boundary_allowed:${label}`);
}

function assertPublishedManifestMatchesFamily(family: ProductionFamily, manifest: ProductionManifest) {
  if (
    manifest.schemaVersion !== 1
    || manifest.familyId !== family.id
    || manifest.revision !== family.revision
    || manifest.totalSizeBytes !== family.restoreBytes
    || manifest.files.length !== family.objects.length
  ) throw new Error(`manifest_identity_mismatch:${family.id}`);
  for (const expected of family.objects) {
    const file = manifest.files.find((entry) => entry.path === expected.path);
    if (
      !file
      || file.role !== expected.role
      || file.source !== expected.source
      || file.bytes !== expected.bytes
      || file.sha256 !== expected.sha256
      || file.sourceModelId !== expected.sourceModelId
      || file.sourceVersionId !== expected.sourceVersionId
      || file.sourceFileId !== expected.sourceFileId
    ) throw new Error(`manifest_source_lock_mismatch:${family.id}:${expected.path}`);
    const canonicalKey = `${family.r2Prefix}/objects/${expected.sha256}`;
    if (!file.shared && file.objectKey !== canonicalKey) throw new Error(`manifest_object_key_mismatch:${family.id}:${expected.path}`);
    if (file.shared && (!file.sharedSource || file.objectKey !== file.sharedSource.objectKey)) throw new Error(`manifest_shared_key_mismatch:${family.id}:${expected.path}`);
  }
}

export async function readPublishedProductionManifest(familyId: string) {
  const family = loadProductionFamilies().find((entry) => entry.id === familyId);
  if (!family) throw new Error(`unknown_family:${familyId}`);
  const creds = loadR2Credentials("model-cache-readonly.env");
  const client = createProductionS3Client(creds);
  try {
    const currentRead = await client.send(new GetObjectCommand({ Bucket: creds.bucket, Key: family.currentKey }));
    const current = JSON.parse((await bodyBuffer(currentRead.Body)).toString("utf8")) as ReturnType<typeof buildCurrentPointer>;
    if (current.familyId !== family.id || current.revision !== family.revision) throw new Error(`current_identity_mismatch:${family.id}`);
    const manifestRead = await client.send(new GetObjectCommand({ Bucket: creds.bucket, Key: current.manifestKey }));
    const manifestBytes = await bodyBuffer(manifestRead.Body);
    if (createHash("sha256").update(manifestBytes).digest("hex") !== current.manifestSha256) throw new Error(`manifest_sha256_mismatch:${family.id}`);
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as ProductionManifest;
    assertPublishedManifestMatchesFamily(family, manifest);
    return { family, current, manifest };
  } finally {
    client.destroy();
  }
}

export async function verifyProductionReadonly(familyId: string, verifyBoundary = true) {
  const family = loadProductionFamilies().find((entry) => entry.id === familyId);
  if (!family) throw new Error(`unknown_family:${familyId}`);
  const creds = loadR2Credentials("model-cache-readonly.env");
  const client = createProductionS3Client(creds);
  try {
    const currentRead = await client.send(new GetObjectCommand({ Bucket: creds.bucket, Key: family.currentKey }));
    const current = JSON.parse((await bodyBuffer(currentRead.Body)).toString("utf8")) as ReturnType<typeof buildCurrentPointer>;
    if (current.familyId !== family.id || current.revision !== family.revision) throw new Error(`current_identity_mismatch:${family.id}`);
    const manifestRead = await client.send(new GetObjectCommand({ Bucket: creds.bucket, Key: current.manifestKey }));
    const manifestBytes = await bodyBuffer(manifestRead.Body);
    if (createHash("sha256").update(manifestBytes).digest("hex") !== current.manifestSha256) throw new Error(`manifest_sha256_mismatch:${family.id}`);
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as ProductionManifest;
    assertPublishedManifestMatchesFamily(family, manifest);
    for (const file of manifest.files) await verifyRemoteObject(client, creds.bucket, file);
    await verifySharedRetentionReferences(client, creds.bucket, family, manifest);
    if (verifyBoundary) {
      const probeKey = `${family.r2Prefix}/boundary-probe/stage3y-denied`;
      await expectDenied(() => client.send(new PutObjectCommand({ Bucket: creds.bucket, Key: probeKey, Body: "denied" })), "write");
      await expectDenied(() => client.send(new PutObjectCommand({ Bucket: creds.bucket, Key: family.currentKey, Body: "denied", IfNoneMatch: "*" })), "overwrite");
      await expectDenied(() => client.send(new DeleteObjectCommand({ Bucket: creds.bucket, Key: probeKey })), "delete");
    }
    const sharedFiles = manifest.files.filter((file) => file.shared);
    return {
      familyId: family.id,
      cacheReady: true,
      currentKey: family.currentKey,
      manifestKey: current.manifestKey,
      totalSizeBytes: manifest.totalSizeBytes,
      objectCount: manifest.files.length,
      sharedObjectCount: sharedFiles.length,
      sharedBytes: sharedFiles.reduce((total, file) => total + file.bytes, 0),
      sharedObjects: sharedFiles.map((file) => ({ path: file.path, objectKey: file.objectKey, sharedSource: file.sharedSource })),
      readonlyBoundary: verifyBoundary,
    };
  } finally {
    client.destroy();
  }
}

async function main() {
  const command = process.argv[2] ?? "plan";
  const families = loadProductionFamilies();
  if (command === "credential-gate") {
    assertProductionCredentialGate();
    console.log(JSON.stringify({ ok: true }));
  } else if (command === "plan") {
    console.log(JSON.stringify(families.map(productionPublishPlan), null, 2));
  } else if (command === "emit") {
    const family = families.find((entry) => entry.id === process.argv[3]);
    const output = process.argv[4];
    if (!family || !output) throw new Error("usage: production-model-cache.ts emit <family-id> <output-dir>");
    const manifest = buildProductionManifest(family);
    const current = buildCurrentPointer(family, manifest);
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileSync(path.join(output, "current.json"), `${JSON.stringify(current, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ manifestKey: current.manifestKey, currentKey: family.currentKey }));
  } else if (command === "publish-local") {
    const familyId = process.argv[3];
    const localRoot = process.argv[4];
    if (!familyId || !localRoot) throw new Error("usage: production-model-cache.ts publish-local <family-id> <local-root>");
    console.log(JSON.stringify(await publishProductionFamily(familyId, localRoot)));
  } else if (command === "publish-r2") {
    const familyId = process.argv[3];
    if (!familyId) throw new Error("usage: production-model-cache.ts publish-r2 <family-id>");
    console.log(JSON.stringify(await publishProductionFamilyFromR2(familyId)));
  } else if (command === "deduplicate") {
    console.log(JSON.stringify(await inventoryAndDeduplicateProductionObjects(), null, 2));
  } else if (command === "multipart-copy-probe") {
    console.log(JSON.stringify(await runMultipartCopyProbe(), null, 2));
  } else if (command === "download-plan") {
    const familyId = process.argv[3];
    if (!familyId) throw new Error("usage: production-model-cache.ts download-plan <family-id>");
    console.log(JSON.stringify(await buildRemoteDownloadPlan(familyId), null, 2));
  } else if (command === "verify-readonly") {
    const familyId = process.argv[3];
    if (!familyId) throw new Error("usage: production-model-cache.ts verify-readonly <family-id>");
    console.log(JSON.stringify(await verifyProductionReadonly(familyId, true)));
  } else {
    throw new Error(`unsupported_command:${command}`);
  }
}

if (process.argv[1]?.endsWith("production-model-cache.ts")) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
