import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FLUX_MODEL_FILES } from "../flux-first-image";
import { assertNoSecretOutput } from "../clore/client";
import { loadR2Credentials, signedR2Fetch, type R2Credentials } from "./r2-presign";

const PREFIX = "production/rtx4090/image";
const PART_BYTES = 64 * 1024 * 1024;
const CONCURRENT_PARTS = 2;
const HTTP_TIMEOUT_MS = 120_000;
const STATE_DIR = process.env.FLUX_R2_SEED_STATE_DIR ? path.resolve(process.env.FLUX_R2_SEED_STATE_DIR) : path.join(process.cwd(), ".secrets");
const STATE_PATH = path.join(STATE_DIR, "flux4090-r2-seed-state.json");
const REVISION = "flux2-klein-4b-5b4408e59397-a9e4ca87c16d";

export type FluxCacheFile = (typeof FLUX_MODEL_FILES)[number] & { relativePath: string };
export type FluxCacheState = { session_id: string; revision: string; started_at: string; files: Record<string, { staging_key: string; upload_id?: string; parts: Array<{ number: number; etag: string }>; expected_size?: number; expected_sha256?: string; uploaded_bytes?: number; source_sha256?: string; completed?: boolean }> };

export const fluxCacheFiles: FluxCacheFile[] = FLUX_MODEL_FILES.map((file) => ({ ...file, relativePath: `${file.targetDirectory}/${file.filename}` }));
export const fluxCacheCurrentKey = `${PREFIX}/current.json`;
export const fluxCacheManifestKey = `${PREFIX}/revisions/${REVISION}/manifest.json`;

function readState(): FluxCacheState {
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")) as FluxCacheState;
  const sessionId = randomUUID();
  return { session_id: sessionId, revision: REVISION, started_at: new Date().toISOString(), files: Object.fromEntries(fluxCacheFiles.map((file) => [file.relativePath, { staging_key: `${PREFIX}/staging/${sessionId}/files/${file.relativePath}`, parts: [], expected_size: file.size, expected_sha256: file.sha256, uploaded_bytes: 0 }])) };
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, action: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.FLUX_R2_HTTP_TIMEOUT_MS ?? HTTP_TIMEOUT_MS));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`${action} timed out`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSourcePart(file: FluxCacheFile, number: number, start: number, end: number) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const source = await fetchWithTimeout(sourceUrl(file), { headers: { Range: `bytes=${start}-${end}` }, redirect: "follow" }, `HF ${file.filename} part ${number}`);
      if (!(source.ok || source.status === 206)) throw new Error(`HF part ${number} status ${source.status}`);
      const body = Buffer.from(await source.arrayBuffer());
      if (body.byteLength !== end - start + 1) throw new Error(`HF part ${number} length mismatch`);
      return { number, body };
    } catch (error) {
      lastError = error;
      await sleep(1000 * attempt);
    }
  }
  throw lastError;
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
  entry.expected_size = file.size;
  entry.expected_sha256 = file.sha256;
  entry.uploaded_bytes = entry.parts.reduce((total, part) => total + Math.min(PART_BYTES, Math.max(0, file.size - (part.number - 1) * PART_BYTES)), 0);
  entry.upload_id ??= await createMultipart(creds, entry.staging_key);
  saveState(state);
  const completed = new Map(entry.parts.map((part) => [part.number, part]));
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
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const uploaded = await requireOk(await signedR2Fetch(creds, "PUT", entry.staging_key, body, { query: { partNumber: String(partNumber), uploadId: entry.upload_id } }), "R2 multipart part");
        const etag = uploaded.headers.get("etag");
        if (!etag) throw new Error("R2 multipart part did not return ETag");
          entry.parts.push({ number: partNumber, etag });
          completed.set(partNumber, { number: partNumber, etag });
          entry.uploaded_bytes = (entry.uploaded_bytes ?? 0) + body.byteLength;
        saveState(state);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
          await sleep(1000 * attempt);
      }
    }
    if (lastError) throw lastError;
  }
  }
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

