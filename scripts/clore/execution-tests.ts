import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCloreConfig } from "./config";
import { loadCloreExecutionConfig } from "./execution-config";
import { buildCreateOrderBody, createCloreOrder, runCreateOrderPreflight } from "./order-execution";
import { cancelCloreOrder } from "./cancel-execution";
import { readActiveOrder } from "./order-state";
import type { RawCloreServer } from "./types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function mockServer(overrides: RawCloreServer = {}): RawCloreServer {
  return {
    id: "95538",
    gpu_name: "NVIDIA GeForce RTX 5090",
    gpu_count: 1,
    gpu_memory_gb: 32,
    ram_gb: 128,
    cpu_cores: 24,
    disk_gb: 970,
    download_mbps: 2000,
    upload_mbps: 800,
    reliability: 0.9998,
    rating: 5,
    rating_count: 10,
    country: "CA",
    price_usd_per_hour: 0.624583,
    rentable: true,
    order_type: "on-demand",
    supports_docker: true,
    supports_ssh: true,
    driver_compatible: true,
    ...overrides,
  };
}

async function main() {
  const originalCwd = process.cwd();
  const temp = mkdtempSync(path.join(os.tmpdir(), "clore-execution-test-"));
  try {
    process.chdir(temp);
    mkdirSync(path.join(temp, ".secrets"), { recursive: true });
    const sshDir = path.join(temp, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    const pubKeyPath = path.join(sshDir, "clore_ai_video_worker_ed25519.pub");
    writeFileSync(pubKeyPath, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockPublicKeyForTestsOnly000000000000 test\n", "utf8");
    process.env.CLORE_SSH_PUBLIC_KEY_PATH = pubKeyPath;
    process.env.CLORE_DOCKER_IMAGE = "nvidia/cuda:12.8.0-devel-ubuntu22.04";
    process.env.CLORE_ORDER_EXECUTION_ENABLED = "true";
    process.env.MODEL_CACHE_BUCKET = "mock-wan22-cache";
    process.env.MODEL_CACHE_ENDPOINT = "https://mock-r2.example.test";

    const config = loadCloreConfig();
    const execution = loadCloreExecutionConfig();
    const candidate = await runCreateOrderPreflight({
      serverId: "95538",
      confirmedMaxPriceUsdPerHour: 0.7,
      queuedJobCount: 1,
      marketplace: [mockServer()],
      availableUsdBalance: 10.99,
      config,
      execution,
      verifyImage: async (image) => ({ image, exists: true, linuxAmd64: true, method: "mock" }),
      verifyWatchdogs: async () => undefined,
    });
    assert(candidate.serverId === "95538", "preflight should return the selected candidate.");

    await runCreateOrderPreflight({
      serverId: "95538",
      confirmedMaxPriceUsdPerHour: 0.7,
      queuedJobCount: 1,
      marketplace: [mockServer({ order_type: "spot" })],
      availableUsdBalance: 10.99,
      config,
      execution,
      verifyImage: async (image) => ({ image, exists: true, linuxAmd64: true, method: "mock" }),
      verifyWatchdogs: async () => undefined,
    }).then(
      () => {
        throw new Error("spot candidate should fail.");
      },
      (error) => assert(String(error.message).includes("compliant"), "spot/server mismatch should be rejected before create_order."),
    );

    await runCreateOrderPreflight({
      serverId: "95538",
      confirmedMaxPriceUsdPerHour: 0.7,
      queuedJobCount: 0,
      marketplace: [mockServer()],
      availableUsdBalance: 10.99,
      config,
      execution,
      verifyImage: async (image) => ({ image, exists: true, linuxAmd64: true, method: "mock" }),
      verifyWatchdogs: async () => undefined,
    }).then(
      () => {
        throw new Error("no queued job should fail.");
      },
      (error) => assert(String(error.message).includes("queued"), "no queued job must be rejected."),
    );

    const body = buildCreateOrderBody({
      serverId: "95538",
      image: config.dockerImage,
      currency: "USD-Blockchain",
      sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockPublicKeyForTestsOnly000000000000 test",
      maxPriceUsdPerHour: 0.7,
      requiredPriceForApi: 14.99,
    });
    assert(body.type === "on-demand", "create body must be on-demand.");
    assert(body.required_price === 14.99, "create body should preserve Clore USD/day required_price when provided.");
    assert(body.autossh_entrypoint === true, "create body must request Clore autossh entrypoint.");
    assert(body.ports["22"] === "tcp" && Object.keys(body.ports).length === 1, "create body must expose SSH only.");
    assert(!JSON.stringify(body).includes("CLORE_API_KEY"), "Clore API key must not enter create body.");

    let createCalls = 0;
    const createResult = await createCloreOrder({
      config,
      execution,
      candidate,
      requestBody: body,
      request: async () => {
        createCalls += 1;
        return { id: "mock-order-1", status: "created" };
      },
    });
    assert(createCalls === 1, "mock create_order should be called once.");
    assert(createResult.order_created, "mock create should produce an active order.");
    assert(readActiveOrder()?.order_id === "mock-order-1", "active order state should be written.");

    await createCloreOrder({
      config,
      execution,
      candidate,
      requestBody: body,
      request: async () => ({ id: "mock-order-2" }),
    }).then(
      () => {
        throw new Error("duplicate active order should fail.");
      },
      (error) => assert(String(error.message).includes("active"), "duplicate order must be blocked by state."),
    );

    await cancelCloreOrder({
      config,
      execution,
      orderId: "mock-order-1",
      processingJobs: 1,
      uploading: false,
      finalVideoUploaded: true,
      request: async () => ({ ok: true }),
    }).then(
      () => {
        throw new Error("cancel during processing should fail.");
      },
      (error) => assert(String(error.message).includes("processing"), "cancel must reject processing jobs."),
    );

    let cancelCalls = 0;
    const cancelResult = await cancelCloreOrder({
      config,
      execution,
      orderId: "mock-order-1",
      processingJobs: 0,
      uploading: false,
      finalVideoUploaded: true,
      request: async (cancelBody) => {
        cancelCalls += 1;
        assert(cancelBody.id === "mock-order-1", "cancel body must use order id.");
        return { code: 0 };
      },
    });
    assert(cancelCalls === 1, "mock cancel_order should be called once.");
    assert(cancelResult.order_canceled, "mock cancel should succeed.");
    assert(!readActiveOrder(), "active order state should be cleared after cancel.");

    process.env.CLORE_ORDER_EXECUTION_ENABLED = "false";
    await createCloreOrder({
      config,
      execution: loadCloreExecutionConfig(),
      candidate,
      requestBody: body,
      request: async () => {
        throw new Error("real request must not be reached when flag is false.");
      },
    }).then(
      () => {
        throw new Error("execution flag false should fail.");
      },
      (error) => assert(String(error.message).includes("CLORE_ORDER_EXECUTION_ENABLED=false"), "execution flag false must reject."),
    );

    console.log("Clore execution tests passed.");
  } finally {
    process.chdir(originalCwd);
    rmSync(temp, { recursive: true, force: true });
  }
}

void main();
