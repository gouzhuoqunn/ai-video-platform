import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { classifyImageGpu } from "../src/lib/image-generation/flux-stack";
import { buildHttpRuntimeCreateOrderBody, assertCreateOrderBodySafe } from "./clore/order-execution";
import { COMFY_RUNTIME_IMAGE, PROJECT_TAG } from "./clore/config";
import { validateImageSourceManifest, resolveImageRestoreManifest } from "./image-executor/bootstrap";
import { buildValidatedRestoreManifestFromFiles, validateValidatedRestoreManifest, type SourceAcquisitionManifest } from "./image-executor/manifests";
import { persistImageResult } from "./image-executor/result-persistence";
import { runImage4090Batch, writeJson, type ImageRunnerSession, type ImageTask, type RunnerDeps } from "./image-4090-runner";
import type { CloreCandidate, CloreConfig } from "./clore/types";

function readJson<T>(file: string) {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function chdirTemp() {
  const previous = process.cwd();
  const dir = mkdtempSync(path.join(os.tmpdir(), "image-executor-focused-"));
  process.chdir(dir);
  return () => {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  };
}

function candidate(): CloreCandidate {
  const raw = {
    id: 99515,
    gpu_name: "NVIDIA GeForce RTX 4090",
    gpu_memory_gb: 24,
    ram_gb: 31.77,
    cpu_cores: 16,
    disk_gb: 250,
    download_mbps: 500,
    upload_mbps: 200,
    price_usd_per_hour: 0.5,
    rentable: true,
    type: "on-demand",
    rating: 4.6,
    rating_count: 20,
    reliability: 0.99,
    supports_docker: true,
  };
  return {
    serverId: "99515",
    gpu: "RTX 4090",
    gpuNormalizedName: "NVIDIA GeForce RTX 4090",
    gpuCount: 1,
    gpuMemoryGb: 24,
    gpuMemoryMiB: 24564,
    gpuMemoryRawValue: 24,
    gpuMemoryRawUnit: "GB",
    gpuMemorySource: "fixture",
    gpuMemoryAccepted: true,
    gpuMemoryNote: "fixture",
    ramGb: 31.77,
    cpuCores: 16,
    diskGb: 250,
    downloadMbps: 500,
    uploadMbps: 200,
    diskSpeedMbps: 1500,
    reliability: 0.99,
    rating: 4.6,
    ratingCount: 20,
    country: "US",
    minRentalHours: null,
    maxRentalHours: null,
    priceUsdPerHour: 0.5,
    priceSource: "fixture",
    priceOriginalAmount: 0.5,
    priceOriginalCurrency: "USD",
    priceOriginalUnit: "hour",
    priceOriginalLabel: "0.5 USD/hour",
    allowedCurrencies: ["USD-Blockchain"],
    sixHourCostUsd: 3.25,
    effectivePriceUsdPerHour: 0.525,
    projectedSessionHours: 1,
    projectedSessionCostUsd: 0.625,
    creationFeeUsd: 0.1,
    renterFeeRate: 0.05,
    balanceMarginUsd: 1,
    balanceSufficientForSixHours: true,
    platformTotalPrice: null,
    rentable: true,
    orderType: "on-demand",
    supportsDocker: true,
    supportsSsh: false,
    driverCompatible: true,
    hostOnline: true,
    missingFields: [],
    rejectionReasons: [],
    riskTier: "A",
    riskNotes: [],
    raw,
  };
}

function config(): CloreConfig {
  return {
    apiBaseUrl: "https://clore.invalid",
    apiKey: "test",
    apiKeySource: "test",
    targetGpu: "NVIDIA GeForce RTX 4090",
    minGpuVramGb: 23,
    maxGpuPricePerHour: 0.6,
    minReliability: 0,
    minRating: 4.5,
    minRatingCount: 0,
    minRamGb: 31,
    minCpuCores: 1,
    minDiskGb: 200,
    minDownloadMbps: 1,
    minUploadMbps: 1,
    allowedCountries: [],
    rentalCurrency: "USD-Blockchain",
    dockerImage: COMFY_RUNTIME_IMAGE,
    orderType: "on-demand",
    projectTag: PROJECT_TAG,
    assumedMinimumRentalHours: 1,
    excludedServerIds: [],
  };
}

function fixtureTask(): ImageTask {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    prompt: "one fixture image",
    referenceImage: null,
    mode: "text_generation",
    gpuClass: "rtx4090",
    width: 768,
    height: 768,
    steps: 30,
    cfg: 4,
    loraStrength: 0.8,
    sampler: "Euler",
    seed: 123,
    status: "waiting_for_gpu",
    updatedAt: new Date().toISOString(),
  };
}

function fixtureSession(): ImageRunnerSession {
  return {
    state: "running",
    stage: "正在寻找显卡",
    frozenTaskIds: [fixtureTask().id],
    gpuClass: "rtx4090",
    maxHourlyPrice: 0.6,
    currentTaskIndex: null,
    currentModel: null,
    promptSummary: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    host: null,
    error: null,
    blocker: null,
  };
}

