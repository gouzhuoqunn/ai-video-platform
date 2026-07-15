import assert from "node:assert/strict";
import { buildColabBundle, createPresignedGetUrl } from "./first-image-colab-bundle";
import type { R2Credentials } from "./model-cache/r2-presign";

const credentials: R2Credentials = { accessKeyId: "TESTACCESS", secretAccessKey: "test-secret-value", bucket: "test-bucket", endpoint: "https://example.r2.cloudflarestorage.com", region: "auto", prefix: "production/rtx4090/image" };
const now = new Date("2026-07-16T00:00:00.000Z");
const url = new URL(createPresignedGetUrl(credentials, "production/rtx4090/image/test.bin", 7200, now));
assert.equal(url.searchParams.get("X-Amz-Expires"), "7200");
assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
assert.ok(url.searchParams.has("X-Amz-Signature"));
assert.throws(() => createPresignedGetUrl(credentials, "test", 7201, now), /expiry/);
const bundle = buildColabBundle(credentials, now);
assert.equal(bundle.files.length, 3);
assert.equal(bundle.expires_at, "2026-07-16T02:00:00.000Z");
assert.ok(!JSON.stringify(bundle).includes(credentials.secretAccessKey));
console.log("Colab presigned GET bundle tests passed.");
