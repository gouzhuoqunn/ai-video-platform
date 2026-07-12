import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadModelCacheConfig } from "./config";

export type R2Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  region: string;
  prefix: string;
};

function parseEnvFile(filePath: string) {
  const values = new Map<string, string>();
  if (!existsSync(filePath)) return values;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (match) values.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
  }
  return values;
}

function required(values: Map<string, string>, name: string) {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function loadR2Credentials(fileName: string): R2Credentials {
  const config = loadModelCacheConfig();
  const filePath = path.join(process.cwd(), ".secrets", fileName);
  const values = parseEnvFile(filePath);
  if (!existsSync(filePath)) throw new Error(`Missing ${fileName}`);
  return {
    accessKeyId: required(values, "MODEL_CACHE_ACCESS_KEY_ID"),
    secretAccessKey: required(values, "MODEL_CACHE_SECRET_ACCESS_KEY"),
    bucket: values.get("MODEL_CACHE_BUCKET") || config.bucket,
    endpoint: values.get("MODEL_CACHE_ENDPOINT") || config.endpoint,
    region: values.get("MODEL_CACHE_REGION") || config.region || "auto",
    prefix: values.get("MODEL_CACHE_PREFIX") || config.prefix,
  };
}

function hmac(key: Buffer | string, value: string) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function sha256Hex(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function toFetchBody(value: Buffer | string): BodyInit {
  if (typeof value === "string") return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function encodePath(value: string) {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

function canonicalQuery(url: URL) {
  return [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function signingKey(secretAccessKey: string, dateStamp: string, region: string) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

export function buildR2ObjectUrl(creds: Pick<R2Credentials, "endpoint" | "bucket">, key: string) {
  return new URL(`${creds.endpoint.replace(/\/$/, "")}/${creds.bucket}/${encodePath(key)}`);
}

export async function signedR2Fetch(creds: R2Credentials, method: string, key: string, body: Buffer | string = "") {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const url = buildR2ObjectUrl(creds, key);
  const payloadHash = sha256Hex(body);
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, url.pathname, canonicalQuery(url), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${creds.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(creds.secretAccessKey, dateStamp, creds.region)).update(stringToSign, "utf8").digest("hex");
  return fetch(url, {
    method,
    body: method === "GET" || method === "HEAD" ? undefined : toFetchBody(body),
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  });
}

export function createPresignedPutUrl(input: { creds: R2Credentials; key: string; expiresSeconds: number; now?: Date; contentType?: string }) {
  if (input.expiresSeconds < 1 || input.expiresSeconds > 7200) {
    throw new Error("presigned PUT expiry must be between 1 and 7200 seconds");
  }
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.creds.region}/s3/aws4_request`;
  const url = buildR2ObjectUrl(input.creds, input.key);
  const signedHeaders = input.contentType ? "content-type;host" : "host";
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${input.creds.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(input.expiresSeconds));
  url.searchParams.set("X-Amz-SignedHeaders", signedHeaders);
  const canonicalHeaders = input.contentType ? `content-type:${input.contentType}\nhost:${url.host}\n` : `host:${url.host}\n`;
  const canonicalRequest = ["PUT", url.pathname, canonicalQuery(url), canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(input.creds.secretAccessKey, dateStamp, input.creds.region)).update(stringToSign, "utf8").digest("hex");
  url.searchParams.set("X-Amz-Signature", signature);
  return url.toString();
}
