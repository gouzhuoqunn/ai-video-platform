import {
  CloreApiError,
  CloreRateLimitError,
  CloreResponseError,
  cloreRequest,
  type CloreRequestOptions,
  type CloreResponseEvidence,
} from "./client";
import { createHash } from "node:crypto";
import type { CloreConfig, RawCloreServer, WalletSummary } from "./types";
import { parseCloreOrder } from "./order-readiness-parser";

export type MarketplacePayload = RawCloreServer[] | { servers?: RawCloreServer[]; marketplace?: RawCloreServer[]; data?: RawCloreServer[] };

export type MarketplaceReadClassification =
  | "success_nonempty"
  | "success_empty"
  | "rate_limited"
  | "authentication_failed"
  | "transport_failed"
  | "invalid_json"
  | "schema_incompatible"
  | "provider_error";

export type MarketplaceFilterCounts = {
  totalProviderListings: number;
  exactRtx4090Listings: number;
  rentableRtx4090Listings: number;
  onDemandRtx4090Listings: number;
  priceCompliantListings: number;
  hardwareDeploymentCompliantListings: number;
  fullyCompliantCandidates: number;
  rejectionCounts: Record<string, number>;
};

export type MarketplaceReadEvidence = CloreResponseEvidence & {
  selectedListField: "array" | "servers" | "marketplace" | "data" | null;
  rawListingCount: number | null;
  classification: MarketplaceReadClassification;
  filterCounts?: MarketplaceFilterCounts;
};

export type MarketplaceReadOutcome = {
  classification: MarketplaceReadClassification;
  servers: RawCloreServer[];
  evidence: MarketplaceReadEvidence;
  error: { message: string; httpStatus: number | null; code: number | null } | null;
};

export class MarketplaceReadError extends Error {
  readonly outcome: MarketplaceReadOutcome;
  constructor(outcome: MarketplaceReadOutcome) {
    super(outcome.error?.message ?? `marketplace_read_${outcome.classification}`);
    this.name = "MarketplaceReadError";
    this.outcome = outcome;
  }
}

function responseEvidenceFallback(value: unknown): CloreResponseEvidence {
  if (value === null || value === undefined) {
    return {
      endpoint: "/marketplace",
      method: "GET",
      capturedAt: new Date().toISOString(),
      httpStatus: 0,
      contentType: null,
      responseByteLength: 0,
      bodySha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      responseKind: "non_json",
      topLevelType: "unknown",
      topLevelKeys: [],
      sanitizedPrefix: "",
    };
  }
  const body = Buffer.from(JSON.stringify(value));
  const topLevelKeys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).slice(0, 32)
    : [];
  return {
    endpoint: "/marketplace",
    method: "GET",
    capturedAt: new Date().toISOString(),
    httpStatus: 200,
    contentType: "application/json",
    responseByteLength: body.byteLength,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    responseKind: "json",
    topLevelType: Array.isArray(value) ? "array" : value === null ? "null" : typeof value === "object" ? "object" : "unknown",
    topLevelKeys,
    sanitizedPrefix: "",
  };
}

function asServerList(value: unknown): RawCloreServer[] | null {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) return null;
  return value as RawCloreServer[];
}

/**
 * Parse only recognized marketplace envelopes.  A successful response with an
 * unknown shape is a schema failure, never an empty marketplace.
 */
export function parseMarketplacePayload(data: unknown): { servers: RawCloreServer[]; selectedListField: MarketplaceReadEvidence["selectedListField"] } {
  const direct = asServerList(data);
  if (direct) return { servers: direct, selectedListField: "array" };
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("marketplace_schema_incompatible");
  const record = data as Record<string, unknown>;
  for (const field of ["servers", "marketplace", "data"] as const) {
    if (!(field in record)) continue;
    const list = asServerList(record[field]);
    if (!list) throw new Error("marketplace_schema_incompatible");
    return { servers: list, selectedListField: field };
  }
  throw new Error("marketplace_schema_incompatible");
}

function errorFacts(error: unknown) {
  if (error instanceof CloreRateLimitError) return { classification: "rate_limited" as const, httpStatus: 429, code: error.failure.code, message: "Clore 请求受到速率限制。" };
  if (error instanceof CloreResponseError) {
    const classification = error.evidence.httpStatus === 401 || error.evidence.httpStatus === 403
      ? "authentication_failed" as const
      : error.classification;
    return { classification, httpStatus: error.evidence.httpStatus, code: null, message: error.message };
  }
  if (error instanceof CloreApiError) {
    const classification = error.failure.httpStatus === 401 || error.failure.httpStatus === 403
      ? "authentication_failed" as const
      : error.failure.code === 5 || error.failure.httpStatus === 429
        ? "rate_limited" as const
        : "provider_error" as const;
    return { classification, httpStatus: error.failure.httpStatus, code: error.failure.code, message: `Clore 市场请求失败（HTTP ${error.failure.httpStatus}）。` };
  }
  return { classification: "transport_failed" as const, httpStatus: null, code: null, message: "无法连接 Clore 市场，未将本次读取视为空市场。" };
}

