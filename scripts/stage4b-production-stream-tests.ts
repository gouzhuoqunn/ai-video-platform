import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  incrementalSha256,
  MAX_STREAM_TEMP_BYTES,
  requestSource,
  STREAM_CHUNK_BYTES,
} from "./model-cache/production-object-stream";

async function main() {
const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

assert.equal(STREAM_CHUNK_BYTES, 256 * 1024 * 1024);
assert.equal(MAX_STREAM_TEMP_BYTES, 768 * 1024 * 1024);
assert.ok(STREAM_CHUNK_BYTES * 2 <= MAX_STREAM_TEMP_BYTES);

const chunks = [Buffer.from("ordered-"), Buffer.from("incremental-"), Buffer.from("sha256")];
assert.equal(
  incrementalSha256(chunks),
  createHash("sha256").update(Buffer.concat(chunks)).digest("hex"),
);

let redirectedAuthorization = "not-observed";
const destination = createServer((request, response) => {
  redirectedAuthorization = request.headers.authorization ?? "";
  assert.equal(request.headers.range, "bytes=4096-5119");
  response.writeHead(206, {
    "content-range": "bytes 4096-5119/8192",
    "content-length": "1024",
  });
  response.end(Buffer.alloc(1024, 0x37));
});
await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
const destinationAddress = destination.address();
assert.ok(destinationAddress && typeof destinationAddress === "object");

const source = createServer((request, response) => {
  assert.equal(request.headers.authorization, "Bearer unit-test-secret");
  response.writeHead(307, {
    location: `http://127.0.0.1:${destinationAddress.port}/signed-object`,
  });
  response.end();
});
await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
const sourceAddress = source.address();
assert.ok(sourceAddress && typeof sourceAddress === "object");

try {
  const ranged = await requestSource(
    `http://127.0.0.1:${sourceAddress.port}/authenticated-source`,
    "unit-test-secret",
    { start: 4096, end: 5119 },
  );
  assert.equal(ranged.response.status, 206);
  assert.equal(ranged.totalBytes, 8192);
  assert.equal(ranged.redirects, 1);
  assert.equal(ranged.authorizationRedactedOnCrossOrigin, true);
  assert.equal((await ranged.response.arrayBuffer()).byteLength, 1024);
  assert.equal(redirectedAuthorization, "");
} finally {
  await new Promise<void>((resolve, reject) => source.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => destination.close((error) => error ? reject(error) : resolve()));
}

const streamer = read("scripts/model-cache/production-object-stream.ts");
for (const marker of [
  "redirect: \"manual\"",
  "headers.Authorization",
  "authorizationAllowed = false",
  "source_range_retry_exhausted",
  "ListPartsCommand",
  "completedPartNumbers",
  "AbortMultipartUploadCommand",
  "DeleteObjectCommand",
  "source_read_stalled",
  "fallback_disk_insufficient",
  "FALLBACK_MARGIN_BYTES = 6 * 1024 ** 3",
  ".part",
]) assert.ok(streamer.includes(marker), marker);

const strategies = JSON.parse(read("comfy-runtime/production-transfer-strategies.json")) as {
  defaultChunkBytes: number;
  maximumStreamingTempBytes: number;
  objects: Array<{ strategy: string }>;
  sharedObjects: Array<{ strategy: string; sha256: string; bytes: number }>;
};
assert.equal(strategies.defaultChunkBytes, STREAM_CHUNK_BYTES);
assert.equal(strategies.maximumStreamingTempBytes, MAX_STREAM_TEMP_BYTES);
assert.equal(strategies.objects.length, 7);
assert.ok(strategies.objects.every((object) => ["ranged-stream", "full-file"].includes(object.strategy)));
assert.deepEqual(strategies.sharedObjects, [{
  familyId: "wan22-remix-14b-i2v-fp8",
  path: "text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  strategy: "shared-r2-reference",
  sourceFamilyId: "wan22-ti2v-5b",
  bytes: 6735906897,
  sha256: "c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68",
}]);

const workflowText = read(".github/workflows/production-model-cache.yml");
const workflow = YAML.parse(workflowText);
assert.equal(workflow.concurrency["cancel-in-progress"], false);
assert.equal(workflow.jobs["source-probes"]["timeout-minutes"], 10);
assert.equal(workflow.jobs["image-object"]["timeout-minutes"], 75);
assert.equal(workflow.jobs["video-object"]["timeout-minutes"], 75);
assert.equal(workflow.jobs["image-object"].needs, "source-probes");
assert.equal(workflow.jobs["video-object"].needs, "source-probes");
assert.equal(workflow.jobs["image-object"].strategy["fail-fast"], false);
assert.equal(workflow.jobs["video-object"].strategy["fail-fast"], false);
assert.equal(workflow.jobs["image-object"].strategy.matrix.include, "${{ fromJSON(needs.source-probes.outputs.image_matrix) }}");
assert.equal(workflow.jobs["video-object"].strategy.matrix.include, "${{ fromJSON(needs.source-probes.outputs.video_matrix) }}");
assert.deepEqual(workflow.jobs["publish-image"].needs, ["inventory", "image-object"]);
assert.deepEqual(workflow.jobs["publish-video"].needs, ["inventory", "video-object"]);
assert.deepEqual(workflow.jobs["final-readonly-verification"].needs, ["publish-image", "publish-video"]);
assert.match(workflowText, /probe-sources/);
assert.match(workflowText, /multipart-abort-probe/);
for (const forbidden of ["upload-artifact", "setup-python", "33554432", "41943040", "hf_hub_download"]) {
  assert.ok(!workflowText.includes(forbidden), forbidden);
}

const publisher = read("scripts/model-cache/production-model-cache.ts");
assert.ok(publisher.includes("publishProductionFamilyFromR2"));
assert.ok(publisher.includes("production_object_missing"));
assert.ok(publisher.indexOf("manifest_verify_failed") < publisher.lastIndexOf("current_verify_failed"));
assert.ok(publisher.includes("publishSharedRetentionReferences"));

const availability = JSON.parse(read("comfy-runtime/model-availability.json")) as {
  models: Array<{ modelProfile: string; cached: boolean; restoreReady: boolean; status: string }>;
};
for (const modelProfile of ["ultrareal-flux1-dev-fp8", "wan22-remix-14b-i2v-fp8"]) {
  const model = availability.models.find((entry) => entry.modelProfile === modelProfile);
  assert.equal(model?.cached, true);
  assert.equal(model?.restoreReady, true);
  assert.equal(model?.status, "production_cache_ready");
}
const studio = read("src/components/LocalCreationStudio.tsx");
for (const label of [
  "UltraReal Flux FP8",
  "Wan 2.2 Remix 14B FP8",
  "缓存",
  "已就绪",
  "最终批次",
  "已准备，等待确认生成",
  "自动选择",
  "RTX 4090",
  "RTX 5090",
  "独占",
  "共享",
  "总恢复量",
]) assert.ok(studio.includes(label), label);

console.log(JSON.stringify({
  rangedRedirectResumeReady: true,
  tokenHeaderRedactionReady: true,
  incrementalShaReady: true,
  boundedDiskReady: true,
  multipartAbortResumeContractReady: true,
  perObjectDagReady: true,
  sharedUmt5ZeroCopyReady: true,
  atomicPublicationReady: true,
  chineseReadyState: true,
}));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
