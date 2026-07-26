/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloreCreateRetryReconciledError, CloreRateLimitError, CloreRequestScheduler, type CloreRequestOptions } from "./clore/client";
import { clearLocalActiveOrderState, readActiveOrder, writeActiveOrder } from "./clore/order-state";
import { createOrderWithNetworkRetry, writeJson, type ImageRunnerSession, type RunnerDeps } from "./image-4090-runner";

const config = { apiKey: "fake", apiBaseUrl: "https://clore.invalid", targetGpu: "NVIDIA GeForce RTX 4090", minGpuVramGb: 24, orderType: "on-demand" } as any;
const execution = { enabled: true } as any;
const candidate = { serverId: "98682", gpu: "NVIDIA GeForce RTX 4090", priceUsdPerHour: 0.2183333333 } as any;
const body = { currency: "USD-Blockchain", image: "ghcr.io/example/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", renting_server: 98682, type: "on-demand", required_price: 5.24, ports: { "8080": "http" }, env: { COMFY_RUNTIME_MODE: "gpu", COMFY_GPU_PROFILE: "rtx4090", COMFY_NODE_PROFILE: "image-flux", START_GPU_WORKER: "false" } } as any;

function session(): ImageRunnerSession {
  return { state: "running", stage: "creating_order", frozenTaskIds: ["task-1"], gpuClass: "rtx4090", maxHourlyPrice: .3, currentTaskIndex: null, currentModel: null, promptSummary: null, startedAt: "2026-07-26T16:28:00.000Z", updatedAt: "2026-07-26T16:28:00.000Z", host: { serverId: "98682" } as any, error: null, blocker: null, pid: 123, logPath: null, createAttempt: { id: "attempt-1", startedAt: "2026-07-26T16:28:00.000Z", phase: "creating_order", requestAttempts: 0 } };
}

function active(orderId: string) {
  return [{ orderId, serverId: "98682", status: "deploying", currency: "USD-Blockchain", price: 5.24, fee: null, creationFee: null, spend: null, createdTimestamp: 1, expired: false, active: true, deploymentState: "deploying" }];
}

async function runScenario(kind: "retry" | "matched_rate" | "matched_reset" | "none" | "ambiguous") {
  let retryHooks = 0;
  let createCalls = 0;
  const deps: RunnerDeps = {
    loadConfig: () => config,
    loadExecution: () => execution,
    readMarketplace: async () => [],
    readOrders: async () => kind === "matched_rate" || kind === "matched_reset" ? active("1983007") : kind === "ambiguous" ? [...active("1983007"), { ...active("1983008")[0], serverId: "other" }] : [],
    createOrder: async (input: any) => {
      const result = await input.request(input.requestBody);
      const id = String((result as any).id);
      writeActiveOrder({ order_id: id, server_id: "98682", project_tag: "ai-video-platform-wan22", created_at: new Date().toISOString(), status: "order_pending", usd_per_hour: .2183333333, max_price_usd_per_hour: .3, order_type: "on-demand", open_ports: ["controller/http:8080"], gpu_profile: "rtx4090", bootstrap_image: body.image, create_attempt_id: "attempt-1" });
      return { order_id: id, order_created: true } as any;
    },
    cancelOrder: async () => ({}) as any,
    fetchJson: async () => ({}),
    fetchBinary: async () => Buffer.alloc(0),
    cloreRequest: (async (_config: any, endpoint: string, _init: any, options: CloreRequestOptions = {}) => {
      assert.equal(endpoint, "/create_order");
      createCalls += 1;
      retryHooks += 1;
      const found = await options.onCreateRetry?.({ reason: kind === "matched_reset" ? "network_error" : "rate_limited", attempt: retryHooks, httpStatus: kind === "matched_reset" ? null : 429, code: kind === "matched_reset" ? null : 5 });
      const during = JSON.parse(readFileSync(path.join(".secrets", "image-studio", "runner-session.json"), "utf8")) as ImageRunnerSession;
      assert.equal(during.state, "running");
      assert.notEqual(during.stage, "create_order_failed");
      if (found) throw new CloreCreateRetryReconciledError();
      if (kind === "none" || kind === "ambiguous") throw new CloreRateLimitError({ httpStatus: 429, code: 5, message: "rate", retryAfterMs: null, attempt: retryHooks });
      createCalls += 1;
      return { id: "1983007", status: "created" };
    }) as RunnerDeps["cloreRequest"],
    sleep: async () => undefined,
  };
  const before = createHash("sha256").update(readFileSync(path.join(".secrets", "image-studio", "tasks.json"))).digest("hex");
  if (kind === "none") {
    await assert.rejects(() => createOrderWithNetworkRetry({ deps, config, execution, candidate, requestBody: body, selectedServerId: "98682", gpuClass: "rtx4090" }), /Clore/);
    const after = JSON.parse(readFileSync(path.join(".secrets", "image-studio", "runner-session.json"), "utf8")) as ImageRunnerSession;
    assert.equal(after.stage, "create_order_failed");
    assert.equal(readActiveOrder(), null);
  } else if (kind === "ambiguous") {
    await assert.rejects(() => createOrderWithNetworkRetry({ deps, config, execution, candidate, requestBody: body, selectedServerId: "98682", gpuClass: "rtx4090" }), /ambiguous/);
    assert.equal(readActiveOrder(), null);
  } else {
    const orderId = await createOrderWithNetworkRetry({ deps, config, execution, candidate, requestBody: body, selectedServerId: "98682", gpuClass: "rtx4090" });
    assert.equal(orderId, "1983007");
    assert.equal(readActiveOrder()?.order_id, "1983007");
    assert.equal(readActiveOrder()?.create_attempt_id, "attempt-1");
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
    mkdirSync(path.join(".secrets", "image-studio"), { recursive: true });
    writeJson(path.join(".secrets", "image-studio", "tasks.json"), [{ id: "task-1", status: "waiting_for_gpu", attempts: 0 }]);
    for (const kind of ["retry", "matched_rate", "matched_reset", "none", "ambiguous"] as const) {
      clearLocalActiveOrderState();
      writeJson(path.join(".secrets", "image-studio", "runner-session.json"), session());
      const result = await runScenario(kind);
      if (kind === "retry") assert.equal(result.createCalls, 2, "429 is reconciled before one bounded retry succeeds");
      if (kind === "matched_rate" || kind === "matched_reset") assert.equal(result.createCalls, 1, "matching order stops additional create requests");
    }
    let calls = 0;
    const scheduler = new CloreRequestScheduler({ fetch: async () => { calls += 1; return new Response(JSON.stringify({ code: 0, data: { id: "one" } }), { status: 200 }); }, sleep: async () => undefined, jitter: () => 0, log: () => undefined });
    await Promise.all([scheduler.request(config, "/create_order", { method: "POST" }), scheduler.request(config, "/create_order", { method: "POST" })]);
    assert.equal(calls, 1, "concurrent create callers must share one scheduler flight");
    console.log(JSON.stringify({ image_create_order_race_tests_passed: true, providerMutationCount: 0, cases: 5, concurrentSingleFlight: true }));
  } finally {
    process.chdir(original);
    rmSync(temp, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
