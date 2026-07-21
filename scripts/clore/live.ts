import { cloreRequest, type CloreRequestOptions } from "./client";
import type { CloreConfig, RawCloreServer, WalletSummary } from "./types";
import { parseCloreOrder } from "./order-readiness-parser";

export type MarketplacePayload = RawCloreServer[] | { servers?: RawCloreServer[]; marketplace?: RawCloreServer[]; data?: RawCloreServer[] };

export async function readLiveMarketplace(config: CloreConfig, options: CloreRequestOptions = {}) {
  const data = await cloreRequest<MarketplacePayload>(config, "/marketplace", {}, options);
  if (Array.isArray(data)) {
    return data;
  }
  return data.servers ?? data.marketplace ?? data.data ?? [];
}

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
