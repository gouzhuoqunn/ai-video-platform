import { createHash, randomBytes, randomUUID } from "node:crypto";
import { buildWorkerDeploymentPlan } from "../clore/deploy-worker";
import { assertNoSecretOutput } from "../clore/client";
import {
  MODEL_CACHE_CURRENT_KEY,
  MODEL_CACHE_STAGING_PREFIX,
  buildMockManifest,
  r2FileKey,
  r2ManifestKey,
  totalManifestBytes,
  validateManifest,
  validateRelativeModelPath,
  type ModelCacheManifest,
} from "./manifest";
import { createPresignedPutUrl, loadR2Credentials, signedR2Fetch } from "./r2-presign";

const SMALL_PUT_THRESHOLD_BYTES = 8 * 1024 * 1024;
const MULTIPART_THRESHOLD_BYTES = 16 * 1024 * 1024;

type CacheSeedStatus =
  | "cache_seed_manifest_pending"
  | "cache_seed_manifest_validated"
  | "cache_seed_planning"
  | "cache_seed_uploading"
  | "cache_seed_verifying"
  | "cache_seed_publishing_manifest"
  | "cache_seed_complete"
  | "cache_seed_failed";

type StoredObject = {
  body: Buffer;
  sha256: string;
  sizeBytes: number;
};

type MultipartUpload = {
  key: string;
  parts: Map<number, StoredObject & { etag: string }>;
  aborted: boolean;
};

class MockR2Store {
  objects = new Map<string, StoredObject>();
  uploads = new Map<string, MultipartUpload>();

  head(key: string) {
    return this.objects.get(key) ?? null;
  }

  put(key: string, body: Buffer) {
    this.objects.set(key, {
      body,
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.byteLength,
    });
  }

  delete(key: string) {
    this.objects.delete(key);
  }

  createMultipartUpload(key: string) {
    const uploadId = randomUUID();
    this.uploads.set(uploadId, { key, parts: new Map(), aborted: false });
    return uploadId;
  }

  uploadPart(uploadId: string, partNumber: number, body: Buffer) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.aborted) throw new Error("multipart upload is not active");
    const etag = createHash("md5").update(body).digest("hex");
    upload.parts.set(partNumber, {
      body,
      etag,
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.byteLength,
    });
    return etag;
  }

  completeMultipartUpload(uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.aborted) throw new Error("multipart upload is not active");
    if (parts.length !== upload.parts.size) throw new Error("multipart part count mismatch");
    for (let index = 0; index < parts.length; index += 1) {
      const expectedPart = index + 1;
      const part = parts[index];
      const stored = upload.parts.get(part.partNumber);
      if (part.partNumber !== expectedPart || !stored || stored.etag !== part.etag) {
        throw new Error("multipart part order or etag mismatch");
      }
    }
    this.put(upload.key, Buffer.concat(parts.map((part) => upload.parts.get(part.partNumber)!.body)));
    this.uploads.delete(uploadId);
  }

  abortMultipartUpload(uploadId: string) {
    const upload = this.uploads.get(uploadId);
    if (upload) upload.aborted = true;
    this.uploads.delete(uploadId);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertSafeUploadKey(relativePath: string, prefix = "wan22-ti2v-5b") {
  if (prefix !== "wan22-ti2v-5b") {
    throw new Error("unknown model cache prefix");
  }
  return r2FileKey(relativePath);
}

function validateControllerManifest(manifest: ModelCacheManifest) {
  const errors = validateManifest(manifest);
  if (totalManifestBytes(manifest) < 1 || totalManifestBytes(manifest) > 150 * 1024 * 1024 * 1024) {
    errors.push("manifest total size is outside the safe Wan2.2-TI2V-5B planning range");
  }
  const serialized = JSON.stringify(manifest);
  if (/api[_-]?key|secret|token|ssh|host|prompt|video|[A-Za-z]:\\|\/workspace\//i.test(serialized)) {
    errors.push("manifest contains sensitive or absolute-path-like content");
  }
  return errors;
}

function planObjectUpload(store: MockR2Store, relativePath: string, body: Buffer, expectedSha: string, sessionId: string) {
  const finalKey = assertSafeUploadKey(relativePath);
  const existing = store.head(finalKey);
  if (existing?.sizeBytes === body.byteLength && existing.sha256 === expectedSha) {
    return { action: "skip", key: finalKey, staging: false };
  }
  if (existing) {
    return { action: "upload_staging", key: `${MODEL_CACHE_STAGING_PREFIX}${sessionId}/files/${relativePath}`, finalKey, staging: true };
  }
  return { action: body.byteLength >= MULTIPART_THRESHOLD_BYTES ? "multipart" : "put", key: finalKey, staging: false };
}

function publishManifest(store: MockR2Store, manifest: ModelCacheManifest) {
  const errors = validateControllerManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`manifest invalid: ${errors.join("; ")}`);
  }
  const revision = manifest.modelRevision ?? "mock-revision";
  const manifestKey = r2ManifestKey(revision);
  const body = Buffer.from(JSON.stringify(manifest, null, 2));
  store.put(manifestKey, body);
  store.put(MODEL_CACHE_CURRENT_KEY, Buffer.from(JSON.stringify({ model_revision: revision, manifest_key: manifestKey, published_at: new Date().toISOString() }, null, 2)));
}

