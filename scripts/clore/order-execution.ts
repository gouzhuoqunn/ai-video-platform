import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { cloreRequest, sleep } from "./client";
import { DEFAULT_DOCKER_IMAGE, PROJECT_TAG } from "./config";
import type { loadCloreConfig } from "./config";
import { verifyDockerImage } from "./docker-image";
import { readLiveOrdersSummary, readWalletSummary } from "./live";
import { applyWalletBalance, evaluateMarketplace } from "./marketplace";
import { inspectSshPublicKey } from "./ssh";
import type { CloreCandidate, RawCloreServer } from "./types";
import { acquireOrderCreateLock, readActiveOrder, writeActiveOrder } from "./order-state";
import type { CloreExecutionConfig } from "./execution-config";
import { loadModelCacheConfig } from "../model-cache/config";

export type LoadedCloreConfig = ReturnType<typeof loadCloreConfig>;

export type CreateOrderRequest = {
  currency: string;
  image: string;
  renting_server: number;
  type: "on-demand";
  ports: Record<string, "tcp">;
  env: Record<string, string>;
  ssh_key: string;
  command: string;
  required_price: number;
  autossh_entrypoint: boolean;
};

export type CreateOrderPreflightInput = {
  serverId: string;
  confirmedMaxPriceUsdPerHour: number;
  queuedJobCount: number;
  marketplace: RawCloreServer[];
  availableUsdBalance: number | null;
  config: LoadedCloreConfig;
  execution: CloreExecutionConfig;
  verifyImage?: typeof verifyDockerImage;
};

export function buildCreateOrderBody(input: {
  serverId: string;
  image?: string;
  currency: string;
  sshPublicKey: string;
  maxPriceUsdPerHour: number;
  requiredPriceForApi?: number;
}): CreateOrderRequest {
  return {
    currency: input.currency,
    image: input.image || DEFAULT_DOCKER_IMAGE,
    renting_server: Number(input.serverId),
    type: "on-demand",
    ports: { "22": "tcp" },
    env: {
      PROJECT_TAG,
      WAN_RUNNER: "real",
      WAN_MODEL_DIR: "/workspace/models/Wan2.2-TI2V-5B",
      HF_HUB_DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
    },
    ssh_key: input.sshPublicKey,
    command: "bash -lc 'mkdir -p /workspace/ai-video-platform /workspace/models /workspace/jobs /workspace/logs'",
    required_price: input.requiredPriceForApi ?? input.maxPriceUsdPerHour,
    autossh_entrypoint: true,
  };
}

export function assertCreateOrderBodySafe(body: CreateOrderRequest) {
  const serialized = JSON.stringify(body);
  if (/CLORE_API_KEY|SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|GPU_WORKER_PASSWORD|LOCAL_LAB_PASSWORD/i.test(serialized)) {
    throw new Error("Refusing to include secrets in Clore order body.");
  }
  if (body.type !== "on-demand") {
    throw new Error("Only on-demand Clore orders are allowed.");
  }
  if (Object.keys(body.ports).length !== 1 || body.ports["22"] !== "tcp") {
    throw new Error("Only SSH port 22/tcp may be opened.");
  }
}

export async function runCreateOrderPreflight(input: CreateOrderPreflightInput) {
  if (!input.execution.enabled) {
    throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false.");
  }
  if (readActiveOrder()) {
    throw new Error("A project active Clore order already exists.");
  }
  if (input.queuedJobCount <= 0) {
    throw new Error("At least one queued job is required.");
  }
  if (input.config.dockerImage === DEFAULT_DOCKER_IMAGE) {
    throw new Error("Runtime image is not published/configured; refusing real create_order.");
  }
  const modelCache = loadModelCacheConfig();
  if (!modelCache.r2Enabled || !modelCache.bucket || !modelCache.endpoint) {
    throw new Error("R2 model cache is not configured; refusing real create_order.");
  }

  const { matches } = evaluateMarketplace(input.marketplace, input.config);
  const selected = applyWalletBalance(matches, input.availableUsdBalance).find((candidate) => candidate.serverId === input.serverId);
  if (!selected) {
    throw new Error("Selected server is no longer a compliant RTX 5090 candidate.");
  }
  if (selected.orderType !== "on-demand") {
    throw new Error("Spot or non-on-demand orders are refused.");
  }
  if (!selected.rentable) {
    throw new Error("Selected server is no longer rentable.");
  }
  if (selected.priceUsdPerHour === null || selected.priceUsdPerHour > input.confirmedMaxPriceUsdPerHour) {
    throw new Error("Current price exceeds the user's confirmed maximum.");
  }
  if (selected.priceUsdPerHour > input.execution.maxGpuPricePerHour) {
    throw new Error("Current price exceeds the system hourly cap.");
  }
  if ((selected.sixHourCostUsd ?? Number.POSITIVE_INFINITY) > input.execution.firstSessionMaxBudgetUsd) {
    throw new Error("Six-hour planning cost exceeds the first-session budget.");
  }
  if (input.availableUsdBalance === null || input.availableUsdBalance - (selected.sixHourCostUsd ?? 0) < input.execution.balanceReserveUsd) {
    throw new Error("Wallet balance is insufficient after reserve.");
  }

  const ssh = inspectSshPublicKey(input.config.sshPublicKeyPath ?? "");
  if (!ssh.exists || !ssh.formatValid) {
    throw new Error("SSH public key is missing or invalid.");
  }
  const image = await (input.verifyImage ?? verifyDockerImage)(input.config.dockerImage);
  if (!image.exists || !image.linuxAmd64) {
    throw new Error("Docker image was not verified for linux/amd64.");
  }

  return selected;
}

