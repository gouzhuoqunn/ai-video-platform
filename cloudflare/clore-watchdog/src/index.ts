type Env = {
  CLORE_API_KEY: string;
  WATCHDOG_STATE: R2Bucket;
};

type R2ObjectBody = {
  text(): Promise<string>;
};

type R2Bucket = {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
};

type ScheduledEvent = Record<string, never>;
type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

type WatchdogOrder = {
  orderId: string | null;
  serverId: string | null;
  status: string | null;
  active: boolean;
};

type WatchdogArmState = {
  schemaVersion: 1;
  armed: boolean;
  sessionNonce: string;
  serverId: string;
  orderType: "on-demand";
  currency: "USD-Blockchain";
  startingBalanceUsd: number;
  armedAt: string;
  drainingAt: string;
  hardDeadlineAt: string;
  hardBudgetUsd: number;
  budgetSafetyUsd: number;
  emergencyStop: boolean;
  lastCancelReason?: string;
  lastCancelOrderId?: string;
  canceledAt?: string;
};

const CLORE_API_BASE = "https://api.clore.ai/v1";
const STATE_KEY = "active-session.json";
const HEARTBEAT_KEY = "heartbeat.json";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

async function cloreRequest(env: Env, endpoint: string, init: RequestInit = {}) {
  const response = await fetch(`${CLORE_API_BASE}${endpoint}`, {
    ...init,
    headers: {
      auth: env.CLORE_API_KEY,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (payload.code !== 0) {
    throw new Error(`Clore API failed with code ${String(payload.code ?? "unknown")}`);
  }
  return "data" in payload ? payload.data : payload;
}

function summarizeOrdersPayload(data: unknown): WatchdogOrder[] {
  const record = asRecord(data);
  const orders = Array.isArray(record.orders) ? record.orders : Array.isArray(data) ? data : [];
  return orders.map((order) => {
    const value = asRecord(order);
    const status = firstString(value, ["status", "state"]);
    const statusText = (status ?? "").toLowerCase();
    return {
      orderId: firstString(value, ["id", "order_id"]),
      serverId: firstString(value, ["server_id", "renting_server"]),
      status,
      active: statusText ? !/(cancel|complete|stop|stopped|expire|expired|finish|finished|end|ended)/i.test(statusText) : true,
    };
  });
}

function summarizeWalletPayload(data: unknown) {
  const record = asRecord(data);
  const wallets = Array.isArray(record.wallets) ? record.wallets : Array.isArray(data) ? data : [];
  const direct = firstNumber(record, ["usd", "usd_balance", "balance_usd", "available_usd"]);
  if (direct !== null) return { availableUsdBalance: direct };
  for (const wallet of wallets) {
    const value = asRecord(wallet);
    const name = firstString(value, ["name", "currency", "wallet", "type"]) ?? "";
    const currency = firstString(value, ["currency", "ticker", "symbol"]) ?? "";
    if (/usd/i.test(name) || /usd/i.test(currency)) {
      return { availableUsdBalance: firstNumber(value, ["balance", "available", "amount", "value"]) };
    }
  }
  return { availableUsdBalance: null };
}

function parseState(text: string | null): WatchdogArmState | null {
  if (!text) return null;
  const parsed = JSON.parse(text) as WatchdogArmState;
  if (parsed.schemaVersion !== 1 || parsed.orderType !== "on-demand" || parsed.currency !== "USD-Blockchain") {
    throw new Error("Invalid watchdog state.");
  }
  return parsed;
}

function evaluate(input: { state: WatchdogArmState | null; orders: WatchdogOrder[]; wallet: { availableUsdBalance: number | null }; now: Date }) {
  if (!input.state?.armed) return { action: "readonly", reason: "not_armed" as const };
  const active = input.orders.filter((order) => order.active);
  if (active.length === 0) return { action: "readonly", reason: "no_active_order" as const };
  if (active.length > 1) return { action: "readonly", reason: "multiple_active_orders" as const };
  const order = active[0];
  if (order.serverId !== input.state.serverId) return { action: "readonly", reason: "wrong_server_id" as const };
  if (!order.orderId) return { action: "readonly", reason: "order_missing_id" as const };
  const spentUsd = input.wallet.availableUsdBalance === null ? null : input.state.startingBalanceUsd - input.wallet.availableUsdBalance;
  if (input.state.emergencyStop) return { action: "cancel", reason: "emergency_stop" as const, orderId: order.orderId, spentUsd };
  if (input.now.getTime() >= Date.parse(input.state.hardDeadlineAt)) return { action: "cancel", reason: "hard_deadline" as const, orderId: order.orderId, spentUsd };
  if (spentUsd !== null && spentUsd >= input.state.hardBudgetUsd - input.state.budgetSafetyUsd) {
    return { action: "cancel", reason: "hard_budget" as const, orderId: order.orderId, spentUsd };
  }
  return { action: "continue", reason: "within_limits" as const, orderId: order.orderId, spentUsd };
}

type WorkerDecision = ReturnType<typeof evaluate> | { action: "readonly"; reason: "api_unavailable" };

async function tick(env: Env) {
  const now = new Date();
  let state: WatchdogArmState | null = null;
  let orders: WatchdogOrder[] = [];
  let wallet = { availableUsdBalance: null as number | null };
  let decision: WorkerDecision = { action: "readonly", reason: "not_armed" };
  let cancelCalled = false;

  try {
    const storedState = await env.WATCHDOG_STATE.get(STATE_KEY);
    state = parseState(storedState ? await storedState.text() : null);
    orders = summarizeOrdersPayload(await cloreRequest(env, "/my_orders"));
    wallet = summarizeWalletPayload(await cloreRequest(env, "/wallets"));
    decision = evaluate({ state, orders, wallet, now });
    if (decision.action === "cancel") {
      await cloreRequest(env, "/cancel_order", {
        method: "POST",
        body: JSON.stringify({ id: decision.orderId, issue: `watchdog_${decision.reason}` }),
      });
      cancelCalled = true;
      if (state) {
        state.lastCancelReason = decision.reason;
        state.lastCancelOrderId = decision.orderId;
        state.canceledAt = now.toISOString();
        await env.WATCHDOG_STATE.put(STATE_KEY, JSON.stringify(state, null, 2), { httpMetadata: { contentType: "application/json" } });
      }
    }
  } catch {
    decision = { action: "readonly", reason: "api_unavailable" };
  }

  if (cancelCalled) {
    try {
      orders = summarizeOrdersPayload(await cloreRequest(env, "/my_orders"));
    } catch {
      // The next cron will retry the readback.
    }
  }

  const heartbeat = {
    checked_at: now.toISOString(),
    armed: Boolean(state?.armed),
    server_id: state?.serverId ?? null,
    active_order_count: orders.filter((order) => order.active).length,
    decision: decision.action,
    reason: decision.reason,
    cancel_called: cancelCalled,
    sensitive_fields_included: false,
  };
  await env.WATCHDOG_STATE.put(HEARTBEAT_KEY, JSON.stringify(heartbeat, null, 2), { httpMetadata: { contentType: "application/json" } });
}

const worker = {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(tick(env));
  },
  async fetch() {
    return new Response("not found", { status: 404 });
  },
};

export default worker;