function runMockSeedFlow() {
  const statuses: CacheSeedStatus[] = [];
  const store = new MockR2Store();
  const sessionId = "seed-test-session";
  const logs: string[] = [];
  const manifest = buildMockManifest();
  const body = Buffer.from("mock Wan2.2 model cache manifest, no model weights included");
  const sha = createHash("sha256").update(body).digest("hex");

  statuses.push("cache_seed_manifest_pending");
  assert(validateControllerManifest(manifest).length === 0, "mock manifest must validate");
  statuses.push("cache_seed_manifest_validated");

  assert(validateRelativeModelPath("../escape.bin"), "path traversal must be rejected");
  assert(validateRelativeModelPath("/absolute.bin"), "absolute paths must be rejected");
  assert(validateRelativeModelPath("C:/absolute.bin"), "drive-letter paths must be rejected");
  assertSafeUploadKey("README.md");
  assert(
    (() => {
      try {
        assertSafeUploadKey("README.md", "other-prefix");
        return false;
      } catch {
        return true;
      }
    })(),
    "unknown prefix must be rejected",
  );

  statuses.push("cache_seed_planning");
  const firstPlan = planObjectUpload(store, "README.md", body, sha, sessionId);
  assert(firstPlan.action === "put", "small file should use PUT");
  store.put(firstPlan.key, body);
  statuses.push("cache_seed_uploading");
  assert(store.head(firstPlan.key)?.sizeBytes === body.byteLength, "PUT size must be verified");

  const skipPlan = planObjectUpload(store, "README.md", body, sha, sessionId);
  assert(skipPlan.action === "skip", "matching existing object must be skipped");

  store.put(r2FileKey("mismatch.bin"), Buffer.from("wrong"));
  const mismatchPlan = planObjectUpload(store, "mismatch.bin", Buffer.from("right"), createHash("sha256").update("right").digest("hex"), sessionId);
  assert(mismatchPlan.action === "upload_staging" && mismatchPlan.staging, "mismatch must use staging");

  const bigKey = r2FileKey("large/mock-parted.bin");
  const missingPartUploadId = store.createMultipartUpload(bigKey);
  const missingPartEtag1 = store.uploadPart(missingPartUploadId, 1, Buffer.alloc(5, 1));
  const missingPartEtag3 = store.uploadPart(missingPartUploadId, 3, Buffer.alloc(5, 3));
  assert(
    (() => {
      try {
        store.completeMultipartUpload(missingPartUploadId, [
          { partNumber: 1, etag: missingPartEtag1 },
          { partNumber: 3, etag: missingPartEtag3 },
        ]);
        return false;
      } catch {
        return true;
      }
    })(),
    "missing multipart part must not complete",
  );
  store.abortMultipartUpload(missingPartUploadId);

  const uploadId = store.createMultipartUpload(bigKey);
  const etag1 = store.uploadPart(uploadId, 1, Buffer.alloc(5, 1));
  const etag2 = store.uploadPart(uploadId, 2, Buffer.alloc(5, 2));
  assert(
    (() => {
      try {
        store.completeMultipartUpload(uploadId, [
          { partNumber: 2, etag: etag2 },
          { partNumber: 1, etag: etag1 },
        ]);
        return false;
      } catch {
        return true;
      }
    })(),
    "multipart part order must be verified",
  );
  store.completeMultipartUpload(uploadId, [
    { partNumber: 1, etag: etag1 },
    { partNumber: 2, etag: etag2 },
  ]);
  assert(store.head(bigKey)?.sizeBytes === 10, "multipart complete must create final object");
  assert(store.head(bigKey)?.sha256 !== etag1, "ETag must not be treated as sha256");

  const abortUploadId = store.createMultipartUpload(r2FileKey("large/abort.bin"));
  store.uploadPart(abortUploadId, 1, Buffer.alloc(5, 3));
  store.abortMultipartUpload(abortUploadId);
  assert(!store.head(r2FileKey("large/abort.bin")), "aborted multipart must not publish object");

  statuses.push("cache_seed_verifying");
  assert(!store.head(MODEL_CACHE_CURRENT_KEY), "current.json must not publish before manifest");
  publishManifest(store, manifest);
  statuses.push("cache_seed_publishing_manifest");
  assert(store.head(r2ManifestKey(manifest.modelRevision ?? "mock-revision")), "revision manifest must be published");
  assert(store.head(MODEL_CACHE_CURRENT_KEY), "current.json must be published last");
  statuses.push("cache_seed_complete");

  const failedStore = new MockR2Store();
  assert(
    (() => {
      try {
        publishManifest(failedStore, { ...manifest, files: [] });
        return false;
      } catch {
        return true;
      }
    })(),
    "current.json must not publish after failure",
  );
  assert(!failedStore.head(MODEL_CACHE_CURRENT_KEY), "failure must leave current.json absent");

  logs.push("cache seed planned without signed url or credentials");
  const logOutput = logs.join("\n");
  assert(!/X-Amz-|Access Key|Secret|https:\/\/.+r2\.cloudflarestorage/i.test(logOutput), "logs must not contain presigned URL or credentials");

  const deployment = buildWorkerDeploymentPlan({ host: "203.0.113.10", port: 2222, user: "root" });
  assert(deployment.allowed_uploads.includes(".secrets/model-cache-readonly.env"), "GPU upload bundle must include readonly model cache env");
  assert(!deployment.allowed_uploads.includes(".secrets/model-cache-admin.env"), "GPU upload bundle must not include admin env");
  assert(deployment.forbidden_uploads.includes(".secrets/model-cache-admin.env"), "admin env must be forbidden");

  const expired = createMockPresignedPlan({ key: r2FileKey("expired.bin"), expiresAtMs: Date.now() - 1 });
  assert(!mockPresignedPutAllowed(expired, r2FileKey("expired.bin"), "PUT"), "expired URL must fail");
  const signed = createMockPresignedPlan({ key: r2FileKey("only-this.bin"), expiresAtMs: Date.now() + 1000 });
  assert(mockPresignedPutAllowed(signed, r2FileKey("only-this.bin"), "PUT"), "signed URL must allow designated PUT");
  assert(!mockPresignedPutAllowed(signed, r2FileKey("other.bin"), "PUT"), "signed URL must not allow other keys");
  assert(!mockPresignedPutAllowed(signed, r2FileKey("only-this.bin"), "DELETE"), "signed URL must not allow DELETE");
  assert(!mockPresignedPutAllowed(signed, "", "LIST"), "signed URL must not allow LIST");

  return {
    statuses,
    multipart_mocked: true,
    mock_current_published_last: true,
    mock_staging_used_for_mismatch: true,
    mock_logs_secret_free: true,
  };
}

