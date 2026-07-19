import "server-only";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { loadCloreConfig } from "../../../scripts/clore/config";
import { readLiveMarketplace, readWalletSummary } from "../../../scripts/clore/live";
import { applyWalletBalance, CLORE_RENTER_FEE_RATE, computeCloreProjectedCost, evaluateMarketplace, summarizeCandidate } from "../../../scripts/clore/marketplace";
import { stopSessionDryRun } from "../../../scripts/clore/session-orchestrator";
import { readSessionState } from "../../../scripts/clore/session-state";
import type { RawCloreServer } from "../../../scripts/clore/types";
import { buildLocalResultsPlan } from "../../../scripts/local-results/plan";
import { loadCloreExecutionConfig } from "../../../scripts/clore/execution-config";
import { DEFAULT_DOCKER_IMAGE } from "../../../scripts/clore/config";
import { loadModelCacheConfig } from "../../../scripts/model-cache/config";
import { MODEL_CACHE_CURRENT_KEY } from "../../../scripts/model-cache/manifest";
import { getCloreDeploymentHold } from "../../../scripts/clore/deployment-hold";
import {
  readGenerationPool,
  recordConfirmedQueueRentalSuccess,
} from "@/lib/generation/task-pool";
import type { GenerationFamily, RequiredGpuClass } from "@/lib/generation/gpu-execution-state";
import { LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR, manualCandidateBasePriceCeiling } from "@/lib/local-lab/gpu-price-filter";

const MOCK_MARKETPLACE_PATH = path.join(process.cwd(), "scripts", "clore", "mock-marketplace.json");
const LATEST_MARKETPLACE_PATH = path.join(process.cwd(), "scripts", "clore", "fixtures", "latest-marketplace.sanitized.json");
const LATEST_WALLET_PATH = path.join(process.cwd(), "scripts", "clore", "fixtures", "latest-wallet.sanitized.json");
const NONCE_STORE_PATH = path.join(process.cwd(), ".secrets", "local-lab-order-nonces.json");
const ORDER_PLAN_TTL_SECONDS = Number(process.env.CLORE_ORDER_PLAN_TTL_SECONDS ?? 120);

