import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { assertNoSecretOutput } from "../clore/client";
import { loadR2Credentials } from "./r2-presign";
import { createS3Client, sanitizeS3Error } from "./flux4090-cache";
import plan from "../../benchmark/wan-first-video/stage3m-plan.json";

const PREFIX = "production/rtx4090/video";
const REVISION = `wan22-ti2v-5b-${plan.comfyCacheSource.revision.slice(0, 12)}`;
const PART_SIZE = 128 * 1024 * 1024;
const RANGE_SIZE = 1024;

type WanFile = { alias: string; repository: string; revision: string; sourcePath: string; targetPath: string; sizeBytes: number; sha256: string };
const aliases = ["unet", "text", "vae"];
export const wanFiles: WanFile[] = plan.comfyCacheSource.files.map((file, index) => ({ alias: aliases[index], repository: plan.comfyCacheSource.repository, revision: plan.comfyCacheSource.revision, ...file }));
export const currentKey = `${PREFIX}/current.json`;
export const manifestKey = `${PREFIX}/revisions/${REVISION}/manifest.json`;

export function finalKey(file: WanFile) {
  return `${PREFIX}/revisions/${REVISION}/files/${file.targetPath}`;
}

export function selectWanFile(alias: string) {
  const file = wanFiles.find((entry) => entry.alias === alias || entry.targetPath === alias);
  if (!file) throw new Error(`unknown_wan_stage3m_file:${alias}`);
  return file;
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function validateLocal(alias: string, filePath: string) {
  const file = selectWanFile(alias);
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved) || statSync(resolved).size !== file.sizeBytes) throw new Error(`wan_local_size_mismatch:${alias}`);
  const sha256 = await sha256File(resolved);
  if (sha256 !== file.sha256) throw new Error(`wan_local_sha256_mismatch:${alias}`);
  return { valid: true, alias, size_bytes: file.sizeBytes, sha256, path: resolved };
}

async function head(client: S3Client, bucket: string, key: string) {
  return client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}

async function range(client: S3Client, bucket: string, key: string, start: number, end: number) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` }));
  const bytes = await response.Body?.transformToByteArray();
  if (!bytes || bytes.length !== end - start + 1) throw new Error(`wan_range_mismatch:${key}`);
  return bytes.length;
}

export async function verifyObject(client: S3Client, bucket: string, file: WanFile) {
  const key = finalKey(file);
  const response = await head(client, bucket, key);
  if (response.ContentLength !== file.sizeBytes || response.Metadata?.sha256 !== file.sha256) throw new Error(`wan_r2_object_mismatch:${file.alias}`);
  return { alias: file.alias, key, size_bytes: response.ContentLength, sha256: response.Metadata.sha256, first_range_bytes: await range(client, bucket, key, 0, RANGE_SIZE - 1), last_range_bytes: await range(client, bucket, key, file.sizeBytes - RANGE_SIZE, file.sizeBytes - 1) };
}

export async function uploadLocal(alias: string, filePath: string) {
  const file = selectWanFile(alias);
  const local = await validateLocal(alias, filePath);
  const credentials = loadR2Credentials("model-cache-admin.env");
  const client = createS3Client(credentials);
  try {
    const existing = await verifyObject(client, credentials.bucket, file);
    return { uploaded: false, reused: true, object: existing };
  } catch (error) {
    if (![403, 404].includes(sanitizeS3Error(error).http_status ?? 0) && !/mismatch/.test(String(error))) throw error;
  }
  const upload = new Upload({
    client,
    params: { Bucket: credentials.bucket, Key: finalKey(file), Body: createReadStream(local.path), ContentType: "application/octet-stream", Metadata: { sha256: file.sha256, "expected-size": String(file.sizeBytes), revision: REVISION } },
    partSize: PART_SIZE,
    queueSize: 4,
    leavePartsOnError: true,
  });
  upload.on("httpUploadProgress", (progress) => console.log(JSON.stringify({ stage: "wan_r2_multipart", alias, uploaded_bytes: progress.loaded ?? 0 })));
  await upload.done();
  return { uploaded: true, reused: false, object: await verifyObject(client, credentials.bucket, file), incomplete_multipart_preserved_on_failure: true };
}

function manifest() {
  return { schema_version: 1, model: "Wan2.2 TI2V-5B Comfy", repository: plan.comfyCacheSource.repository, source_revision: plan.comfyCacheSource.revision, revision: REVISION, total_size_bytes: plan.comfyCacheSource.totalSizeBytes, generated_at: new Date().toISOString(), files: wanFiles.map((file) => ({ alias: file.alias, source_path: file.sourcePath, relative_path: file.targetPath, key: finalKey(file), size_bytes: file.sizeBytes, sha256: file.sha256 })) };
}

async function putJson(client: S3Client, bucket: string, key: string, value: unknown) {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`), ContentType: "application/json" }));
}

async function readJson<T>(client: S3Client, bucket: string, key: string) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(Buffer.from(await response.Body!.transformToByteArray()).toString("utf8")) as T;
}

export async function publish() {
  const credentials = loadR2Credentials("model-cache-admin.env");
  const client = createS3Client(credentials);
  const objects = await Promise.all(wanFiles.map((file) => verifyObject(client, credentials.bucket, file)));
  const revisionManifest = manifest();
  await putJson(client, credentials.bucket, manifestKey, revisionManifest);
  await putJson(client, credentials.bucket, currentKey, { revision: REVISION, manifest_key: manifestKey, published_at: new Date().toISOString() });
  return { manifest_published: true, current_json_published_last: true, objects };
}

export async function verify() {
  const credentials = loadR2Credentials("model-cache-readonly.env");
  const client = createS3Client(credentials);
  const current = await readJson<{ revision: string; manifest_key: string }>(client, credentials.bucket, currentKey);
  if (current.revision !== REVISION || current.manifest_key !== manifestKey) throw new Error("wan_current_pointer_mismatch");
  const published = await readJson<ReturnType<typeof manifest>>(client, credentials.bucket, manifestKey);
  if (published.total_size_bytes !== plan.comfyCacheSource.totalSizeBytes || published.files.length !== 3) throw new Error("wan_manifest_mismatch");
  const objects = await Promise.all(wanFiles.map((file) => verifyObject(client, credentials.bucket, file)));
  return { wan_cache_ready: true, readonly_head_range_probe: true, revision: REVISION, total_size_bytes: plan.comfyCacheSource.totalSizeBytes, objects };
}

async function main() {
  const [mode = "verify", alias = "", filePath = ""] = process.argv.slice(2);
  const output = mode === "validate-local" ? await validateLocal(alias, filePath) : mode === "upload-local" ? await uploadLocal(alias, filePath) : mode === "publish" ? await publish() : mode === "verify" || mode === "status" ? await verify() : (() => { throw new Error(`unknown_wan_cache_mode:${mode}`); })();
  const text = JSON.stringify(output, null, 2);
  assertNoSecretOutput(text);
  console.log(text);
}

if (process.argv[1]?.endsWith("wan-stage3m-cache.ts")) void main().catch((error) => { console.error(JSON.stringify({ error: sanitizeS3Error(error) }, null, 2)); process.exitCode = 1; });
