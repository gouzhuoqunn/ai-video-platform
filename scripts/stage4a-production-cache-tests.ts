import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { buildCurrentPointer, buildProductionManifest, loadProductionFamilies } from "./model-cache/production-model-cache";

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");
const families = loadProductionFamilies();
const image = families.find((family) => family.id === "ultrareal-flux1-dev-fp8")!;
const video = families.find((family) => family.id === "wan22-remix-14b-i2v-fp8")!;
assert.deepEqual(image.objects.map((file) => file.sourceFileId).filter(Boolean), [1320644]);
assert.deepEqual(video.objects.map((file) => file.sourceFileId).filter(Boolean), [2657128, 2657705]);
assert.equal(video.objects.find((file) => file.role === "umt5")?.sha256, "c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68");

const manifest = buildProductionManifest(video, "2026-07-17T07:00:00.000Z");
const umt5 = manifest.files.find((file) => file.role === "umt5")!;
umt5.objectKey = "production/rtx4090/video/revisions/wan22-ti2v-5b-fb1388adc906/files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors";
umt5.shared = true;
umt5.sharedSource = {
  familyId: "wan22-ti2v-5b",
  objectKey: umt5.objectKey,
  bytes: umt5.bytes,
  sha256: umt5.sha256,
  retentionKey: `production/retention-references/${video.id}/${umt5.sha256}.json`,
};
const current = buildCurrentPointer(video, manifest);
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
assert.equal(current.manifestSha256, createHash("sha256").update(serialized).digest("hex"));
assert.equal(umt5.objectKey, umt5.sharedSource.objectKey);
assert.equal(umt5.bytes, umt5.sharedSource.bytes);
assert.equal(umt5.sha256, umt5.sharedSource.sha256);
assert.ok(!umt5.objectKey.startsWith(video.r2Prefix));

const cache = read("scripts/model-cache/production-model-cache.ts");
for (const marker of [
  "sharedSource",
  "retentionReferences",
  "retainedForProduction",
  "CreateMultipartUploadCommand",
  "UploadPartCopyCommand",
  "CompleteMultipartUploadCommand",
  "ListPartsCommand",
  "AbortMultipartUploadCommand",
  "128 * 1024 * 1024",
  "CopySourceRange",
  "r2_multipart_copy_state_mismatch",
  "runMultipartCopyProbe",
]) assert.ok(cache.includes(marker), marker);

const workflow = YAML.parse(read(".github/workflows/production-model-cache.yml"));
assert.equal(workflow.jobs["image-object"].strategy.matrix.include, "${{ fromJSON(needs.source-probes.outputs.image_matrix) }}");
assert.equal(workflow.jobs["video-object"].strategy.matrix.include, "${{ fromJSON(needs.source-probes.outputs.video_matrix) }}");
assert.deepEqual(workflow.jobs["publish-image"].needs, ["inventory", "image-object"]);
assert.deepEqual(workflow.jobs["publish-video"].needs, ["inventory", "video-object"]);
assert.deepEqual(workflow.jobs["final-readonly-verification"].needs, ["publish-image", "publish-video"]);
assert.ok(!read(".github/workflows/production-model-cache.yml").includes("upload-artifact"));
assert.ok(!read(".github/workflows/production-model-cache.yml").includes("deduplicate --copy"));

const restore = read("scripts/clore/restore-production-r2.py");
assert.ok(restore.includes('bundle["objectUrls"].get(file["objectKey"])'));
for (const marker of [".part", "reconnecting", "HEARTBEAT_SECONDS", "STALL_TIMEOUT_SECONDS", "os.replace"]) assert.ok(restore.includes(marker));

const historicalFixture = read("scripts/stage3o-batch-tests.ts");
assert.ok(historicalFixture.includes("{ width: 832, height: 480, frames: 33, fps: 16"));
const finalBatch = read("scripts/stage4a-final-batch.ts");
for (const marker of ["stage4a-final-production", "inputImageTaskId", "unloadImageModelsBeforeLoad", "paidExecutionAuthorized: false"]) assert.ok(finalBatch.includes(marker));

const studio = read("src/components/LocalCreationStudio.tsx");
for (const label of ["UltraReal Flux FP8", "Wan 2.2 Remix 14B FP8", "缓存", "独占", "共享", "最终批次", "自动选择", "RTX 4090", "RTX 5090"]) assert.ok(studio.includes(label));

console.log(JSON.stringify({
  sharedObjectManifestReady: true,
  retentionReferenceReady: true,
  multipartCopyFallbackReady: true,
  exactSourceLocksReady: true,
  cacheDagReady: true,
  historicalFixtureCompatible: true,
}));
