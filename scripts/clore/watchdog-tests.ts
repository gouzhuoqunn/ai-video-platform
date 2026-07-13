import { evaluateWatchdog, validateWatchdogArmState, type WatchdogArmState, type WatchdogOrder } from "./watchdog-core";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function state(overrides: Partial<WatchdogArmState> = {}): WatchdogArmState {
  const now = new Date("2026-07-13T00:00:00.000Z");
  return {
    schemaVersion: 1,
    armed: true,
    sessionNonce: "test_nonce_1234567890",
    serverId: "107713",
    orderType: "on-demand",
    currency: "USD-Blockchain",
    startingBalanceUsd: 15.55,
    armedAt: now.toISOString(),
    drainingAt: new Date(now.getTime() + 350 * 60000).toISOString(),
    hardDeadlineAt: new Date(now.getTime() + 380 * 60000).toISOString(),
    hardBudgetUsd: 4.5,
    budgetSafetyUsd: 0.25,
    emergencyStop: false,
    ...overrides,
  };
}

function order(overrides: Partial<WatchdogOrder> = {}): WatchdogOrder {
  return { orderId: "1947533", serverId: "107713", status: "running", active: true, ...overrides };
}

function decision(input: { state?: WatchdogArmState | null; orders?: WatchdogOrder[]; balance?: number | null; now?: Date; apiAvailable?: boolean }) {
  return evaluateWatchdog({
    state: input.state === undefined ? state() : input.state,
    orders: input.orders ?? [order()],
    wallet: { availableUsdBalance: input.balance ?? 15.55 },
    now: input.now ?? new Date("2026-07-13T01:00:00.000Z"),
    apiAvailable: input.apiAvailable,
  });
}

function main() {
  assert(decision({ state: null }).reason === "not_armed", "unarmed watchdog must never cancel");
  assert(decision({}).action === "continue", "normal session should continue");
  assert(decision({ now: new Date("2026-07-13T06:21:00.000Z") }).reason === "hard_deadline", "hard deadline should cancel");
  assert(decision({ balance: 11.3 }).reason === "hard_budget", "near hard budget should cancel");
  assert(decision({ apiAvailable: false }).reason === "api_unavailable", "API failure should be readonly retry");
  assert(decision({ orders: [order({ orderId: null })] }).reason === "order_missing_id", "missing create response/order id should not guess");
  assert(decision({ orders: [order(), order({ orderId: "other" })] }).reason === "multiple_active_orders", "multiple active orders must not auto-cancel");
  assert(decision({ orders: [order({ serverId: "95538" })] }).reason === "wrong_server_id", "wrong server id must not cancel");
  assert(decision({ state: state({ emergencyStop: true }) }).reason === "emergency_stop", "emergency stop should cancel");
  assert(decision({ state: state({ armed: false }) }).reason === "not_armed", "explicit unarmed state should be readonly");

  assert(
    (() => {
      try {
        validateWatchdogArmState(state({ currency: "USD" as "USD-Blockchain" }));
        return false;
      } catch {
        return true;
      }
    })(),
    "watchdog must reject ambiguous USD currency",
  );

  console.log("Clore watchdog mock tests passed. No create_order, cancel_order, SSH, or model download was called.");
}

main();
