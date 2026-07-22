import crypto from "node:crypto";
import { cloreRequest, sleep } from "./client";
import { COMFY_RUNTIME_IMAGE, DEFAULT_DOCKER_IMAGE, PROJECT_TAG } from "./config";
import type { loadCloreConfig } from "./config";
import { verifyDockerImage } from "./docker-image";
import { readLiveOrdersSummary, readWalletSummary } from "./live";
import { CLORE_CREATION_FEE_USD, CLORE_RENTER_FEE_RATE, computeCloreProjectedCost, applyWalletBalance, evaluateMarketplace } from "./marketplace";
import { inspectSshPublicKey } from "./ssh";
import type { CloreCandidate, RawCloreServer } from "./types";
import { acquireOrderCreateLock, clearActiveOrder, clearLocalActiveOrderState, clearOrderCreateLocks, readActiveOrder, writeActiveOrder } from "./order-state";
import type { CloreExecutionConfig } from "./execution-config";
import { loadModelCacheConfig } from "../model-cache/config";
import { assertWatchdogsReadyForCreate } from "./watchdog-preflight";
import { assertCloreDeploymentAllowed } from "./deployment-hold";
import { CLORE_LIGHT_BOOTSTRAP_IMAGE, CLORE_LIGHT_BOOTSTRAP_PROFILE } from "./public-image";
import type { GpuProfile } from "../gpu-providers/types";
import {
  assertPublicKeyMatchesCanonicalIdentity,
  buildSanitizedSshCredentialSummary,
  parseNormalizedOpenSshPublicKey,
} from "./ssh-identity";
import { ensureValidatedProjectSshKey } from "./ssh-key-validation";

/** The first-principles Clore image used for the real Wan session.  Runtime
 * setup happens only after key-authenticated SSH is proven. */
export const CLORE_CUDA_BASE_IMAGE = "cloreai/ubuntu22.04-cuda12";

export type LoadedCloreConfig = ReturnType<typeof loadCloreConfig>;

export type CreateOrderRequest = {
  currency: string;
  image: string;
  renting_server: number;
  type: "on-demand";
  ports: Record<string, "tcp" | "http">;
  env?: Record<string, string>;
  ssh_key?: string;
  ssh_password?: string;
  command?: string;
  required_price?: number;
  autossh_entrypoint?: boolean;
};

export type StandardCreateOrderRequest = CreateOrderRequest & {
  env: Record<string, string>;
  ssh_key: string;
  command: string;
  required_price: number;
  autossh_entrypoint: true;
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
  verifyWatchdogs?: () => Promise<void> | void;
  orderProfile?: "cuda_base" | "http_runtime";
};

export function validateCreatedOrderPricing(input: {
  order: {
    price: number | null;
    fee: number | null;
    creationFee: number | null;
    currency: string | null;
  };
  expectedBaseDailyPrice: number | null;
}) {
  if (input.order.currency !== "USD-Blockchain") {
    throw new Error("Created Clore order currency is not USD-Blockchain.");
  }
  if (input.expectedBaseDailyPrice !== null && input.order.price !== null && input.order.price > input.expectedBaseDailyPrice) {
    throw new Error("Created Clore order price is higher than the marketplace base price.");
  }
  if (input.order.fee !== null && input.order.fee > CLORE_RENTER_FEE_RATE) {
    throw new Error("Created Clore order fee is higher than the expected renter fee.");
  }
  if (input.order.creationFee !== null && input.order.creationFee > CLORE_CREATION_FEE_USD) {
    throw new Error("Created Clore order creation_fee is higher than 0.10 USD.");
  }
}