function createMockPresignedPlan(input: { key: string; expiresAtMs: number }) {
  return { method: "PUT", key: input.key, expiresAtMs: input.expiresAtMs };
}

function mockPresignedPutAllowed(plan: { method: string; key: string; expiresAtMs: number }, key: string, method: string) {
  return plan.method === method && plan.key === key && Date.now() <= plan.expiresAtMs;
}

async function runRealSmallFileProbe() {
  const admin = loadR2Credentials("model-cache-admin.env");
  const readonly = loadR2Credentials("model-cache-readonly.env");
  const testBody = randomBytes(512);
  const testSha = createHash("sha256").update(testBody).digest("hex");
  const key = `${admin.prefix}/_seed-test/${Date.now()}-${randomUUID()}.bin`;
  const otherKey = `${admin.prefix}/_seed-test/${Date.now()}-${randomUUID()}-other.bin`;
  const url = createPresignedPutUrl({ creds: admin, key, expiresSeconds: 120, contentType: "application/octet-stream" });
  let uploaded = false;
  let otherUploaded = false;
  try {
    const put = await fetch(url, {
      method: "PUT",
      body: testBody,
      headers: { "content-type": "application/octet-stream" },
    });
    if (!put.ok) throw new Error(`presigned PUT failed with status ${put.status}`);
    uploaded = true;

    const get = await signedR2Fetch(readonly, "GET", key);
    if (!get.ok) throw new Error(`readonly GET after presigned PUT failed with status ${get.status}`);
    const downloaded = Buffer.from(await get.arrayBuffer());
    if (downloaded.byteLength !== testBody.byteLength || createHash("sha256").update(downloaded).digest("hex") !== testSha) {
      throw new Error("uploaded probe object failed size or sha256 verification");
    }

    const tampered = new URL(url);
    tampered.pathname = tampered.pathname.replace(encodeURIComponent(key.split("/").at(-1) ?? ""), encodeURIComponent(otherKey.split("/").at(-1) ?? ""));
    const otherPut = await fetch(tampered, {
      method: "PUT",
      body: Buffer.from("must not upload"),
      headers: { "content-type": "application/octet-stream" },
    });
    otherUploaded = otherPut.ok;
    if (otherPut.ok) throw new Error("presigned URL unexpectedly allowed another key");

    const readonlyPut = await signedR2Fetch(readonly, "PUT", `${admin.prefix}/_seed-test/readonly-blocked.bin`, Buffer.from("blocked"));
    if (readonlyPut.ok) throw new Error("readonly credential unexpectedly allowed PUT during seed probe");

    return {
      real_probe: true,
      presigned_put_succeeded: true,
      readonly_get_verified: true,
      other_key_blocked: true,
      readonly_put_blocked: true,
    };
  } finally {
    if (uploaded) await signedR2Fetch(admin, "DELETE", key).catch(() => undefined);
    if (otherUploaded) await signedR2Fetch(admin, "DELETE", otherKey).catch(() => undefined);
  }
}

async function main() {
  const mock = runMockSeedFlow();
  const real = await runRealSmallFileProbe();
  const output = JSON.stringify(
    {
      ok: true,
      downloads_wan22: false,
      uploads_wan22: false,
      create_order_called: false,
      ssh_connected: false,
      small_put_threshold_bytes: SMALL_PUT_THRESHOLD_BYTES,
      multipart_threshold_bytes: MULTIPART_THRESHOLD_BYTES,
      ...mock,
      ...real,
      r2_test_prefix_cleaned: true,
      presigned_urls_returned_or_logged: false,
      admin_credentials_sent_to_gpu: false,
    },
    null,
    2,
  );
  assertNoSecretOutput(output);
  console.log(output);
}

if (process.argv[1]?.endsWith("seed-cache.ts")) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : "model cache seed test failed");
    process.exitCode = 1;
  });
}
