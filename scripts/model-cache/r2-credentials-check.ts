import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadModelCacheConfig } from "./config";

type R2Creds = {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  region: string;
  prefix: string;
};

const root = process.cwd();

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

function loadCreds(fileName: string): R2Creds {
  const config = loadModelCacheConfig();
  const filePath = path.join(root, ".secrets", fileName);
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

function hex(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
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

async function signedFetch(creds: R2Creds, method: string, key: string, body = "") {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const endpoint = creds.endpoint.replace(/\/$/, "");
  const pathName = `/${creds.bucket}${key ? `/${encodePath(key)}` : ""}`;
  const url = new URL(`${endpoint}${pathName}`);
  const payloadHash = hex(body);
  const host = url.host;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, url.pathname, canonicalQuery(url), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${creds.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, creds.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return fetch(url, {
    method,
    body: method === "GET" || method === "HEAD" ? undefined : body,
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  });
}

async function listPrefix(creds: R2Creds) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const endpoint = creds.endpoint.replace(/\/$/, "");
  const url = new URL(`${endpoint}/${creds.bucket}`);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", `${creds.prefix}/`);
  const payloadHash = hex("");
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["GET", url.pathname, canonicalQuery(url), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${creds.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, creds.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return fetch(url, {
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  });
}

async function main() {
  const admin = loadCreds("model-cache-admin.env");
  const readonly = loadCreds("model-cache-readonly.env");
  const key = `${admin.prefix}/permission-tests/${Date.now()}-probe.txt`;
  const body = "r2 permission probe\n";

  const adminPut = await signedFetch(admin, "PUT", key, body);
  if (!adminPut.ok) throw new Error(`Admin PUT failed with status ${adminPut.status}`);
  const readonlyGet = await signedFetch(readonly, "GET", key);
  if (!readonlyGet.ok) throw new Error(`Readonly GET failed with status ${readonlyGet.status}`);
  const readonlyList = await listPrefix(readonly);
  if (!readonlyList.ok) throw new Error(`Readonly LIST failed with status ${readonlyList.status}`);

  const readonlyPut = await signedFetch(readonly, "PUT", key, "blocked\n");
  if (readonlyPut.ok) throw new Error("Readonly PUT unexpectedly succeeded");
  const readonlyDelete = await signedFetch(readonly, "DELETE", key);
  if (readonlyDelete.ok) throw new Error("Readonly DELETE unexpectedly succeeded");

  const adminDelete = await signedFetch(admin, "DELETE", key);
  if (!adminDelete.ok) throw new Error(`Admin DELETE cleanup failed with status ${adminDelete.status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        bucket: admin.bucket,
        prefix: admin.prefix,
        admin_can_put_get_delete: true,
        readonly_can_get_list: true,
        readonly_put_blocked: true,
        readonly_delete_blocked: true,
        test_object_cleaned: true,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "R2 credential check failed");
  process.exitCode = 1;
});
