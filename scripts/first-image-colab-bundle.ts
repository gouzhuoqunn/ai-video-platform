import { createHash, createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fluxCacheFiles, fluxCacheManifestKey, finalKey } from "./model-cache/flux4090-cache";
import { buildR2ObjectUrl, loadR2Credentials, type R2Credentials } from "./model-cache/r2-presign";

const OUTPUT_PATH = path.join(process.cwd(), ".secrets", "flux-first-image-colab-bundle.json");
const MAX_EXPIRY_SECONDS = 7200;

function hmac(key: Buffer | string, value: string) { return createHmac("sha256", key).update(value, "utf8").digest(); }
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function signingKey(secret: string, date: string, region: string) {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  return hmac(hmac(regionKey, "s3"), "aws4_request");
}
function encode(value: string) { return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
function canonicalQuery(url: URL) { return [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&"); }

export function createPresignedGetUrl(creds: R2Credentials, key: string, expiresSeconds = MAX_EXPIRY_SECONDS, now = new Date()) {
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 60 || expiresSeconds > MAX_EXPIRY_SECONDS) throw new Error("Colab bundle expiry must be between 60 and 7200 seconds.");
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${creds.region}/s3/aws4_request`;
  const url = buildR2ObjectUrl(creds, key);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${creds.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  const request = ["GET", url.pathname, canonicalQuery(url), `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const signature = createHmac("sha256", signingKey(creds.secretAccessKey, dateStamp, creds.region)).update(["AWS4-HMAC-SHA256", amzDate, scope, sha256(request)].join("\n")).digest("hex");
  url.searchParams.set("X-Amz-Signature", signature);
  return url.toString();
}

export function buildColabBundle(creds: R2Credentials, now = new Date(), expiresSeconds = MAX_EXPIRY_SECONDS) {
  return {
    schema_version: 1,
    purpose: "flux_first_image_emergency_restore",
    generated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + expiresSeconds * 1000).toISOString(),
    revision_manifest_key: fluxCacheManifestKey,
    files: fluxCacheFiles.map((file) => ({
      relative_path: file.relativePath,
      size_bytes: file.size,
      sha256: file.sha256,
      download_url: createPresignedGetUrl(creds, finalKey(file), expiresSeconds, now),
    })),
  };
}

export function writeColabBundle() {
  const creds = loadR2Credentials("model-cache-admin.env");
  const bundle = buildColabBundle(creds);
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { outputPath: OUTPUT_PATH, bundle };
}

async function main() {
  const { bundle } = writeColabBundle();
  console.log(JSON.stringify({ bundle_created: true, output: ".secrets/flux-first-image-colab-bundle.json", file_count: bundle.files.length, expires_at: bundle.expires_at, urls_redacted: true }));
}

if (process.argv[1]?.endsWith("first-image-colab-bundle.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "Colab bundle failed"); process.exitCode = 1; });
