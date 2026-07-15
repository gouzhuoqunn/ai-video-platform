import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FLUX_MODEL_FILES } from "../flux-first-image";
import { assertNoSecretOutput } from "../clore/client";
import { loadR2Credentials, signedR2Fetch, type R2Credentials } from "./r2-presign";

const PREFIX = "production/rtx4090/image";
const PART_BYTES = 64 * 1024 * 1024;
const STATE_PATH = path.join(process.cwd(), ".secrets", "flux4090-r2-seed-state.json");
const REVISION = "flux2-klein-4b-5b4408e59397-a9e4ca87c16d";

export type FluxCacheFile = (typeof FLUX_MODEL_FILES)[number] & { relativePath: string };
export type FluxCacheState = { session_id: string; revision: string; started_at: string; files: Record<string, { staging_key: string; upload_id?: string; parts: Array<{ number: number; etag: string }>; source_sha256?: string; completed?: boolean }> };

export const fluxCacheFiles: FluxCacheFile[] = FLUX_MODEL_FILES.map((file) => ({ ...file, relativePath: `${file.targetDirectory}/${file.filename}` }));
export const fluxCacheCurrentKey = `${PREFIX}/current.json`;
export const fluxCacheManifestKey = `${PREFIX}/revisions/${REVISION}/manifest.json`;