async function seedRunnerState() {
  writeJson(path.join(".secrets", "image-studio", "tasks.json"), [fixtureTask()]);
  writeJson(path.join(".secrets", "image-studio", "runner-session.json"), fixtureSession());
  writeJson(path.join(".secrets", "image-studio", "fluxed-up-10.2-rtx4090-text.restore.json"), {
    schema: 1,
    family: "fluxed-up-10.2-rtx4090-text",
    mode: "text_generation",
    parallelism: 2,
    files: [{ id: "tiny", filename: "tiny.bin", size_bytes: 1, sha256: "00".repeat(32), runtime_path: "diffusion_models/tiny.bin", cache_object_key: "fluxed-up-10.2/tiny.bin", download_url: "https://cache.invalid/tiny.bin" }],
  });
}

function depsFor(input: { healthFails?: boolean; restoreFails?: boolean; generateFails?: boolean; resultPng?: Buffer }) {
  let cancelCount = 0;
  let created = false;
  const deps: RunnerDeps = {
    loadConfig: config,
    loadExecution: () => ({
      enabled: true,
      firstSessionMaxBudgetUsd: 4.5,
      balanceReserveUsd: 0,
      maxGpuPricePerHour: 0.6,
      hardSessionLimitMinutes: 40,
      orderStartTimeoutMinutes: 15,
      workerReadyTimeoutMinutes: 15,
      firstGpuSession: true,
      deploymentHold: false,
    }),
    readMarketplace: async () => [candidate().raw],
    readOrders: async () => (created && !cancelCount ? [{ orderId: "2001", serverId: "99515", status: "running", currency: "USD", price: 0.5, fee: null, creationFee: null, spend: null, createdTimestamp: null, expired: false, active: true, controllerUrl: "https://runtime.invalid" }] : []),
    createOrder: async () => {
      created = true;
      return { order_created: true, order_id: "2001", create_order_called: true, status: "order_pending", create_response_status: "created" };
    },
    cancelOrder: async () => {
      cancelCount += 1;
      return { order_cancelled: true, order_id: "2001", cancel_called: true, status: "cancelled" };
    },
    cloreRequest: async () => ({ orders: [{ id: "2001", si: "99515", status: "running", web: "https://runtime.invalid" }] }),
    fetchJson: async (url) => {
      if (url.endsWith("/healthz")) {
        if (input.healthFails) throw new Error("health_timeout_fixture");
        return { ok: true };
      }
      if (url.endsWith("/restore")) {
        if (input.restoreFails) throw new Error("restore_failed_fixture");
        return { restore_complete: true };
      }
      if (url.endsWith("/image/generate")) {
        if (input.generateFails) throw new Error("generate_failed_fixture");
        return { job_id: "job-1" };
      }
      if (url.includes("/jobs/")) return { status: "completed" };
      return {};
    },
    fetchBinary: async () => input.resultPng ?? Buffer.from("not-png"),
    sleep: async () => undefined,
  };
  return { deps, cancelCount: () => cancelCount };
}

async function assertCancellationOn(kind: "health" | "restore" | "generation") {
  const cleanup = chdirTemp();
  try {
    await seedRunnerState();
    const png = await sharp({ create: { width: 768, height: 768, channels: 3, background: "#223344" } }).png().toBuffer();
    const harness = depsFor({ healthFails: kind === "health", restoreFails: kind === "restore", generateFails: kind === "generation", resultPng: png });
    await assert.rejects(() => runImage4090Batch(harness.deps), kind === "health" ? /health_timeout_fixture|15 分钟/ : kind === "restore" ? /restore_failed_fixture/ : /generate_failed_fixture/);
    assert.equal(harness.cancelCount(), 1, `${kind} failure should attempt cancellation exactly once`);
    const session = readJson<ImageRunnerSession>(path.join(".secrets", "image-studio", "runner-session.json"));
    assert.equal(session.state, "failed");
  } finally {
    cleanup();
  }
}

