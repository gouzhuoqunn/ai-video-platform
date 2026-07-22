import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { COMFY_RUNTIME_IMAGE, PROJECT_TAG } from "./clore/config";
import type { CloreConfig } from "./clore/types";
import { runImage4090Batch, writeJson, type ImageRunnerSession, type ImageTask, type RunnerDeps } from "./image-4090-runner";

function readJson<T>(file: string) {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function chdirTemp() {
  const previous = process.cwd();
  const dir = mkdtempSync(path.join(os.tmpdir(), "image-http-readiness-"));
  process.chdir(dir);
  return () => {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
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

function candidateRaw() {
  return {
    id: 79245,
    gpu_name: "NVIDIA GeForce RTX 4090",
    gpu_memory_gb: 24,
    ram_gb: 64,
    cpu_cores: 16,
    disk_gb: 990,
    download_mbps: 450,
    upload_mbps: 200,
    price_usd_per_hour: 0.17,
    rentable: true,
    type: "on-demand",
    rating: 4.7,
    rating_count: 18,
    reliability: 0.99,
    supports_docker: true,
  };
}

function task(): ImageTask {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    prompt: "fixture prompt",
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

function seed() {
  process.env.IMAGE_4090_EXECUTOR_READY = "true";
  writeJson(path.join(".secrets", "image-studio", "tasks.json"), [task()]);
  writeJson(path.join(".secrets", "image-studio", "runner-session.json"), {
    state: "running",
    stage: "searching_gpu",
    frozenTaskIds: [task().id],
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
    pid: null,
    logPath: null,
  } satisfies ImageRunnerSession);
  writeJson(path.join(".secrets", "image-studio", "fluxed-up-10.2-rtx4090-text.restore.json"), {
    schema: 1,
    family: "fluxed-up-10.2-rtx4090-text",
    mode: "text_generation",
    files: [{ id: "tiny", filename: "tiny.bin", size_bytes: 1, sha256: "00".repeat(32), runtime_path: "diffusion_models/tiny.bin", cache_object_key: "fluxed-up-10.2/tiny.bin", download_url: "https://cache.invalid/tiny.bin" }],
  });
}

function depsFor(input: { controllerUrlAfter?: number; healthOkAfter?: number; cancelFails?: boolean; onFirstOrderPoll?: (session: ImageRunnerSession) => void; onSleep?: (session: ImageRunnerSession) => void; onRestore?: (session: ImageRunnerSession) => void }) {
  let created = false;
  let cancelled = false;
  let orderPolls = 0;
  let healthPolls = 0;
  let cancelCount = 0;
  const pngPromise = sharp({ create: { width: 768, height: 768, channels: 3, background: "#123456" } }).png().toBuffer();
  const session = () => readJson<ImageRunnerSession>(path.join(".secrets", "image-studio", "runner-session.json"));
  const rawOrder = () => ({
    id: "1972821",
    si: "79245",
    status: "running",
    mon_container: orderPolls > 1 ? 2 : 0,
    tcp_ports: ["8080:24123"],
    web: input.controllerUrlAfter !== undefined && orderPolls >= input.controllerUrlAfter ? "https://runtime.invalid/secret?token=redacted" : undefined,
  });
  const deps: RunnerDeps = {
    loadConfig: config,
    loadExecution: () => ({ enabled: true, firstSessionMaxBudgetUsd: 4.5, balanceReserveUsd: 0, maxGpuPricePerHour: 0.6, hardSessionLimitMinutes: 40, orderStartTimeoutMinutes: 15, workerReadyTimeoutMinutes: 15, firstGpuSession: true, deploymentHold: false }),
    readMarketplace: async () => [candidateRaw()],
    readOrders: async () => (created && !cancelled ? [{ orderId: "1972821", serverId: "79245", status: "running", currency: "USD", price: 0.17, fee: null, creationFee: null, spend: null, createdTimestamp: null, expired: false, active: true, controllerUrl: rawOrder().web ?? null }] : []),
    createOrder: async () => {
      created = true;
      return { order_created: true, order_id: "1972821", create_order_called: true, status: "order_pending", create_response_status: "created" };
    },
    cancelOrder: async () => {
      cancelCount += 1;
      if (input.cancelFails) throw new Error("cancel_failed_fixture");
      cancelled = true;
      return { order_cancelled: true, order_id: "1972821", cancel_called: true, status: "cancelled" };
    },
    cloreRequest: async () => {
      orderPolls += 1;
      if (orderPolls === 1) input.onFirstOrderPoll?.(session());
      return { orders: [rawOrder()] };
    },
    fetchHealth: async () => {
      healthPolls += 1;
      const ok = input.healthOkAfter !== undefined && healthPolls >= input.healthOkAfter;
      return { ok, status: ok ? 200 : 503, error: ok ? null : "health_not_ready_fixture" };
    },
    fetchJson: async (url) => {
      if (url.endsWith("/restore")) {
        input.onRestore?.(session());
        return { restore_complete: true };
      }
      if (url.endsWith("/image/generate")) return { job_id: "job-1" };
      if (url.includes("/jobs/")) return { status: "completed" };
      return {};
    },
    fetchBinary: async () => await pngPromise,
    sleep: async () => input.onSleep?.(session()),
  };
  return { deps, cancelCount: () => cancelCount };
}

async function withSeeded<T>(fn: () => Promise<T>) {
  const cleanup = chdirTemp();
  try {
    seed();
    return await fn();
  } finally {
    cleanup();
  }
}

async function main() {
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
  await withSeeded(async () => {
    let immediate: ImageRunnerSession | null = null;
    const harness = depsFor({ controllerUrlAfter: 1, healthOkAfter: 1, onFirstOrderPoll: (session) => { immediate = session; } });
    await runImage4090Batch(harness.deps);
    assert.equal(immediate?.stage, "order_created_waiting_http", "order ID immediately advances session stage");
    assert.equal(immediate?.host?.orderId, "1972821", "order ID immediately persists");
  });

  await withSeeded(async () => {
    let waiting: ImageRunnerSession | null = null;
    const harness = depsFor({ onSleep: (session) => { waiting ??= session; } });
    await assert.rejects(() => runImage4090Batch(harness.deps), /12 分钟内未就绪/);
    assert.equal(waiting?.stage, "waiting_http_endpoint", "missing HTTP URL updates waiting state");
    assert.equal(harness.cancelCount(), 1, "12-minute timeout fixture cancels order");
  });

  await withSeeded(async () => {
    let health: ImageRunnerSession | null = null;
    const harness = depsFor({ controllerUrlAfter: 1, onSleep: (session) => { health ??= session; } });
    await assert.rejects(() => runImage4090Batch(harness.deps), /12 分钟内未就绪/);
    assert.equal(health?.stage, "checking_http_health", "health polling enters checking state");
    assert.ok(health?.host?.lastPollAt, "health polling updates timestamps");
    assert.equal(health?.host?.lastHealthStatus, 503, "health polling persists status code");
  });

await withSeeded(async () => {
  let ready: ImageRunnerSession | null = null;
  const harness = depsFor({ controllerUrlAfter: 1, healthOkAfter: 1, onSleep: (session) => { if (session.stage === "runtime_ready") ready = session; } });
  await runImage4090Batch(harness.deps);
  assert.equal(ready?.stage, "runtime_ready", "successful /healthz fixture reaches runtime_ready");
});

  const studio = readFileSync(path.join(process.cwd(), "src", "components", "ImageCreationStudio.tsx"), "utf8");
  for (const token of ["order_created_waiting_deployment", "waiting_http_endpoint", "checking_http_health", "runtime_ready", "lastHealthError", "readinessElapsedSeconds"]) {
    assert.match(studio, new RegExp(token), `UI renders ${token} without nullable crashes`);
  }
  } finally {
    console.info = originalInfo;
  }

  console.log("image HTTP readiness focused tests: ok");
}

void main();
