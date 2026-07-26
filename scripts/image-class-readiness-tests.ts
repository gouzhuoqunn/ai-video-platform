import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyImageGpu } from "../src/lib/image-generation/flux-stack";
import { imageRuntimeForGpuClass } from "./clore/config";
import { imageExecutorReadinessForGpuClass, RTX5090_RUNTIME_UNPUBLISHED_BLOCKER } from "./image-executor/readiness";

const previousReady = process.env.IMAGE_4090_EXECUTOR_READY;
const root = mkdtempSync(path.join(os.tmpdir(), "image-class-readiness-"));
try {
  const restorePath = path.join(root, "restore.json");
  const sourcePath = path.join(root, "source.json");
  mkdirSync(root, { recursive: true });
  writeFileSync(sourcePath, JSON.stringify({ schema: 1, family: "fluxed-up-10.2-rtx4090-text", mode: "text_generation", artifacts: [] }), "utf8");
  writeFileSync(restorePath, JSON.stringify({ schema: 1, family: "fluxed-up-10.2-rtx4090-text", mode: "text_generation", files: [{ id: "fixture", filename: "fixture.bin", size_bytes: 1, sha256: "a".repeat(64), runtime_path: "diffusion_models/fixture.bin", cache_object_key: "fixture", download_url: "https://cache.invalid/fixture" }] }), "utf8");
  process.env.IMAGE_4090_EXECUTOR_READY = "true";

  assert.equal(classifyImageGpu(768, 768), "rtx4090");
  assert.equal(classifyImageGpu(1280, 1280), "rtx4090");
  assert.equal(imageExecutorReadinessForGpuClass("rtx4090", { restoreManifestPath: restorePath, sourceManifestPath: sourcePath }).ready, true);
  assert.equal(classifyImageGpu(1536, 1536), "rtx5090");
  const rtx5090 = imageExecutorReadinessForGpuClass("rtx5090", { restoreManifestPath: restorePath, sourceManifestPath: sourcePath });
  assert.equal(rtx5090.ready, false);
  assert.equal(rtx5090.blocker, RTX5090_RUNTIME_UNPUBLISHED_BLOCKER);
  assert.equal(imageRuntimeForGpuClass("rtx5090"), null);
  assert.equal(classifyImageGpu(1536, 1536) === "rtx4090", false);
  console.log(JSON.stringify({ ok: true, rtx4090_768_start_eligible: true, rtx4090_1280_start_eligible: true, rtx5090_1536_blocked_until_runtime_published: true, providerMutationCount: 0 }));
} finally {
  if (previousReady === undefined) delete process.env.IMAGE_4090_EXECUTOR_READY;
  else process.env.IMAGE_4090_EXECUTOR_READY = previousReady;
  rmSync(root, { recursive: true, force: true });
}