export function buildCreateOrderBody(input: {
  serverId: string;
  image?: string;
  currency: string;
  sshPublicKey: string;
  maxPriceUsdPerHour: number;
  requiredPriceForApi?: number;
  bootstrapProfile?: typeof CLORE_LIGHT_BOOTSTRAP_PROFILE | "fixed_runtime";
}): StandardCreateOrderRequest {
  const bootstrapProfile = input.bootstrapProfile ?? "fixed_runtime";
  const image = bootstrapProfile === CLORE_LIGHT_BOOTSTRAP_PROFILE ? CLORE_LIGHT_BOOTSTRAP_IMAGE : COMFY_RUNTIME_IMAGE;
  if (input.image && input.image !== image) throw new Error("Clore order image does not match the selected bootstrap profile.");
  return {
    currency: input.currency,
    image,
    renting_server: Number(input.serverId),
    type: "on-demand",
    ports: bootstrapProfile === CLORE_LIGHT_BOOTSTRAP_PROFILE ? { "22": "tcp" } : { "22": "tcp", "8080": "http" },
    env: bootstrapProfile === CLORE_LIGHT_BOOTSTRAP_PROFILE
      ? { PROJECT_TAG, RUNTIME_BOOTSTRAP_PROFILE: CLORE_LIGHT_BOOTSTRAP_PROFILE, HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" }
        : { PROJECT_TAG, COMFY_RUNTIME_MODE: "gpu", COMFY_GPU_PROFILE: "rtx4090", COMFY_NODE_PROFILE: "image-flux", START_GPU_WORKER: "false", HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
    ssh_key: input.sshPublicKey,
    command: bootstrapProfile === CLORE_LIGHT_BOOTSTRAP_PROFILE
      ? "bash -lc 'mkdir -p /workspace/ai-runtime /workspace/models /workspace/jobs /workspace/logs; while sleep 3600; do :; done'"
      : "bash -lc 'mkdir -p /workspace/ai-video-platform /workspace/models /workspace/jobs /workspace/logs'",
    required_price: input.requiredPriceForApi ?? input.maxPriceUsdPerHour,
    autossh_entrypoint: true,
  };
}

export function buildManualParityCreateOrderBody(input: { serverId: string; currency: string; sshPassword: string; sshPublicKey: string }): CreateOrderRequest {
  return { currency: input.currency, image: CLORE_LIGHT_BOOTSTRAP_IMAGE, renting_server: Number(input.serverId), type: "on-demand", ports: { "22": "tcp" }, ssh_password: input.sshPassword, ssh_key: input.sshPublicKey, autossh_entrypoint: true };
}

export function buildKeyOnlyCreateOrderBody(input: { serverId: string; currency: string; sshPublicKey: string; requiredPriceForApi: number }): CreateOrderRequest {
  return { currency: input.currency, image: CLORE_LIGHT_BOOTSTRAP_IMAGE, renting_server: Number(input.serverId), type: "on-demand", ports: { "22": "tcp" }, ssh_key: input.sshPublicKey, required_price: input.requiredPriceForApi, autossh_entrypoint: true };
}

export function buildCudaBaseCreateOrderBody(input: { serverId: string; currency: string; sshPublicKey: string; requiredPrice: number }): CreateOrderRequest {
  return {
    currency: input.currency,
    image: CLORE_CUDA_BASE_IMAGE,
    renting_server: Number(input.serverId),
    type: "on-demand",
    ports: { "22": "tcp" },
    ssh_key: input.sshPublicKey,
    required_price: input.requiredPrice,
    // The official CUDA base image has no project SSH daemon of its own.
    // Clore's documented entrypoint installs the SSH endpoint for this image.
    autossh_entrypoint: true,
  };
}

export function buildHttpRuntimeCreateOrderBody(input: { serverId: string; currency: string; requiredPrice: number }): CreateOrderRequest {
  return {
    currency: input.currency, image: COMFY_RUNTIME_IMAGE, renting_server: Number(input.serverId), type: "on-demand",
    ports: { "8080": "http" },
    env: { PROJECT_TAG, COMFY_RUNTIME_MODE: "gpu", COMFY_GPU_PROFILE: "rtx4090", COMFY_NODE_PROFILE: "image-flux", START_GPU_WORKER: "false" },
    required_price: input.requiredPrice,
  };
}

export function buildKeyWithPasswordFallbackCreateOrderBody(input: { serverId: string; currency: string; sshPassword: string; sshPublicKey: string; requiredPriceForApi: number }): CreateOrderRequest {
  return { currency: input.currency, image: CLORE_LIGHT_BOOTSTRAP_IMAGE, renting_server: Number(input.serverId), type: "on-demand", ports: { "22": "tcp" }, ssh_password: input.sshPassword, ssh_key: input.sshPublicKey, required_price: input.requiredPriceForApi, autossh_entrypoint: true };
}

export function assertCreateOrderBodySafe(body: CreateOrderRequest) {
  const serialized = JSON.stringify(body);
  if (/CLORE_API_KEY|SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|GPU_WORKER_PASSWORD|LOCAL_LAB_PASSWORD/i.test(serialized)) {
    throw new Error("Refusing to include secrets in Clore order body.");
  }
  if (body.type !== "on-demand") {
    throw new Error("Only on-demand Clore orders are allowed.");
  }
  if (body.currency !== "USD-Blockchain") {
    throw new Error("Clore order currency must be USD-Blockchain.");
  }
  const fixedRuntime = body.image === COMFY_RUNTIME_IMAGE && /@sha256:[a-f0-9]{64}$/.test(body.image);
  const lightBootstrap = body.image === CLORE_LIGHT_BOOTSTRAP_IMAGE && body.env?.RUNTIME_BOOTSTRAP_PROFILE === CLORE_LIGHT_BOOTSTRAP_PROFILE;
  const manualParity = body.image === CLORE_LIGHT_BOOTSTRAP_IMAGE && body.ssh_password !== undefined && body.env === undefined && body.command === undefined && body.required_price === undefined && body.autossh_entrypoint === true;
  const passwordFallback = body.image === CLORE_LIGHT_BOOTSTRAP_IMAGE && body.ssh_password !== undefined && body.env === undefined && body.command === undefined && body.required_price !== undefined && body.autossh_entrypoint === true;
  const keyOnly = body.image === CLORE_LIGHT_BOOTSTRAP_IMAGE && body.ssh_password === undefined && body.env === undefined && body.command === undefined && body.required_price !== undefined && body.autossh_entrypoint === true;
  const cudaBase = body.image === CLORE_CUDA_BASE_IMAGE && body.ssh_password === undefined && body.env === undefined && body.command === undefined && body.required_price !== undefined && body.autossh_entrypoint === true;
  const httpRuntime = body.image === COMFY_RUNTIME_IMAGE && body.ssh_key === undefined && body.ssh_password === undefined && body.command === undefined && body.ports["8080"] === "http";
  if (!fixedRuntime && !httpRuntime && !lightBootstrap && !manualParity && !passwordFallback && !keyOnly && !cudaBase) throw new Error("Clore order image must be the pinned Runtime, approved light bootstrap, or CUDA base profile.");
  if (httpRuntime) {
    const activeRuntimeText = JSON.stringify({
      COMFY_RUNTIME_MODE: body.env?.COMFY_RUNTIME_MODE,
      COMFY_GPU_PROFILE: body.env?.COMFY_GPU_PROFILE,
      COMFY_NODE_PROFILE: body.env?.COMFY_NODE_PROFILE,
    });
    if (body.env?.COMFY_NODE_PROFILE !== "image-flux" || /production_minimal|Wan|LTX|video/i.test(activeRuntimeText)) {
      throw new Error("Image HTTP runtime orders must use only COMFY_NODE_PROFILE=image-flux.");
    }
  }
  const ports = Object.keys(body.ports);
  if ((!httpRuntime && body.ports["22"] !== "tcp") || body.ports["8188"] !== undefined || ports.some((port) => !["22", "8080"].includes(port)) || ports.filter((port) => body.ports[port] === "http").length > 1) {
    throw new Error("Order must expose SSH and at most one HTTP port; ComfyUI 8188 is forbidden.");
  }
  if ((lightBootstrap || manualParity || passwordFallback || keyOnly || cudaBase) && ports.length !== 1) {
    throw new Error("clore_light_bootstrap exposes SSH only.");
  }
  if (httpRuntime) return;
  try {
    const parsed = parseNormalizedOpenSshPublicKey(body.ssh_key ?? "");
    if (body.ssh_key !== parsed.normalizedPublicKey) throw new Error("not_normalized");
  }
  catch { throw new Error("Order must contain one normalized non-empty OpenSSH public key, not a path or malformed text."); }
  if ((manualParity || passwordFallback) && !/^[A-Za-z0-9\s\-=.@+/]{20,32}$/.test(body.ssh_password ?? "")) throw new Error("Clore password fallback requires a temporary strong SSH password.");
  if (!manualParity && (!Number.isFinite(body.required_price) || (body.required_price ?? 0) <= 0)) {
    throw new Error("Order required_price must be a positive locked candidate price.");
  }
}

export function assertCreateOrderUsesCanonicalIdentity(body: CreateOrderRequest) {
  const identity = ensureValidatedProjectSshKey();
  if (!body.ssh_key) throw new Error("create_order_ssh_key_missing");
  assertPublicKeyMatchesCanonicalIdentity(body.ssh_key, identity);
  return buildSanitizedSshCredentialSummary(body.ssh_key, identity);
}

export async function runCreateOrderPreflight(input: CreateOrderPreflightInput) {
  assertCloreDeploymentAllowed();
  if (!input.execution.enabled) {
    throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false.");
  }
  await reconcileProjectActiveOrderBeforeCreate({ config: input.config, clearLocks: true });
  if (input.queuedJobCount <= 0) {
    throw new Error("At least one queued job is required.");
  }
  if (input.config.rentalCurrency !== "USD-Blockchain") {
    throw new Error("CLORE_RENTAL_CURRENCY must be USD-Blockchain for real create_order.");
  }
  const modelCache = loadModelCacheConfig();
  if (!modelCache.r2Enabled || !modelCache.bucket || !modelCache.endpoint) {
    throw new Error("R2 model cache is not configured; refusing real create_order.");
  }

  const { matches } = evaluateMarketplace(input.marketplace, input.config);
  const selected = applyWalletBalance(matches, input.availableUsdBalance).find((candidate) => candidate.serverId === input.serverId);
  if (!selected) {
    throw new Error(`Selected server is no longer a compliant ${input.config.targetGpu} candidate.`);
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
  const projected = computeCloreProjectedCost(selected.priceUsdPerHour, input.execution.hardSessionLimitMinutes / 60);
  if (projected.effectiveHourlyUsd === null || projected.effectiveHourlyUsd > input.confirmedMaxPriceUsdPerHour) {
    throw new Error("Current price exceeds the user's confirmed maximum.");
  }
  if ((projected.projectedTotalUsd ?? Number.POSITIVE_INFINITY) > input.execution.firstSessionMaxBudgetUsd) {
    throw new Error("Projected Clore total cost exceeds the first-session budget.");
  }
  if (input.availableUsdBalance === null || input.availableUsdBalance - (projected.projectedTotalUsd ?? 0) < input.execution.balanceReserveUsd) {
    throw new Error("Wallet balance is insufficient after reserve.");
  }

  if (input.orderProfile !== "http_runtime") {
    const ssh = inspectSshPublicKey(input.config.sshPublicKeyPath ?? "");
    if (!ssh.exists || !ssh.formatValid) {
      throw new Error("SSH public key is missing or invalid.");
    }
  }
  if (input.orderProfile !== "cuda_base") {
    if (input.config.dockerImage === DEFAULT_DOCKER_IMAGE) {
      throw new Error("Runtime image is not published/configured; refusing real create_order.");
    }
    if (input.config.dockerImage !== COMFY_RUNTIME_IMAGE) {
      throw new Error("CLORE_DOCKER_IMAGE must equal the fixed Comfy Runtime digest for this session.");
    }
    const image = await (input.verifyImage ?? verifyDockerImage)(input.config.dockerImage);
    if (!image.exists || !image.linuxAmd64) {
      throw new Error("Docker image was not verified for linux/amd64.");
    }
  }
  await input.verifyWatchdogs?.();

  return selected;
}

function summarizeCreatedOrder(payload: unknown) {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return {
    order_id: record.id === undefined && record.order_id === undefined ? null : String(record.id ?? record.order_id),
    raw_status: record.status ?? record.state ?? "created",
  };
}

async function reconcileProjectActiveOrderBeforeCreate(input: {
  config: LoadedCloreConfig;
  readOrders?: typeof readLiveOrdersSummary;
  clearLocks?: boolean;
}) {
  const local = readActiveOrder();
  if (!local) return;
  const liveOrders = await (input.readOrders ?? readLiveOrdersSummary)(input.config);
  const active = liveOrders.filter((order) => order.active && order.orderId);
  if (active.length === 0) {
    try {
      clearActiveOrder(local.order_id);
    } catch {
      clearLocalActiveOrderState();
    }
    if (input.clearLocks) clearOrderCreateLocks();
    console.info(JSON.stringify({ event: "clore_stale_active_order_cleared", at: new Date().toISOString(), local_order_id: local.order_id, source: "provider_zero_active_orders" }));
    return;
  }
  const matching = active.find((order) => order.orderId === local.order_id) ?? active.find((order) => order.serverId === local.server_id) ?? active[0];
  throw new Error(`A project active Clore order already exists: ${matching.orderId ?? local.order_id}`);
}

export async function createCloreOrder(input: {
  config: LoadedCloreConfig;
  execution: CloreExecutionConfig;
  candidate: CloreCandidate;
  requestBody: CreateOrderRequest;
  requestId?: string;
  request?: (body: CreateOrderRequest) => Promise<unknown>;
  readOrders?: typeof readLiveOrdersSummary;
  sessionMetadata?: { gpuType: string; gpuProfile: GpuProfile; bootstrapImage: string };
  beforeCreateRequest?: () => Promise<void> | void;
  afterCreateRequestAttempt?: () => Promise<void> | void;
  resolvedBatchRelease?: boolean;
}) {
  assertCloreDeploymentAllowed({ resolvedBatchRelease: input.resolvedBatchRelease });
  if (!input.execution.enabled) {
    throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false.");
  }
  assertCreateOrderBodySafe(input.requestBody);
  if (!input.request && input.requestBody.ssh_key) assertCreateOrderUsesCanonicalIdentity(input.requestBody);
  const lock = acquireOrderCreateLock(input.requestId ?? crypto.randomUUID());
  try {
    await reconcileProjectActiveOrderBeforeCreate({ config: input.config, readOrders: input.readOrders, clearLocks: false });
    await sleep(5000);
    await input.beforeCreateRequest?.();
    if (!input.request && input.requestBody.ssh_key) assertCreateOrderUsesCanonicalIdentity(input.requestBody);
    let response: unknown;
    try {
      response = input.request
        ? await input.request(input.requestBody)
        : await cloreRequest<unknown>(input.config, "/create_order", {
            method: "POST",
            body: JSON.stringify(input.requestBody),
          }, {
            beforeCreateRetry: input.beforeCreateRequest ? async () => { await input.beforeCreateRequest?.(); } : undefined,
          });
    } finally {
      await input.afterCreateRequestAttempt?.();
    }
    const created = summarizeCreatedOrder(response);
    let liveOrders = await (input.readOrders ?? readLiveOrdersSummary)(input.config);
    let activeLiveOrders = liveOrders.filter((order) => order.active);
    for (let visibilityAttempt = 0; !created.order_id && activeLiveOrders.length === 0 && !input.readOrders && visibilityAttempt < 5; visibilityAttempt += 1) {
      await sleep(5000);
      liveOrders = await readLiveOrdersSummary(input.config, { forceRefresh: true });
      activeLiveOrders = liveOrders.filter((order) => order.active);
    }
    const matchingLiveOrder =
      activeLiveOrders.find((order) => order.serverId === input.candidate.serverId && order.orderId) ??
      (activeLiveOrders.length === 1 && activeLiveOrders[0].orderId ? activeLiveOrders[0] : null);
    const orderId = matchingLiveOrder?.orderId ?? created.order_id;
    if (!orderId || !/^\d+$/.test(orderId)) throw new Error("create_order_id_unresolved_after_request");
    if (matchingLiveOrder) {
      try {
        validateCreatedOrderPricing({
          order: {
            price: matchingLiveOrder.price,
            fee: matchingLiveOrder.fee,
            creationFee: matchingLiveOrder.creationFee,
            currency: matchingLiveOrder.currency,
          },
          expectedBaseDailyPrice:
            input.candidate.priceOriginalCurrency === "USD" && input.candidate.priceOriginalUnit === "day"
              ? input.candidate.priceOriginalAmount
              : null,
        });
      } catch (error) {
        await cloreRequest<unknown>(input.config, "/cancel_order", {
          method: "POST",
          body: JSON.stringify({ id: orderId, issue: "pricing_guard_failed" }),
        });
        throw error;
      }
    }
    writeActiveOrder({
      order_id: orderId,
      server_id: input.candidate.serverId,
      project_tag: PROJECT_TAG,
      created_at: new Date().toISOString(),
      status: "order_pending",
      usd_per_hour: input.candidate.priceUsdPerHour ?? input.requestBody.required_price ?? 0,
      max_price_usd_per_hour: input.candidate.priceUsdPerHour ?? input.requestBody.required_price ?? 0,
      order_type: "on-demand",
      open_ports: input.requestBody.ports["8080"] === "http" ? ["controller/http:8080"] : ["ssh/tcp"],
      gpu_type: input.sessionMetadata?.gpuType ?? input.candidate.gpu,
      gpu_profile: input.sessionMetadata?.gpuProfile ?? "rtx4090",
      bootstrap_image: input.sessionMetadata?.bootstrapImage ?? input.requestBody.image,
    });
    return {
      order_created: true,
      order_id: orderId,
      create_order_called: true,
      status: "order_pending",
      create_response_status: String(created.raw_status ?? "created"),
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
  orderProfile?: "cuda_base" | "http_runtime";
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
    orderProfile: input.orderProfile,
    verifyWatchdogs: () => assertWatchdogsReadyForCreate(input.serverId),
  });
  const publicKey = input.orderProfile === "http_runtime" ? null : ensureValidatedProjectSshKey().normalizedPublicKey;
  const requestBody = input.orderProfile === "http_runtime"
    ? buildHttpRuntimeCreateOrderBody({ serverId: input.serverId, currency: input.config.rentalCurrency, requiredPrice: candidate.priceOriginalCurrency === "USD" && candidate.priceOriginalUnit === "day" && candidate.priceOriginalAmount !== null ? candidate.priceOriginalAmount : input.maxPriceUsdPerHour })
    : input.orderProfile === "cuda_base"
    ? buildCudaBaseCreateOrderBody({
      serverId: input.serverId,
      currency: input.config.rentalCurrency,
      sshPublicKey: publicKey ?? "",
      // Clore locks this field in the marketplace's original unit (USD/day),
      // while the Studio ceiling remains the independently frozen USD/hour cap.
      requiredPrice: candidate.priceOriginalCurrency === "USD" && candidate.priceOriginalUnit === "day" && candidate.priceOriginalAmount !== null
        ? candidate.priceOriginalAmount
        : input.maxPriceUsdPerHour,
    })
    : buildCreateOrderBody({
      serverId: input.serverId,
      image: input.config.dockerImage,
      currency: input.config.rentalCurrency,
      sshPublicKey: publicKey ?? "",
      maxPriceUsdPerHour: input.maxPriceUsdPerHour,
      requiredPriceForApi:
        candidate.priceOriginalCurrency === "USD" && candidate.priceOriginalUnit === "day" && candidate.priceOriginalAmount !== null
          ? candidate.priceOriginalAmount
          : input.maxPriceUsdPerHour,
    });
  assertCreateOrderBodySafe(requestBody);
  return { candidate, requestBody, wallet };
}