type StoredNonce = {
  hash: string;
  serverId: string;
  maxPriceUsdPerHour: number;
  effectivePriceUsdPerHour: number | null;
  creationFeeUsd: number;
  projectedTotalUsd: number | null;
  generationFamily: GenerationFamily;
  gpuClass: RequiredGpuClass;
  confirmedTaskIds: string[];
  expiresAt: string;
  usedAt: string | null;
};

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function writeJsonFile(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hashNonce(nonce: string) {
  return crypto.createHash("sha256").update(nonce).digest("hex");
}

function formatPriceForConfirmation(price: number) {
  return Number(price.toFixed(6)).toString();
}

function expectedConfirmationText(input: {
  serverId: string;
  basePriceUsdPerHour: number;
  effectivePriceUsdPerHour: number | null;
  creationFeeUsd: number;
  projectedTotalUsd: number | null;
}) {
  return [
    `确认租用 ${input.serverId}`,
    `基础每小时 ${formatPriceForConfirmation(input.basePriceUsdPerHour)} 美元`,
    `含租客费每小时 ${formatPriceForConfirmation(input.effectivePriceUsdPerHour ?? 0)} 美元`,
    `创建费 ${formatPriceForConfirmation(input.creationFeeUsd)} 美元`,
    `最长预计 ${formatPriceForConfirmation(input.projectedTotalUsd ?? 0)} 美元`,
  ].join("，");
}

function readNonceStore() {
  return readJsonFile<StoredNonce[]>(NONCE_STORE_PATH, []);
}

function writeNonceStore(nonces: StoredNonce[]) {
  const now = Date.now();
  const active = nonces.filter((nonce) => new Date(nonce.expiresAt).getTime() > now || nonce.usedAt);
  writeJsonFile(NONCE_STORE_PATH, active.slice(-50));
}

function safeCandidateList(rawServers: RawCloreServer[], availableUsdBalance: number | null) {
  const config = loadCloreConfig();
  const displayConfig = {
    ...config,
    maxGpuPricePerHour: manualCandidateBasePriceCeiling(CLORE_RENTER_FEE_RATE),
  };
  const evaluated = evaluateMarketplace(rawServers, displayConfig);
  const candidates = applyWalletBalance(evaluated.candidates, availableUsdBalance);
  const matches = applyWalletBalance(evaluated.matches, availableUsdBalance);
  const rejected5090 = candidates
    .filter((candidate) => /rtx\s+5090/i.test(candidate.gpu))
    .filter((candidate) => candidate.rejectionReasons.length > 0)
    .sort((left, right) => left.rejectionReasons.length - right.rejectionReasons.length)
    .slice(0, 5)
    .map((candidate) => ({
      ...summarizeCandidate(candidate),
      rejection_reasons: candidate.rejectionReasons,
    }));

  return {
    filters: {
      gpu: "exact RTX 5090",
      order_type: "on-demand",
      max_usd_per_hour: LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR,
      price_basis: "effective hourly price including 5% renter fee",
      assumed_minimum_rental_hours: config.assumedMinimumRentalHours,
      min_ram_gb: config.minRamGb,
      min_cpu_cores: config.minCpuCores,
      min_disk_gb: config.minDiskGb,
      min_download_mbps: config.minDownloadMbps,
      min_upload_mbps: config.minUploadMbps,
      min_reliability: config.minReliability,
      min_rating: config.minRating,
      min_rating_count: config.minRatingCount,
    },
    matches: matches.slice(0, 5).map(summarizeCandidate),
    rejected5090,
    selected: matches[0] ? summarizeCandidate(matches[0]) : null,
  };
}

export async function getLocalLabCloreCandidates() {
  const config = loadCloreConfig();

  if (config.apiKey) {
    const wallet = await readWalletSummary(config);
    const rawServers = await readLiveMarketplace(config);
    const evaluated = safeCandidateList(rawServers, wallet.availableUsdBalance);

    return {
      mode: "live-marketplace-read-only",
      source: "Clore read-only API",
      wallet: {
        available_usd_balance: wallet.availableUsdBalance,
        source: wallet.source,
      },
      last_refreshed_at: new Date().toISOString(),
      ...evaluated,
      raw_response_included: false,
      order_created: false,
    };
  }

  const latest = readJsonFile<Record<string, unknown> | null>(LATEST_MARKETPLACE_PATH, null);
  if (latest) {
    return {
      ...latest,
      mode: "latest-sanitized-fixture",
      source: "saved sanitized fixture",
      raw_response_included: false,
      order_created: false,
    };
  }

  const rawServers = readJsonFile<RawCloreServer[]>(MOCK_MARKETPLACE_PATH, []);
  return {
    mode: "mock-marketplace",
    source: "mock fixture",
    wallet: { available_usd_balance: null, source: "mock mode" },
    last_refreshed_at: new Date().toISOString(),
    ...safeCandidateList(rawServers, null),
    raw_response_included: false,
    order_created: false,
  };
}

export async function getLocalLabWallet() {
  const config = loadCloreConfig();
  if (config.apiKey) {
    const wallet = await readWalletSummary(config);
    return {
      mode: "live-wallet-read-only",
      available_usd_balance: wallet.availableUsdBalance,
      balances: wallet.balances.map((balance) => ({
        name: balance.name,
        currency: balance.currency,
        available: balance.balance,
        usd_like: balance.isUsdLike,
      })),
      source: wallet.source,
      balance_changes_made: false,
      hidden_sensitive_fields: ["deposit addresses", "full wallet object", "api key"],
    };
  }

  const latest = readJsonFile<Record<string, unknown> | null>(LATEST_WALLET_PATH, null);
  return latest ?? {
    mode: "wallet-unavailable",
    available_usd_balance: null,
    balances: [],
    source: "No CLORE_API_KEY loaded and no sanitized wallet fixture found.",
    balance_changes_made: false,
  };
}

export function getLocalLabSessionSummary() {
  const state = readSessionState();
  const resultsPlan = buildLocalResultsPlan();
  const cloreConfig = loadCloreConfig();
  const modelCache = loadModelCacheConfig();

  return {
    ...state,
    deploymentHold: getCloreDeploymentHold().enabled,
    deploymentHoldMessage: getCloreDeploymentHold().enabled ? "Clore部署异常，等待平台处理" : null,
    deploymentTimeline: [
      "尚未租用",
      "订单创建中",
      "主机启动中",
      "检查 GPU",
      "检查 CUDA/PyTorch",
      "恢复或下载模型",
      "校验模型",
      "启动 gpu_worker",
      "Worker 已就绪",
      "正在生成",
      "正在上传",
      "正在清理",
      "正在停止",
      "已停止",
      "失败",
    ],
    localResults: {
      libraryDir: resultsPlan.library_dir,
      structure: resultsPlan.structure,
      cleanupDryRun: resultsPlan.cleanup_policy.default_dry_run,
    },
    runtimeImage: {
      image: cloreConfig.dockerImage,
      customRuntimeConfigured: cloreConfig.dockerImage !== DEFAULT_DOCKER_IMAGE,
      digestPinned: cloreConfig.dockerImage.includes("@sha256:"),
      publicPullExpected: true,
    },
    modelCache: {
      provider: modelCache.provider,
      bucketConfigured: Boolean(modelCache.bucket),
      endpointConfigured: Boolean(modelCache.endpoint),
      prefix: modelCache.prefix,
      seedFlowImplemented: true,
      seedStatus: "cache_seed_ready_for_first_session",
      presignedUploadSupported: true,
      multipartUploadSupported: true,
      currentManifestKey: MODEL_CACHE_CURRENT_KEY,
      readonlyCredentialFile: ".secrets/model-cache-readonly.env",
      adminCredentialsOnGpu: false,
      signedUrlsReturnedToBrowser: false,
      readOnlyMode: modelCache.readOnly,
      r2Enabled: modelCache.r2Enabled,
      hfFallbackEnabled: modelCache.hfFallbackEnabled,
      officialRepo: modelCache.officialRepo,
      expectedSizeGb: modelCache.expectedSizeGb,
      credentialsReturned: false,
    },
  };
}

export function createOrderPlan(serverId: string, maxPriceUsdPerHour: number) {
  if (!serverId || !Number.isFinite(maxPriceUsdPerHour) || maxPriceUsdPerHour <= 0) {
    throw new Error("Invalid server id or max price.");
  }
  const execution = loadCloreExecutionConfig();
  const pool = readGenerationPool();
  const binding = pool.execution.activeExecution;
  if (pool.execution.activity !== "searching" || !binding || pool.execution.rentedGpuClass || pool.execution.providerOrderId) {
    throw new Error("请先从非空的显卡队列开始手动租用。");
  }
  const projected = computeCloreProjectedCost(maxPriceUsdPerHour, execution.hardSessionLimitMinutes / 60);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ORDER_PLAN_TTL_SECONDS * 1000);
  const nonce = crypto.randomUUID();
  const stored: StoredNonce = {
    hash: hashNonce(nonce),
    serverId,
    maxPriceUsdPerHour,
    effectivePriceUsdPerHour: projected.effectiveHourlyUsd,
    creationFeeUsd: projected.creationFeeUsd,
    projectedTotalUsd: projected.projectedTotalUsd,
    generationFamily: binding.generationFamily,
    gpuClass: binding.gpuClass,
    confirmedTaskIds: [...binding.confirmedTaskIds],
    expiresAt: expiresAt.toISOString(),
    usedAt: null,
  };
  writeNonceStore([...readNonceStore(), stored]);

  return {
    dry_run: true,
    nonce,
    server_id: serverId,
    max_price_usd_per_hour: maxPriceUsdPerHour,
    base_price_usd_per_hour: maxPriceUsdPerHour,
    effective_price_usd_per_hour: stored.effectivePriceUsdPerHour,
    creation_fee_usd: stored.creationFeeUsd,
    max_session_projected_total_usd: stored.projectedTotalUsd,
    generation_family: stored.generationFamily,
    gpu_class: stored.gpuClass,
    confirmed_task_ids: stored.confirmedTaskIds,
    expires_at: stored.expiresAt,
    required_confirmation_text: expectedConfirmationText({
      serverId,
      basePriceUsdPerHour: maxPriceUsdPerHour,
      effectivePriceUsdPerHour: projected.effectiveHourlyUsd,
      creationFeeUsd: projected.creationFeeUsd,
      projectedTotalUsd: projected.projectedTotalUsd,
    }),
    execution_limits: {
      first_session_max_budget_usd: execution.firstSessionMaxBudgetUsd,
      balance_reserve_usd: execution.balanceReserveUsd,
      hard_session_limit_minutes: execution.hardSessionLimitMinutes,
      order_start_timeout_minutes: execution.orderStartTimeoutMinutes,
      worker_ready_timeout_minutes: execution.workerReadyTimeoutMinutes,
      first_gpu_session: execution.firstGpuSession,
    },
    order_created: false,
    create_order_called: false,
  };
}