export async function readLiveMarketplaceOutcome(config: CloreConfig, options: CloreRequestOptions = {}): Promise<MarketplaceReadOutcome> {
  let responseEvidence: CloreResponseEvidence | null = null;
  try {
    const data = await cloreRequest<MarketplacePayload>(config, "/marketplace", {}, {
      ...options,
      onResponse: async (evidence) => {
        responseEvidence = evidence;
        await options.onResponse?.(evidence);
      },
    });
    let parsed: { servers: RawCloreServer[]; selectedListField: MarketplaceReadEvidence["selectedListField"] };
    try {
      parsed = parseMarketplacePayload(data);
    } catch {
      const base = responseEvidence ?? responseEvidenceFallback(data);
      const evidence: MarketplaceReadEvidence = { ...base, selectedListField: null, rawListingCount: null, classification: "schema_incompatible" };
      return { classification: "schema_incompatible", servers: [], evidence, error: { message: "marketplace_schema_incompatible", httpStatus: base.httpStatus, code: null } };
    }
    const base = responseEvidence ?? responseEvidenceFallback(data);
    const classification = parsed.servers.length > 0 ? "success_nonempty" : "success_empty";
    const evidence: MarketplaceReadEvidence = { ...base, selectedListField: parsed.selectedListField, rawListingCount: parsed.servers.length, classification };
    return { classification, servers: parsed.servers, evidence, error: null };
  } catch (error) {
    const facts = errorFacts(error);
    const base = responseEvidence ?? {
      endpoint: "/marketplace",
      method: "GET",
      capturedAt: new Date().toISOString(),
      httpStatus: facts.httpStatus ?? 0,
      contentType: null,
      responseByteLength: 0,
      bodySha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      responseKind: "non_json" as const,
      topLevelType: "unknown" as const,
      topLevelKeys: [],
      sanitizedPrefix: "",
    };
    const evidence: MarketplaceReadEvidence = { ...base, selectedListField: null, rawListingCount: null, classification: facts.classification };
    return { classification: facts.classification, servers: [], evidence, error: { message: facts.message, httpStatus: facts.httpStatus, code: facts.code } };
  }
}

/** Strict compatibility wrapper for older read-only callers. */
export async function readLiveMarketplace(config: CloreConfig, options: CloreRequestOptions = {}) {
  const outcome = await readLiveMarketplaceOutcome(config, options);
  if (outcome.classification !== "success_nonempty" && outcome.classification !== "success_empty") throw new MarketplaceReadError(outcome);
  return outcome.servers;
}

/** Explicit name for new callers that need the typed result rather than a list. */
export const readLiveMarketplaceTyped = readLiveMarketplaceOutcome;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstNumber(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function firstString(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function summarizeWalletPayload(data: unknown): WalletSummary {
  const record = asRecord(data) ?? {};
  const rawWallets = Array.isArray(record.wallets) ? record.wallets : Array.isArray(data) ? data : [];
  const balances = rawWallets
    .map((wallet) => {
      const walletRecord = asRecord(wallet) ?? {};
      const name = firstString(walletRecord, ["name", "currency", "wallet", "type"]) ?? "unknown";
      const currency = firstString(walletRecord, ["currency", "ticker", "symbol"]) ?? name;
      const balance = firstNumber(walletRecord, ["balance", "available", "amount", "value"]);
      const isUsdLike = /usd/i.test(name) || /usd/i.test(currency ?? "");
      return { name, balance, currency, isUsdLike };
    })
    .filter((wallet) => wallet.balance !== null || wallet.name !== "unknown");

  const availableUsdBalance =
    firstNumber(record, ["usd", "usd_balance", "balance_usd", "available_usd"]) ??
    balances.find((wallet) => wallet.isUsdLike && wallet.balance !== null)?.balance ??
    null;

  return {
    balances,
    availableUsdBalance,
    source: availableUsdBalance === null ? "no direct USD balance field; no currency conversion performed" : "direct USD-like wallet/API field",
  };
}

export async function readWalletSummary(config: CloreConfig, options: CloreRequestOptions = {}) {
  const data = await cloreRequest<unknown>(config, "/wallets", {}, options);
  return summarizeWalletPayload(data);
}

export type CloreOrderSummary = {
  orderId: string | null;
  serverId: string | null;
  status: string | null;
  currency: string | null;
  price: number | null;
  fee: number | null;
  creationFee: number | null;
  spend: number | null;
  createdTimestamp: number | null;
  expired: boolean | null;
  active: boolean;
  deploymentState?: string;
  sshEndpointPublished?: boolean;
  startedAt?: string | null;
  sshHost?: string | null;
  sshPort?: number | null;
  controllerUrl?: string | null;
};

export function summarizeOrdersPayload(data: unknown): CloreOrderSummary[] {
  const record = asRecord(data) ?? {};
  const orders = Array.isArray(record.orders) ? record.orders : Array.isArray(data) ? data : [];
  return orders.map((order) => {
    const value = asRecord(order) ?? {};
    const parsed = parseCloreOrder(value); const status = firstString(value, ["status", "state"]) ?? null;
    return {
      orderId: firstString(value, ["id", "order_id"]) ?? null,
      serverId: firstString(value, ["server_id", "renting_server", "si"]) ?? null,
      status,
      currency: firstString(value, ["currency"]) ?? null,
      price: firstNumber(value, ["price"]),
      fee: firstNumber(value, ["fee"]),
      creationFee: firstNumber(value, ["creation_fee"]),
      spend: firstNumber(value, ["spend"]),
      createdTimestamp: firstNumber(value, ["ct"]),
      expired: typeof value.expired === "boolean" ? value.expired : null,
      active: parsed.active,
      deploymentState: parsed.deploymentState,
      sshEndpointPublished: Boolean(parsed.ssh),
      startedAt: firstString(value, ["started_at", "startedAt", "start_time"]) ?? null,
      sshHost: parsed.ssh?.host ?? null,
      sshPort: parsed.ssh?.port ?? null,
      controllerUrl: parsed.controllerUrl,
    };
  });
}

export async function readLiveOrdersSummary(config: CloreConfig, options: CloreRequestOptions = {}) {
  const data = await cloreRequest<unknown>(config, "/my_orders", {}, options);
  return summarizeOrdersPayload(data);
}
