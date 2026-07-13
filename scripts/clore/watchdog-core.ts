export const WATCHDOG_BUCKET = "ai-video-platform-clore-watchdog-state";
export const WATCHDOG_STATE_KEY = "active-session.json";
export const WATCHDOG_HEARTBEAT_KEY = "heartbeat.json";
export const LOCAL_WATCHDOG_ARM_PATH = ".secrets/clore-watchdog-arm.json";

export type WatchdogOrder = {
  orderId: string | null;
  serverId: string | null;
  status: string | null;
  active: boolean;
};

export type WatchdogWallet = {
  availableUsdBalance: number | null;
};

export type WatchdogArmState = {
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

export type WatchdogDecision =
  | {
      action: "readonly";
      reason: "not_armed" | "no_active_order" | "wrong_server_id" | "multiple_active_orders" | "order_missing_id" | "api_unavailable";
      shouldCancel: false;
    }
  | {
      action: "continue";
      reason: "within_limits";
      shouldCancel: false;
      activeOrderId: string;
      spentUsd: number | null;
      minutesSinceArm: number;
    }
  | {
      action: "cancel";
      reason: "hard_deadline" | "hard_budget" | "emergency_stop";
      shouldCancel: true;
      activeOrderId: string;
      spentUsd: number | null;
      minutesSinceArm: number;
    };

function asTimeMs(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid watchdog timestamp: ${value}`);
  }
  return parsed;
}

export function validateWatchdogArmState(value: WatchdogArmState) {
  if (value.schemaVersion !== 1) throw new Error("Unsupported watchdog state schema.");
  if (!value.sessionNonce || !/^[A-Za-z0-9_-]{16,}$/.test(value.sessionNonce)) throw new Error("Invalid watchdog session nonce.");
  if (!value.serverId || !/^\d+$/.test(value.serverId)) throw new Error("Invalid watchdog server id.");
  if (value.orderType !== "on-demand") throw new Error("Watchdog only supports on-demand orders.");
  if (value.currency !== "USD-Blockchain") throw new Error("Watchdog currency must be USD-Blockchain.");
  if (!Number.isFinite(value.startingBalanceUsd) || value.startingBalanceUsd < 0) throw new Error("Invalid starting balance.");
  if (!Number.isFinite(value.hardBudgetUsd) || value.hardBudgetUsd <= 0) throw new Error("Invalid hard budget.");
  if (!Number.isFinite(value.budgetSafetyUsd) || value.budgetSafetyUsd < 0) throw new Error("Invalid budget safety margin.");
  asTimeMs(value.armedAt);
  asTimeMs(value.drainingAt);
  asTimeMs(value.hardDeadlineAt);
}

export function evaluateWatchdog(input: {
  state: WatchdogArmState | null;
  orders: WatchdogOrder[];
  wallet: WatchdogWallet | null;
  now: Date;
  apiAvailable?: boolean;
}): WatchdogDecision {
  if (!input.apiAvailable && input.apiAvailable !== undefined) {
    return { action: "readonly", reason: "api_unavailable", shouldCancel: false };
  }
  if (!input.state?.armed) {
    return { action: "readonly", reason: "not_armed", shouldCancel: false };
  }

  validateWatchdogArmState(input.state);
  const activeOrders = input.orders.filter((order) => order.active);
  if (activeOrders.length === 0) {
    return { action: "readonly", reason: "no_active_order", shouldCancel: false };
  }
  if (activeOrders.length > 1) {
    return { action: "readonly", reason: "multiple_active_orders", shouldCancel: false };
  }

  const active = activeOrders[0];
  if (active.serverId !== input.state.serverId) {
    return { action: "readonly", reason: "wrong_server_id", shouldCancel: false };
  }
  if (!active.orderId) {
    return { action: "readonly", reason: "order_missing_id", shouldCancel: false };
  }

  const nowMs = input.now.getTime();
  const armedAtMs = asTimeMs(input.state.armedAt);
  const minutesSinceArm = Math.max(0, Math.floor((nowMs - armedAtMs) / 60000));
  const spentUsd =
    input.wallet?.availableUsdBalance === null || input.wallet?.availableUsdBalance === undefined
      ? null
      : Number((input.state.startingBalanceUsd - input.wallet.availableUsdBalance).toFixed(4));

  if (input.state.emergencyStop) {
    return { action: "cancel", reason: "emergency_stop", shouldCancel: true, activeOrderId: active.orderId, spentUsd, minutesSinceArm };
  }
  if (nowMs >= asTimeMs(input.state.hardDeadlineAt)) {
    return { action: "cancel", reason: "hard_deadline", shouldCancel: true, activeOrderId: active.orderId, spentUsd, minutesSinceArm };
  }
  if (spentUsd !== null && spentUsd >= input.state.hardBudgetUsd - input.state.budgetSafetyUsd) {
    return { action: "cancel", reason: "hard_budget", shouldCancel: true, activeOrderId: active.orderId, spentUsd, minutesSinceArm };
  }

  return { action: "continue", reason: "within_limits", shouldCancel: false, activeOrderId: active.orderId, spentUsd, minutesSinceArm };
}