export async function confirmOrderPlan(input: {
  nonce: string;
  serverId: string;
  maxPriceUsdPerHour: number;
  confirmationText?: string;
  riskAccepted?: boolean;
  queuedJobCount: number;
}) {
  const now = new Date();
  const nonces = readNonceStore();
  const hashed = hashNonce(input.nonce);
  const index = nonces.findIndex((entry) => entry.hash === hashed);
  const stored = index >= 0 ? nonces[index] : null;

  if (!stored) {
    throw new Error("Order plan nonce was not found. Generate a fresh order plan.");
  }
  if (stored.usedAt) {
    throw new Error("Order plan nonce has already been used.");
  }
  if (new Date(stored.expiresAt).getTime() < now.getTime()) {
    throw new Error("Order plan expired. Refresh Clore candidates and generate a new plan.");
  }
  if (stored.serverId !== input.serverId || stored.maxPriceUsdPerHour !== input.maxPriceUsdPerHour) {
    throw new Error("Order plan does not match the selected server or price.");
  }
  if (input.queuedJobCount <= 0) {
    throw new Error("At least one queued prompt is required before preparing a GPU session.");
  }
  if (input.queuedJobCount !== stored.confirmedTaskIds.length) {
    throw new Error("确认任务数与一次性租用计划不一致。");
  }
  if (input.riskAccepted !== true) {
    throw new Error("请先确认 GPU 租用和持续计费风险。");
  }
  const requiredText = expectedConfirmationText({
    serverId: stored.serverId,
    basePriceUsdPerHour: stored.maxPriceUsdPerHour,
    effectivePriceUsdPerHour: stored.effectivePriceUsdPerHour,
    creationFeeUsd: stored.creationFeeUsd,
    projectedTotalUsd: stored.projectedTotalUsd,
  });
  if (input.confirmationText?.trim() !== requiredText) {
    throw new Error("确认文字必须与服务器和价格计划完全一致。");
  }
  const pool = readGenerationPool();
  const binding = pool.execution.activeExecution;
  if (
    pool.execution.activity !== "searching"
    || !binding
    || binding.generationFamily !== stored.generationFamily
    || binding.gpuClass !== stored.gpuClass
    || binding.confirmedTaskIds.length !== stored.confirmedTaskIds.length
    || binding.confirmedTaskIds.some((id) => !stored.confirmedTaskIds.includes(id))
  ) {
    throw new Error("当前执行队列已改变，请重新生成一次性租用计划。");
  }

  nonces[index] = { ...stored, usedAt: now.toISOString() };
  writeNonceStore(nonces);

  const execution = loadCloreExecutionConfig();
  if (!execution.enabled) {
    return {
      order_created: false,
      create_order_called: false,
      status: "blocked_by_environment",
      message: "CLORE_ORDER_EXECUTION_ENABLED=false, so real Clore order creation is blocked.",
    };
  }

  const { createCloreOrder, prepareCreateOrderFromLive } = await import("../../../scripts/clore/order-execution");
  const prepared = await prepareCreateOrderFromLive({
    config: loadCloreConfig(),
    execution,
    serverId: input.serverId,
    maxPriceUsdPerHour: input.maxPriceUsdPerHour,
    queuedJobCount: input.queuedJobCount,
  });
  const result = await createCloreOrder({
    config: loadCloreConfig(),
    execution,
    candidate: prepared.candidate,
    requestBody: prepared.requestBody,
  });
  if (result.order_created && result.order_id) {
    recordConfirmedQueueRentalSuccess({
      providerOrderId: result.order_id,
      runtimeSessionId: `clore-order-${result.order_id}`,
      gpuClass: stored.gpuClass,
    });
  }
  return result;
}

export function stopLocalLabSessionDryRun() {
  return {
    dry_run: true,
    cancel_order_called: false,
    state: stopSessionDryRun(),
  };
}