function readState(): FluxCacheState {
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")) as FluxCacheState;
  const sessionId = randomUUID();
  return { session_id: sessionId, revision: REVISION, started_at: new Date().toISOString(), files: Object.fromEntries(fluxCacheFiles.map((file) => [file.relativePath, { staging_key: `${PREFIX}/staging/${sessionId}/files/${file.relativePath}`, parts: [] }])) };
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

function xml(text: string, tag: string) {
  return new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(text)?.[1] ?? "";
}

async function requireOk(response: Response, action: string) {
  if (!response.ok) throw new Error(`${action} failed with R2 status ${response.status}`);
  return response;
}

async function createMultipart(creds: R2Credentials, key: string) {
  const response = await requireOk(await signedR2Fetch(creds, "POST", key, "", { query: { uploads: "" } }), "R2 multipart create");
  const uploadId = xml(await response.text(), "UploadId");
  if (!uploadId) throw new Error("R2 multipart create did not return UploadId");
  return uploadId;
}

async function completeMultipart(creds: R2Credentials, key: string, uploadId: string, parts: Array<{ number: number; etag: string }>) {
  const body = `<CompleteMultipartUpload>${parts.sort((a, b) => a.number - b.number).map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>${part.etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
  await requireOk(await signedR2Fetch(creds, "POST", key, body, { query: { uploadId }, headers: { "content-type": "application/xml" } }), "R2 multipart complete");
}

async function copyObject(creds: R2Credentials, source: string, target: string) {
  await requireOk(await signedR2Fetch(creds, "PUT", target, "", { headers: { "x-amz-copy-source": `/${creds.bucket}/${source}` } }), "R2 staging copy");
}

async function headSize(creds: R2Credentials, key: string) {
  const response = await requireOk(await signedR2Fetch(creds, "HEAD", key), "R2 object HEAD");
  return Number(response.headers.get("content-length"));
}

async function streamFileToMultipart(creds: R2Credentials, state: FluxCacheState, file: FluxCacheFile, deadline: number) {
  const entry = state.files[file.relativePath];
  if (entry.completed) return;
  entry.upload_id ??= await createMultipart(creds, entry.staging_key);
  saveState(state);
  const completed = new Map(entry.parts.map((part) => [part.number, part]));
  const totalParts = Math.ceil(file.size / PART_BYTES);
  for (let number = 1; number <= totalParts; number += 1) {
    if (Date.now() > deadline) throw new Error("seed_time_limit_reached");
    if (completed.has(number)) continue;
    const start = (number - 1) * PART_BYTES;
    const end = Math.min(file.size - 1, start + PART_BYTES - 1);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const source = await fetch(sourceUrl(file), { headers: { Range: `bytes=${start}-${end}` } });
        if (!(source.ok || source.status === 206)) throw new Error(`HF part status ${source.status}`);
        const body = Buffer.from(await source.arrayBuffer());
        if (body.byteLength !== end - start + 1) throw new Error("HF part length mismatch");
        const uploaded = await requireOk(await signedR2Fetch(creds, "PUT", entry.staging_key, body, { query: { partNumber: String(number), uploadId: entry.upload_id } }), "R2 multipart part");
        const etag = uploaded.headers.get("etag");
        if (!etag) throw new Error("R2 multipart part did not return ETag");
        entry.parts.push({ number, etag });
        saveState(state);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
  }
  const source = await fetch(sourceUrl(file));
  if (!source.ok || !source.body) throw new Error(`HF checksum stream failed with ${source.status}`);
  const hash = createHash("sha256");
  for await (const chunk of source.body as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
  entry.source_sha256 = hash.digest("hex");
  if (entry.source_sha256 !== file.sha256) throw new Error(`HF source sha256 mismatch for ${file.filename}`);
  await completeMultipart(creds, entry.staging_key, entry.upload_id, entry.parts);
  if (await headSize(creds, entry.staging_key) !== file.size) throw new Error(`R2 staging size mismatch for ${file.filename}`);
  const finalKey = `${PREFIX}/revisions/${REVISION}/files/${file.relativePath}`;
  await copyObject(creds, entry.staging_key, finalKey);
  if (await headSize(creds, finalKey) !== file.size) throw new Error(`R2 final size mismatch for ${file.filename}`);
  entry.completed = true;
  saveState(state);
}

export function buildFluxCacheManifest() {
  return { schema_version: 1, model: "FLUX.2-klein-4b", revision: REVISION, generated_at: new Date().toISOString(), files: fluxCacheFiles.map((file) => ({ relative_path: file.relativePath, repository: file.repository, revision: file.revision, size_bytes: file.size, sha256: file.sha256, key: `${PREFIX}/revisions/${REVISION}/files/${file.relativePath}` })) };
}

export async function seedFlux4090Cache(maxMinutes = 120) {
  const creds = loadR2Credentials("model-cache-admin.env");
  const state = readState();
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  for (const file of fluxCacheFiles) await streamFileToMultipart(creds, state, file, deadline);
  const manifest = buildFluxCacheManifest();
  await requireOk(await signedR2Fetch(creds, "PUT", fluxCacheManifestKey, Buffer.from(JSON.stringify(manifest, null, 2))), "R2 revision manifest publish");
  await requireOk(await signedR2Fetch(creds, "PUT", fluxCacheCurrentKey, Buffer.from(JSON.stringify({ revision: REVISION, manifest_key: fluxCacheManifestKey, published_at: new Date().toISOString() }, null, 2))), "R2 current.json publish");
  return { complete: true, revision: REVISION, current_json_published: true, files: fluxCacheFiles.map((file) => ({ filename: file.filename, sha256: file.sha256, size: file.size })) };
}

export function fluxCacheStatus() {
  const state = readState();
  return { revision: state.revision, current_key: fluxCacheCurrentKey, local_temp_bytes: 0, files: fluxCacheFiles.map((file) => ({ filename: file.filename, expected_size: file.size, expected_sha256: file.sha256, uploaded_parts: state.files[file.relativePath]?.parts.length ?? 0, completed: state.files[file.relativePath]?.completed === true })) };
}

async function main() {
  const mode = process.argv[2] ?? "status";
  const output = mode === "status" ? fluxCacheStatus() : await seedFlux4090Cache(Number(process.env.FLUX_R2_SEED_MAX_MINUTES ?? 120));
  const text = JSON.stringify(output, null, 2);
  assertNoSecretOutput(text);
  console.log(text);
}
if (process.argv[1]?.endsWith("flux4090-cache.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "FLUX R2 seed failed"); process.exitCode = 1; });
