import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CloreRequestOptions } from "./clore/client";
import type { CloreExecutionConfig } from "./clore/execution-config";
import type { CloreConfig, RawCloreServer } from "./clore/types";
import type { ImageRunnerSession, RunnerDeps } from "./image-4090-runner";

let client: typeof import("./clore/client");
let orderState: typeof import("./clore/order-state");
let runner: typeof import("./image-4090-runner");
let marketplace: typeof import("./clore/marketplace");

type CreateOrderInput = Parameters<typeof import("./image-4090-runner").createOrderWithNetworkRetry>[0];
type OrderSummary = Awaited<ReturnType<RunnerDeps["readOrders"]>>[number];
const config: CloreConfig = {
  apiKey: "fake",
  apiBaseUrl: "https://clore.invalid",
  targetGpu: "NVIDIA GeForce RTX 4090",
  minGpuVramGb: 24,
  maxGpuPricePerHour: .3,
  minReliability: .9,
  minRating: 4,
  minRatingCount: 1,
  minRamGb: 31,
  minCpuCores: 8,
  minDiskGb: 200,
  minDownloadMbps: 100,
  minUploadMbps: 100,
  allowedCountries: [],
  rentalCurrency: "USD-Blockchain",
  dockerImage: "ghcr.io/example/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  orderType: "on-demand",
  projectTag: "ai-video-platform-wan22",
  assumedMinimumRentalHours: 1,
  excludedServerIds: [],
};
const execution: CloreExecutionConfig = {
  enabled: true,
  firstSessionMaxBudgetUsd: 4.5,
  balanceReserveUsd: 1,
  maxGpuPricePerHour: .3,
  hardSessionLimitMinutes: 380,
  orderStartTimeoutMinutes: 15,
  workerReadyTimeoutMinutes: 120,
  firstGpuSession: true,
  deploymentHold: false,
};
let candidate: CreateOrderInput["candidate"];
const body: CreateOrderInput["requestBody"] = {
  currency: "USD-Blockchain",
  image: config.dockerImage,
  renting_server: 98682,
  type: "on-demand",
  required_price: 5.24,
  ports: { "8080": "http" },
  env: { COMFY_RUNTIME_MODE: "gpu", COMFY_GPU_PROFILE: "rtx4090", COMFY_NODE_PROFILE: "image-flux", START_GPU_WORKER: "false" },
};

function session(): ImageRunnerSession {
  return { state: "running", stage: "creating_order", frozenTaskIds: ["task-1"], gpuClass: "rtx4090", maxHourlyPrice: .3, currentTaskIndex: null, currentModel: null, promptSummary: null, startedAt: "2026-07-26T16:28:00.000Z", updatedAt: "2026-07-26T16:28:00.000Z", host: { serverId: "98682" }, error: null, blocker: null, pid: 123, logPath: null, createAttempt: { id: "attempt-1", startedAt: "2026-07-26T16:28:00.000Z", phase: "creating_order", requestAttempts: 0 } };
}

function active(orderId: string): OrderSummary[] {
  return [{ orderId, serverId: "98682", status: "deploying", currency: "USD-Blockchain", price: 5.24, fee: null, creationFee: null, spend: null, createdTimestamp: 1, expired: false, active: true, startedAt: null, deploymentState: "deploying", controllerUrl: null }];
}

async function runScenario(kind: "retry" | "matched_rate" | "matched_reset" | "none" | "ambiguous") {
  let retryHooks = 0;
  let createCalls = 0;
  const deps: RunnerDeps = {
    loadConfig: () => config,
    loadExecution: () => execution,
    readMarketplace: async () => [],
    readOrders: async () => kind === "matched_rate" || kind === "matched_reset" ? active("1983007") : kind === "ambiguous" ? [...active("1983007"), { ...active("1983008")[0], serverId: "other" }] : [],
    createOrder: async (input) => {
      const result = await input.request(input.requestBody);
      const resultRecord = result !== null && typeof result === "object" ? result as Record<string, unknown> : {};
      const id = String(resultRecord.id);
      orderState.writeActiveOrder({ order_id: id, server_id: "98682", project_tag: "ai-video-platform-wan22", created_at: new Date().toISOString(), status: "order_pending", usd_per_hour: .2183333333, max_price_usd_per_hour: .3, order_type: "on-demand", open_ports: ["controller/http:8080"], gpu_profile: "rtx4090", bootstrap_image: body.image, create_attempt_id: "attempt-1" });
      return { order_id: id, order_created: true, create_order_called: true, status: "order_pending", create_response_status: "created" };
    },
    cancelOrder: async () => { throw new Error("unexpected_cancel_order"); },
    fetchJson: async () => ({}),
    fetchBinary: async () => Buffer.alloc(0),
    cloreRequest: async <T>(_config: CloreConfig, endpoint: string, _init: RequestInit, options: CloreRequestOptions = {}): Promise<T> => {
      assert.equal(endpoint, "/create_order");
      createCalls += 1;
      retryHooks += 1;
      const found = await options.onCreateRetry?.({ reason: kind === "matched_reset" ? "network_error" : "rate_limited", attempt: retryHooks, httpStatus: kind === "matched_reset" ? null : 429, code: kind === "matched_reset" ? null : 5 });
      const during = JSON.parse(readFileSync(path.join(".secrets", "image-studio", "runner-session.json"), "utf8")) as ImageRunnerSession;
      assert.equal(during.state, "running");
      assert.notEqual(during.stage, "create_order_failed");
      if (found) throw new client.CloreCreateRetryReconciledError();
      if (kind === "none" || kind === "ambiguous") throw new client.CloreRateLimitError({ httpStatus: 429, code: 5, message: "rate", retryAfterMs: null, attempt: retryHooks });
      createCalls += 1;
      return { id: "1983007", status: "created" } as unknown as T;
    },
    sleep: async () => undefined,
  };
  const before = createHash("sha256").update(readFileSync(path.join(".secrets", "image-studio", "tasks.json"))).digest("hex");
  if (kind === "none") {
    await assert.rejects(() => runner.createOrderWithNetworkRetry({ deps, config, execution, candidate, requestBody: body, selectedServerId: "98682", gpuClass: "rtx4090" }), /Clore/);
    const after = JSON.parse(readFileSync(path.join(".secrets", "image-studio", "runner-session.json"), "utf8")) as ImageRunnerSession;
    assert.equal(after.stage, "create_order_failed");
    assert.equal(orderState.readActiveOrder(), null);
  } else if (kind === "ambiguous") {
    await assert.rejects(() => runner.createOrderWithNetworkRetry({ deps, config, execution, candidate, requestBody: body, selectedServerId: "98682", gpuClass: "rtx4090" }), /ambiguous/);
    assert.equal(orderState.readActiveOrder(), null);
  } else {
    const orderId = await runner.createOrderWithNetworkRetry({ deps, config, execution, candidate, requestBody: body, selectedServerId: "98682", gpuClass: "rtx4090" });
    assert.equal(orderId, "1983007");
    assert.equal(orderState.readActiveOrder()?.order_id, "1983007");
    assert.equal(orderState.readActiveOrder()?.create_attempt_id, "attempt-1");
    const persisted = JSON.parse(readFileSync(path.join(".secrets", "image-studio", "runner-session.json"), "utf8")) as ImageRunnerSession;
    assert.equal(persisted.createAttempt?.phase, "order_created_waiting_deployment");
  }
  const afterHash = createHash("sha256").update(readFileSync(path.join(".secrets", "image-studio", "tasks.json"))).digest("hex");
  assert.equal(afterHash, before, "create reconciliation must not mutate confirmed tasks");
  return { createCalls, retryHooks };
}

