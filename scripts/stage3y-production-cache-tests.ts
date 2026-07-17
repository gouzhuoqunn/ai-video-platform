import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { buildCurrentPointer, buildProductionManifest, loadProductionFamilies, productionPublishPlan } from "./model-cache/production-model-cache";

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");
const workflow = YAML.parse(read(".github/workflows/production-model-cache.yml"));
assert.deepEqual(workflow.on.push.branches, ["codex/phase-3h-flux-parallel"]);
assert.deepEqual(workflow.on.push.paths, [".github/stage3y-cache-trigger.json"]);
assert.equal(workflow.concurrency["cancel-in-progress"], false);
assert.equal(workflow.jobs.deduplicate["timeout-minutes"], 15);
assert.equal(workflow.jobs.cache.needs, "deduplicate");
assert.equal(workflow.jobs.cache["timeout-minutes"], 75);
assert.equal(workflow.jobs.cache.strategy["fail-fast"], false);
assert.deepEqual(workflow.jobs.cache.strategy.matrix.family, ["ultrareal-flux1-dev-fp8", "wan22-remix-14b-i2v-fp8"]);
assert.deepEqual(workflow.jobs["final-readonly-verification"].needs, "cache");
assert.match(read(".github/workflows/production-model-cache.yml"), /publish-local/);
assert.match(read(".github/workflows/production-model-cache.yml"), /production-model-cache\.ts deduplicate/);
assert.ok(!read(".github/workflows/production-model-cache.yml").includes("deduplicate --copy"));
assert.match(read(".github/workflows/production-model-cache.yml"), /download-plan/);
assert.match(read(".github/workflows/production-model-cache.yml"), /verify-readonly ultrareal-flux1-dev-fp8/);
assert.match(read(".github/workflows/production-model-cache.yml"), /verify-readonly wan22-remix-14b-i2v-fp8/);
assert.ok(!read(".github/workflows/production-model-cache.yml").includes("upload-artifact"));

for (const family of loadProductionFamilies()) {
  const manifest = buildProductionManifest(family, "2026-07-17T00:00:00.000Z");
  const current = buildCurrentPointer(family, manifest);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  assert.equal(current.manifestSha256, createHash("sha256").update(serialized).digest("hex"));
  assert.equal(manifest.totalSizeBytes, family.restoreBytes);
  assert.equal(productionPublishPlan(family).uploadOrder.at(-1)?.key, family.currentKey);
  assert.ok(manifest.files.every((file) => file.objectKey.endsWith(file.sha256)));
}

const downloader = read("scripts/model-cache/production-cache-download.py");
for (const marker of ["ThreadPoolExecutor", "hf_hub_download", "HF_TOKEN", ".part", "sha256", "parallelDownloads", "skipPaths", "--download-plan", "download_heartbeat", "STALL_TIMEOUT_SECONDS"]) assert.ok(downloader.includes(marker));
const publisher = read("scripts/model-cache/production-model-cache.ts");
for (const marker of ["new Upload", "partSize", "leavePartsOnError", "Metadata: { sha256", "Range: \"bytes=0-0\"", "IfNoneMatch: \"*\"", "DeleteObjectCommand", "remoteObjectExists", "CopyObjectCommand", "CreateMultipartUploadCommand", "UploadPartCopyCommand", "CompleteMultipartUploadCommand", "AbortMultipartUploadCommand", "ListPartsCommand", "ListObjectsV2Command", "sharedObjects", "sharedSource", "retentionReferences", "bytesAvoided"]) assert.ok(publisher.includes(marker));
const restoreBundle = read("scripts/model-cache/production-restore-bundle.ts");
for (const marker of ["minimumFreeDiskBytes", "objectPathMapping", "parallelDownloads", "readPublishedProductionManifest", "sharedObjectKeys"]) assert.ok(restoreBundle.includes(marker));
const studio = read("src/components/LocalCreationStudio.tsx");
for (const label of ["Image UltraReal Flux FP8", "Video Wan 2.2 Remix 14B FP8", "自动选择", "RTX 4090", "RTX 5090", "发布未完成"]) assert.ok(studio.includes(label));

console.log(JSON.stringify({ ok: true, cacheDag: "two_parallel_families_then_final_readonly_verify", publishOrder: "objects_manifest_current", noArtifacts: true }));