async function main() {
  const body = buildHttpRuntimeCreateOrderBody({ serverId: "99515", currency: "USD-Blockchain", requiredPrice: 0.6 });
  assert.equal(body.env?.COMFY_NODE_PROFILE, "image-flux");
  assert.doesNotThrow(() => assertCreateOrderBodySafe(body));
  assert.throws(() => assertCreateOrderBodySafe({ ...body, env: { ...body.env, COMFY_NODE_PROFILE: "production_minimal" } }), /image-flux/);
  assert.doesNotMatch(JSON.stringify({ mode: body.env?.COMFY_RUNTIME_MODE, profile: body.env?.COMFY_NODE_PROFILE }), /production_minimal|Wan|LTX|video/i);

  const source = validateImageSourceManifest(readJson<unknown>(path.join("comfy-runtime", "image-source-artifacts.json")));
  assert.equal(source.artifacts.length, 6);
  assert.ok(source.artifacts.some((artifact) => artifact.id === "flux-tokenizer-config" && artifact.metadata_only));

  const cleanup = chdirTemp();
  try {
    const acquisition: SourceAcquisitionManifest = {
      schema: 1,
      family: "fluxed-up-10.2-rtx4090-text",
      mode: "text_generation",
      artifacts: [
        { id: "fluxed-up-10.2", source: "civitai", model_id: 1, version_id: 1, file_id: 1, filename: "a.bin", runtime_path: "diffusion_models/a.bin", r2_prefix: "fluxed-up-10.2", auth: "civitai_token" },
        { id: "aidma-lora", source: "civitai", model_id: 1, version_id: 1, file_id: 1, filename: "b.bin", runtime_path: "loras/b.bin", r2_prefix: "aidma-lora", auth: "civitai_token" },
        { id: "flux-vae", source: "huggingface", repository: "r", revision: "rev", filename: "c.bin", runtime_path: "vae/c.bin", r2_prefix: "shared-flux-components", auth: "public" },
        { id: "flux-clip-l", source: "huggingface", repository: "r", revision: "rev", filename: "d.bin", runtime_path: "text_encoders/d.bin", r2_prefix: "shared-flux-components", auth: "public" },
        { id: "flux-t5xxl-fp8", source: "huggingface", repository: "r", revision: "rev", filename: "e.bin", runtime_path: "text_encoders/e.bin", r2_prefix: "shared-flux-components", auth: "public" },
        { id: "flux-tokenizer-config", source: "huggingface", repository: "r", revision: "rev", filename: "config.json", runtime_path: "tokenizers/t5/config.json", r2_prefix: "shared-flux-components", auth: "huggingface_token", metadata_only: true },
      ],
    };
    writeJson("source.json", acquisition);
    const seen: string[] = [];
    const resolved = await resolveImageRestoreManifest({
      restoreManifestPath: "restore.json",
      sourceManifestPath: "source.json",
      workspaceDir: "downloaded",
      deps: {
        downloadArtifact: async (artifact, destination) => {
          const content = Buffer.from(`fixture:${artifact.id}`);
          writeFileSync(destination, content);
          seen.push(artifact.id);
        },
        uploadCache: async (manifest) => {
          validateValidatedRestoreManifest(manifest);
        },
        publishCurrentRestoreManifest: async (manifest) => {
          validateValidatedRestoreManifest(manifest);
        },
      },
    });
    assert.deepEqual(seen.sort(), ["aidma-lora", "flux-clip-l", "flux-t5xxl-fp8", "flux-vae", "fluxed-up-10.2"].sort());
    assert.equal(resolved.files.length, 5);
    assert.throws(() => validateValidatedRestoreManifest({ ...resolved, files: [{ ...resolved.files[0], sha256: undefined }] }), /invalid_restore_sha/);

    const direct = buildValidatedRestoreManifestFromFiles({ source: acquisition, downloadedRoot: "downloaded" });
    assert.match(direct.files[0].sha256, /^[a-f0-9]{64}$/);
  } finally {
    cleanup();
  }

  await assertCancellationOn("health");
  await assertCancellationOn("restore");
  await assertCancellationOn("generation");

  const pngCleanup = chdirTemp();
  try {
    const png = await sharp({ create: { width: 768, height: 1024, channels: 3, background: "#445566" } }).png().toBuffer();
    const result = await persistImageResult({ taskId: "22222222-2222-4222-8222-222222222222", expectedWidth: 768, expectedHeight: 1024, png, resultsDir: "results" });
    assert.equal(result.width, 768);
    assert.equal(result.height, 1024);
    assert.equal(result.sha256, createHash("sha256").update(png).digest("hex"));
    assert.notEqual(readFileSync(result.thumbnailPath).length, png.length);
    await assert.rejects(() => persistImageResult({ taskId: "33333333-3333-4333-8333-333333333333", expectedWidth: 1024, expectedHeight: 1024, png, resultsDir: "results" }), /png_dimension_mismatch/);
  } finally {
    pngCleanup();
  }

  assert.equal(classifyImageGpu(1280, 1280), "rtx4090");
  assert.equal(classifyImageGpu(1280, 1536), "rtx5090");

  const route = readFileSync("src/app/api/local-lab/image-tasks/route.ts", "utf8");
  const studio = readFileSync("src/components/ImageCreationStudio.tsx", "utf8");
  assert.match(route, /frozenTaskIds: batch\.map/);
  assert.match(route, /writeJson\(PREFERENCES_PATH, \{ maxHourlyPrice \}\)/);
  assert.match(route, /executionReady: blocker === null/);
  assert.match(studio, /task\.result/);

  const workflow = readFileSync("comfy-runtime/image_workflow.py", "utf8");
  for (const node of ["UNETLoader", "DualCLIPLoader", "LoraLoader", "FluxGuidance", "KSampler", "VAELoader", "SaveImage"]) {
    assert.match(workflow, new RegExp(node));
  }
  const controller = readFileSync("comfy-runtime/controller.py", "utf8");
  for (const endpoint of ["/healthz", "/restore", "/image/generate", "/jobs/", "/results/", "/free", "/shutdown"]) {
    assert.match(controller, new RegExp(endpoint.replace("/", "\\/")));
  }

  console.log("image executor focused tests: ok");
}

void main();
