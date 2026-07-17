import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
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
  files: Array<ProductionObject & { objectKey: string }>;
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
    requestHandler: new NodeHttpHandler({ connectionTimeout: 15_000, socketTimeout: 10 * 60_000 }),
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

function copySource(bucket: string, key: string) {
  return `${bucket}/${key.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

export async function inventoryAndDeduplicateProductionObjects(copyMatches = false) {
  const creds = loadR2Credentials("model-cache-admin.env");
  const client = createProductionS3Client(creds);
  try {
    const inventory = await listAllObjects(client, creds.bucket);
    const reusedObjects: Array<{ familyId: string; path: string; objectKey: string; bytes: number; sha256: string }> = [];
    const copiedObjects: Array<{ familyId: string; path: string; sourceKey: string; objectKey: string; bytes: number; sha256: string }> = [];
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
        if (!copyMatches) {
          copiedObjects.push({ familyId: family.id, path: file.path, sourceKey, objectKey: file.objectKey, bytes: file.bytes, sha256: file.sha256 });
          continue;
        }
        await client.send(new CopyObjectCommand({
          Bucket: creds.bucket,
          Key: file.objectKey,
          CopySource: copySource(creds.bucket, sourceKey),
          MetadataDirective: "REPLACE",
          ContentType: "application/octet-stream",
          Metadata: { sha256: file.sha256, family: family.id, role: file.role, "deduplicated-from": sourceKey },
        }));
        await verifyRemoteObject(client, creds.bucket, file);
        copiedObjects.push({ familyId: family.id, path: file.path, sourceKey, objectKey: file.objectKey, bytes: file.bytes, sha256: file.sha256 });
      }
    }
    const avoided = [...reusedObjects, ...copiedObjects];
    return {
      schemaVersion: 1,
      mode: copyMatches ? "copy-identical-r2-objects" : "inventory-only",
      inventory: {
        objectCount: inventory.length,
        totalBytes: inventory.reduce((total, object) => total + object.bytes, 0),
        legacyObjectCount: inventory.filter((object) => !object.key.startsWith("production/models/")).length,
        productionObjectCount: inventory.filter((object) => object.key.startsWith("production/models/")).length,
      },
      reusedObjects,
      copiedObjects,
      newlyDownloadedObjects,
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
    for (const file of buildProductionManifest(family).files) {
      if (await remoteObjectExists(client, creds.bucket, file.objectKey)) {
        await verifyRemoteObject(client, creds.bucket, file);
        skipPaths.push(file.path);
      } else {
        downloadPaths.push(file.path);
      }
    }
    return { schemaVersion: 1, familyId, skipPaths, downloadPaths };
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
  const manifest = buildProductionManifest(family, generatedAt);
  try {
    for (const file of manifest.files) {
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
      await upload.done();
      await verifyRemoteObject(client, creds.bucket, file);
    }
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
    return { familyId: family.id, manifestKey, currentKey: family.currentKey, totalSizeBytes: manifest.totalSizeBytes, objectCount: manifest.files.length };
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
    if (manifest.familyId !== family.id || manifest.totalSizeBytes !== family.restoreBytes) throw new Error(`manifest_identity_mismatch:${family.id}`);
    for (const file of manifest.files) await verifyRemoteObject(client, creds.bucket, file);
    if (verifyBoundary) {
      const probeKey = `${family.r2Prefix}/boundary-probe/stage3y-denied`;
      await expectDenied(() => client.send(new PutObjectCommand({ Bucket: creds.bucket, Key: probeKey, Body: "denied" })), "write");
      await expectDenied(() => client.send(new PutObjectCommand({ Bucket: creds.bucket, Key: family.currentKey, Body: "denied", IfNoneMatch: "*" })), "overwrite");
      await expectDenied(() => client.send(new DeleteObjectCommand({ Bucket: creds.bucket, Key: probeKey })), "delete");
    }
    return { familyId: family.id, cacheReady: true, currentKey: family.currentKey, manifestKey: current.manifestKey, totalSizeBytes: manifest.totalSizeBytes, objectCount: manifest.files.length, readonlyBoundary: verifyBoundary };
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
  } else if (command === "deduplicate") {
    console.log(JSON.stringify(await inventoryAndDeduplicateProductionObjects(process.argv.includes("--copy")), null, 2));
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