function summarizeCreatedOrder(payload: unknown) {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return {
    order_id: String(record.id ?? record.order_id ?? crypto.randomUUID()),
    raw_status: record.status ?? record.state ?? "created",
  };
}

export async function createCloreOrder(input: {
  config: LoadedCloreConfig;
  execution: CloreExecutionConfig;
  candidate: CloreCandidate;
  requestBody: CreateOrderRequest;
  requestId?: string;
  request?: (body: CreateOrderRequest) => Promise<unknown>;
}) {
  if (!input.execution.enabled) {
    throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false.");
  }
  assertCreateOrderBodySafe(input.requestBody);
  const lock = acquireOrderCreateLock(input.requestId ?? crypto.randomUUID());
  try {
    if (readActiveOrder()) {
      throw new Error("A project active Clore order already exists.");
    }
    await sleep(5000);
    const response = input.request
      ? await input.request(input.requestBody)
      : await cloreRequest<unknown>(input.config, "/create_order", {
          method: "POST",
          body: JSON.stringify(input.requestBody),
        });
    const created = summarizeCreatedOrder(response);
    writeActiveOrder({
      order_id: created.order_id,
      server_id: input.candidate.serverId,
      project_tag: PROJECT_TAG,
      created_at: new Date().toISOString(),
      status: "order_pending",
      usd_per_hour: input.candidate.priceUsdPerHour ?? input.requestBody.required_price,
      max_price_usd_per_hour: input.requestBody.required_price,
      order_type: "on-demand",
      open_ports: ["ssh/tcp"],
    });
    return {
      order_created: true,
      order_id: created.order_id,
      create_order_called: true,
      status: "order_pending",
    };
  } finally {
    lock.release();
  }
}

export async function prepareCreateOrderFromLive(input: {
  config: LoadedCloreConfig;
  execution: CloreExecutionConfig;
  serverId: string;
  maxPriceUsdPerHour: number;
  queuedJobCount: number;
}) {
  const liveOrders = await readLiveOrdersSummary(input.config);
  const activeLiveOrder = liveOrders.find((order) => order.active);
  if (activeLiveOrder) {
    throw new Error("A live Clore order already appears to be active. Refusing to create another order.");
  }
  const wallet = await readWalletSummary(input.config);
  const marketplace = await import("./live").then((live) => live.readLiveMarketplace(input.config));
  const candidate = await runCreateOrderPreflight({
    serverId: input.serverId,
    confirmedMaxPriceUsdPerHour: input.maxPriceUsdPerHour,
    queuedJobCount: input.queuedJobCount,
    marketplace,
    availableUsdBalance: wallet.availableUsdBalance,
    config: input.config,
    execution: input.execution,
  });
  const publicKey = readFileSync(input.config.sshPublicKeyPath ?? "", "utf8").split(/\r?\n/)[0].trim();
  const requestBody = buildCreateOrderBody({
    serverId: input.serverId,
    image: input.config.dockerImage,
    currency: input.config.rentalCurrency,
    sshPublicKey: publicKey,
    maxPriceUsdPerHour: input.maxPriceUsdPerHour,
    requiredPriceForApi:
      candidate.priceOriginalCurrency === "USD" && candidate.priceOriginalUnit === "day" && candidate.priceOriginalAmount !== null
        ? candidate.priceOriginalAmount
        : input.maxPriceUsdPerHour,
  });
  assertCreateOrderBodySafe(requestBody);
  return { candidate, requestBody, wallet };
}