async function getJson<T>(creds: R2Credentials, key: string): Promise<T> {
  const response = await requireOk(await signedR2Fetch(creds, "GET", key), `R2 GET ${key}`);
  return (await response.json()) as T;
}

async function getRange(creds: R2Credentials, key: string, start: number, end: number) {
  const response = await requireOk(await signedR2Fetch(creds, "GET", key, "", { headers: { range: `bytes=${start}-${end}` } }), `R2 range ${key}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength !== end - start + 1) throw new Error(`R2 range length mismatch for ${key}`);
  return body.byteLength;
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
  return { revision: state.revision, current_key: fluxCacheCurrentKey, local_temp_bytes: 0, state_path: STATE_PATH.replace(process.cwd(), "."), files: fluxCacheFiles.map((file) => ({ filename: file.filename, expected_size: file.size, expected_sha256: file.sha256, uploaded_parts: state.files[file.relativePath]?.parts.length ?? 0, uploaded_bytes: state.files[file.relativePath]?.uploaded_bytes ?? 0, completed: state.files[file.relativePath]?.completed === true })) };
}

export async function verifyFlux4090Cache() {
  const creds = loadR2Credentials("model-cache-readonly.env");
  const current = await getJson<{ revision: string; manifest_key: string }>(creds, fluxCacheCurrentKey);
  if (current.revision !== REVISION) throw new Error("R2 current.json does not point to the expected FLUX4090 revision");
  if (current.manifest_key !== fluxCacheManifestKey) throw new Error("R2 current.json manifest key mismatch");
  const manifest = await getJson<ReturnType<typeof buildFluxCacheManifest>>(creds, current.manifest_key);
  if (manifest.revision !== REVISION || manifest.files.length !== fluxCacheFiles.length) throw new Error("R2 revision manifest mismatch");
  const objects = [];
  for (const file of fluxCacheFiles) {
    const manifestFile = manifest.files.find((item) => item.relative_path === file.relativePath);
    if (!manifestFile) throw new Error(`R2 revision manifest missing ${file.filename}`);
    if (manifestFile.size_bytes !== file.size || manifestFile.sha256 !== file.sha256) throw new Error(`R2 manifest metadata mismatch for ${file.filename}`);
    const size = await headSize(creds, manifestFile.key);
    if (size !== file.size) throw new Error(`R2 final object size mismatch for ${file.filename}`);
    const first_range_bytes = await getRange(creds, manifestFile.key, 0, Math.min(1023, file.size - 1));
    const last_range_bytes = await getRange(creds, manifestFile.key, Math.max(0, file.size - 1024), file.size - 1);
    objects.push({ filename: file.filename, key: manifestFile.key, size, sha256: file.sha256, first_range_bytes, last_range_bytes });
  }
  const writeProbe = await signedR2Fetch(creds, "PUT", `${PREFIX}/readonly-probe-blocked.txt`, "blocked\n");
  if (writeProbe.ok) throw new Error("GPU readonly R2 credentials unexpectedly allowed PUT");
  return { flux4090_cache_complete: true, gpu_readonly_restore_probe: true, revision: REVISION, current_key: fluxCacheCurrentKey, manifest_key: fluxCacheManifestKey, objects };
}

async function main() {
  const mode = process.argv[2] ?? "status";
  const output = mode === "status" ? fluxCacheStatus() : mode === "verify" ? await verifyFlux4090Cache() : await seedFlux4090Cache(Number(process.env.FLUX_R2_SEED_MAX_MINUTES ?? 120));
  const text = JSON.stringify(output, null, 2);
  assertNoSecretOutput(text);
  console.log(text);
}
if (process.argv[1]?.endsWith("flux4090-cache.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "FLUX R2 seed failed"); process.exitCode = 1; });
