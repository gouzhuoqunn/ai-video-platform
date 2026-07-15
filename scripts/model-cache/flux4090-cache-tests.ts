import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  assertFreeDisk,
  buildFirstImageRestorePlan,
  buildFluxCacheManifest,
  fluxCacheFiles,
  type FluxCacheFile,
  verifyLocalModelFile,
} from "./flux4090-cache";

const root = process.cwd();
const workflowSource = readFileSync(path.join(root, ".github", "workflows", "flux4090-model-cache.yml"), "utf8");
const runtimeWorkflowSource = readFileSync(path.join(root, ".github", "workflows", "comfy-runtime-image.yml"), "utf8");
const workflow = parse(workflowSource) as { jobs: Record<string, { needs?: string[]; [key: string]: unknown }> };

function assertRunnerTempContextPlacement(candidate: { jobs: Record<string, unknown> }) {
  const visit = (value: unknown, pathParts: Array<string | number>) => {
    if (typeof value === "string" && /\$\{\{\s*runner\.temp\b/.test(value)) {
      const stepsIndex = pathParts.indexOf("steps");
      if (stepsIndex < 0 || typeof pathParts[stepsIndex + 1] !== "number") {
        throw new Error(`runner.temp is not available at job level: ${pathParts.join(".")}`);
      }
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...pathParts, index]));
    else if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => visit(item, [...pathParts, key]));
    }
  };
  visit(candidate.jobs, ["jobs"]);
}

assert.throws(
  () => assertRunnerTempContextPlacement({ jobs: { invalid: { env: { HF_HOME: "${{ runner.temp }}/hf" }, steps: [] } } }),
  /runner\.temp is not available at job level/,
);
assert.doesNotThrow(() =>
  assertRunnerTempContextPlacement({ jobs: { valid: { steps: [{ env: { HF_HOME: "${{ runner.temp }}/hf" }, run: "true" }] } } }),
);
assert.doesNotThrow(() =>
  assertRunnerTempContextPlacement({ jobs: { valid: { steps: [{ run: 'echo "HF_HOME=$RUNNER_TEMP/hf" >> "$GITHUB_ENV"' }] } } }),
);
assertRunnerTempContextPlacement(workflow);
const jobs = workflow.jobs;
assert.deepEqual(Object.keys(jobs).sort(), ["cache-qwen", "cache-vae", "publish-and-verify", "verify-existing-flux"]);
assert.equal(jobs["verify-existing-flux"]["timeout-minutes"], 10);
assert.equal(jobs["cache-qwen"]["timeout-minutes"], 55);
assert.equal(jobs["cache-vae"]["timeout-minutes"], 25);
assert.equal(jobs["publish-and-verify"]["timeout-minutes"], 15);
assert.equal(jobs["verify-existing-flux"].needs, undefined);
assert.equal(jobs["cache-qwen"].needs, undefined);
assert.equal(jobs["cache-vae"].needs, undefined);
assert.deepEqual(jobs["publish-and-verify"].needs, ["verify-existing-flux", "cache-qwen", "cache-vae"]);
assert.match(String(jobs["publish-and-verify"].if), /flux_verified[\s\S]*qwen_verified[\s\S]*vae_verified/);
assert.match(workflowSource, /huggingface_hub\[hf_xet\]/);
assert.match(workflowSource, /HF_HOME/);
assert.match(workflowSource, /HF_HOME=\$RUNNER_TEMP\/hf-qwen/);
assert.match(workflowSource, /HF_HOME=\$RUNNER_TEMP\/hf-vae/);
assert.doesNotMatch(workflowSource, /\$\{\{\s*runner\.temp\b/);
assert.match(workflowSource, /30m python scripts\/model-cache\/hf_download_model\.py --model qwen[\s\S]*--max-minutes 30/);
assert.match(workflowSource, /8m npm run model-cache:validate-local:flux4090/);
assert.match(workflowSource, /20m npm run model-cache:upload-local:flux4090/);
assert.match(workflowSource, /Require 11 GiB free disk/);
assert.match(workflowSource, /docker system prune --all --force/);
assert.doesNotMatch(workflowSource, /HF_HUB_ENABLE_HF_TRANSFER/);
assert.doesNotMatch(workflowSource, /upload-artifact|actions\/cache|model-cache:seed:flux4090|build-push-action|packages:\s*write/);
assert.match(runtimeWorkflowSource, /contains\(github\.event\.head_commit\.message, '\[runtime-hygiene\]'\)/);

const cacheSource = readFileSync(path.join(root, "scripts", "model-cache", "flux4090-cache.ts"), "utf8");
assert.match(cacheSource, /from "@aws-sdk\/lib-storage"/);
assert.match(cacheSource, /partSize: UPLOAD_PART_BYTES/);
assert.match(cacheSource, /queueSize: UPLOAD_QUEUE_SIZE/);
assert.match(cacheSource, /leavePartsOnError: true/);
assert.match(cacheSource, /maxAttempts: 4/);
assert.match(cacheSource, /AbortMultipartUploadCommand/);
assert.match(cacheSource, /listed_parts: count/);
assert.match(cacheSource, /readonly-put-/);
assert.match(cacheSource, /readonly-delete-/);
assert.match(cacheSource, /overwrite current\.json/);
assert.doesNotMatch(cacheSource, /fetchSourcePart|huggingface\.co.*Range/);
assert.ok(cacheSource.indexOf("fluxCacheManifestKey, manifest") < cacheSource.indexOf("fluxCacheCurrentKey, current"));

assert.equal(fluxCacheFiles.length, 3);
const manifest = buildFluxCacheManifest();
assert.equal(manifest.files.length, 3);
assert.ok(manifest.files.every((file) => file.key.includes(`/revisions/${manifest.revision}/files/`)));
assert.ok(manifest.files.every((file) => !file.key.includes("/staging/")));
assert.equal(buildFirstImageRestorePlan(manifest).total_size_bytes, 12_451_817_860);

assert.equal(assertFreeDisk(root, 11, 12 * 1024 ** 3).disk_gate_passed, true);
assert.throws(() => assertFreeDisk(root, 11, 10 * 1024 ** 3), /runner_disk_gate_failed/);

async function runFileChecks() {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "flux-cache-test-"));
  try {
    const fixture = path.join(temporary, "fixture.bin");
    writeFileSync(fixture, "abc");
    const fake = {
      ...fluxCacheFiles[0],
      filename: "fixture.bin",
      size: 3,
      sha256: createHash("sha256").update("abc").digest("hex"),
    } as unknown as FluxCacheFile;
    assert.equal((await verifyLocalModelFile(fixture, fake)).size, 3);
    const wrong = { ...fake, sha256: "0".repeat(64) } as FluxCacheFile;
    await assert.rejects(() => verifyLocalModelFile(fixture, wrong), /sha256 mismatch/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

void runFileChecks().then(() => {
  console.log("FLUX parallel DAG, disk gate, SHA rejection, SDK upload, atomic publish, and readonly recovery tests passed.");
});
