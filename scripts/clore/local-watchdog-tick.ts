import { writeFileSync } from "node:fs";
import { loadCloreConfig } from "./config";
import { assertNoSecretOutput, cloreRequest } from "./client";
import { readLiveOrdersSummary, readWalletSummary } from "./live";
import { evaluateWatchdog, type WatchdogOrder } from "./watchdog-core";
import { LOCAL_WATCHDOG_HEARTBEAT_PATH, readLocalWatchdogArmState } from "./watchdog-io";

async function main() {
  const config = loadCloreConfig();
  const now = new Date();
  let orders: WatchdogOrder[] = [];
  let wallet = { availableUsdBalance: null as number | null };
  let decision = evaluateWatchdog({ state: null, orders, wallet, now });
  let cancelCalled = false;
  let apiAvailable = true;

  try {
    orders = await readLiveOrdersSummary(config);
    wallet = await readWalletSummary(config);
    decision = evaluateWatchdog({ state: readLocalWatchdogArmState(), orders, wallet, now });
    if (decision.shouldCancel) {
      await cloreRequest(config, "/cancel_order", {
        method: "POST",
        body: JSON.stringify({ id: decision.activeOrderId, issue: `local_watchdog_${decision.reason}` }),
      });
      cancelCalled = true;
      orders = await readLiveOrdersSummary(config);
    }
  } catch {
    apiAvailable = false;
    decision = evaluateWatchdog({ state: readLocalWatchdogArmState(), orders, wallet, now, apiAvailable: false });
  }

  const heartbeat = {
    checked_at: now.toISOString(),
    api_available: apiAvailable,
    active_order_count: orders.filter((order) => order.active).length,
    decision: decision.action,
    reason: decision.reason,
    cancel_called: cancelCalled,
    secrets_printed: false,
  };
  const output = JSON.stringify(heartbeat, null, 2);
  assertNoSecretOutput(output);
  writeFileSync(LOCAL_WATCHDOG_HEARTBEAT_PATH, `${output}\n`, "utf8");
  console.log(output);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "local watchdog tick failed");
  process.exitCode = 1;
});