async function main() {
  const original = process.cwd();
  const temp = mkdtempSync(path.join(os.tmpdir(), "image-create-race-"));
  try {
    process.chdir(temp);
    // These modules derive their local-state paths at evaluation time. Import
    // them only after entering the isolated fixture root so this test can never
    // read, create, or remove the project's real active-order record.
    [client, orderState, runner, marketplace] = await Promise.all([
      import("./clore/client"),
      import("./clore/order-state"),
      import("./image-4090-runner"),
      import("./clore/marketplace"),
    ]);
    const rawCandidate: RawCloreServer = {
      id: 98682,
      gpu_name: "NVIDIA GeForce RTX 4090",
      gpu_count: 1,
      gpu_memory_gb: 24,
      ram_gb: 64,
      cpu_cores: 16,
      disk_gb: 250,
      download_mbps: 500,
      upload_mbps: 300,
      price_usd_per_hour: .2183333333,
      rentable: true,
      type: "on-demand",
      reliability: .99,
      rating: 4.8,
      rating_count: 10,
      supports_docker: true,
      supports_ssh: true,
      host_online: true,
      allowed_currencies: ["USD-Blockchain"],
    };
    const evaluated = marketplace.evaluateMarketplace([rawCandidate], config);
    assert.equal(evaluated.matches.length, 1);
    candidate = evaluated.matches[0];
    mkdirSync(path.join(".secrets", "image-studio"), { recursive: true });
    runner.writeJson(path.join(".secrets", "image-studio", "tasks.json"), [{ id: "task-1", status: "waiting_for_gpu", attempts: 0 }]);
    for (const kind of ["retry", "matched_rate", "matched_reset", "none", "ambiguous"] as const) {
      orderState.clearLocalActiveOrderState();
      runner.writeJson(path.join(".secrets", "image-studio", "runner-session.json"), session());
      const result = await runScenario(kind);
      if (kind === "retry") assert.equal(result.createCalls, 2, "429 is reconciled before one bounded retry succeeds");
      if (kind === "matched_rate" || kind === "matched_reset") assert.equal(result.createCalls, 1, "matching order stops additional create requests");
    }
    runner.writeJson(path.join(".secrets", "image-studio", "runner-session.json"), {
      ...session(),
      frozenTaskIds: ["task-1", "task-2"],
    });
    await assert.rejects(
      () => runner.runImage4090Batch(undefined, { sessionId: "attempt-1", taskIds: ["task-2", "task-1"] }),
      /image_session_worker_runner_projection_mismatch/,
      "the detached worker must use the exact frozen task order published by its supervisor",
    );
    let calls = 0;
    const scheduler = new client.CloreRequestScheduler({ fetch: async () => { calls += 1; return new Response(JSON.stringify({ code: 0, data: { id: "one" } }), { status: 200 }); }, sleep: async () => undefined, jitter: () => 0, log: () => undefined });
    await Promise.all([scheduler.request(config, "/create_order", { method: "POST" }), scheduler.request(config, "/create_order", { method: "POST" })]);
    assert.equal(calls, 1, "concurrent create callers must share one scheduler flight");
    console.log(JSON.stringify({ image_create_order_race_tests_passed: true, providerMutationCount: 0, cases: 5, concurrentSingleFlight: true, exactSupervisorTaskCorrelation: true }));
  } finally {
    process.chdir(original);
    rmSync(temp, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
