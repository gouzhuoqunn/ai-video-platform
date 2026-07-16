import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadCloreConfig, PROJECT_TAG } from "./config";
import { assertNoSecretOutput } from "./client";
import { loadCloreExecutionConfig } from "./execution-config";
import { readLiveOrdersSummary, readWalletSummary } from "./live";
import {
  createSessionNonce,
  isLocalWatchdogTaskInstalled,
  putRemoteWatchdogState,
  readRemoteWatchdogArmState,
  readRemoteWatchdogHeartbeat,
  writeLocalWatchdogArmState,
} from "./watchdog-io";
import type { WatchdogArmState } from "./watchdog-core";

function getArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60000);
}

function buildNpmCommand(args: string[]) {
  return process.platform === "win32" ? { command: "cmd.exe", args: ["/c", "npm", ...args] } : { command: "npm", args };
}

async function waitForRemoteHeartbeat(serverId: string, armedAt: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const heartbeat = readRemoteWatchdogHeartbeat();
      if (heartbeat.server_id === serverId && Date.parse(heartbeat.checked_at) >= Date.parse(armedAt) && heartbeat.reason !== "api_unavailable") return heartbeat;
    } catch { /* The scheduled remote watchdog may not have published its first heartbeat yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error("Remote watchdog did not publish a fresh healthy heartbeat for the selected server within 90 seconds.");
}

async function arm() {
  const config = loadCloreConfig();
  const execution = loadCloreExecutionConfig();
  const serverId = getArg("server-id");
  if (!serverId || !/^\d+$/.test(serverId)) {
    throw new Error("watchdog:remote:arm requires --server-id=<numeric id>.");
  }
  if (config.rentalCurrency !== "USD-Blockchain") {
    throw new Error("CLORE_RENTAL_CURRENCY must be USD-Blockchain before arming the watchdog.");
  }
  if (!isLocalWatchdogTaskInstalled()) {
    throw new Error("Local Windows watchdog scheduled task is not installed.");
  }

  const forceRefresh = { forceRefresh: true };
  const liveOrders = await readLiveOrdersSummary(config, forceRefresh);
  if (liveOrders.some((order) => order.active)) {
    throw new Error("Refusing to arm watchdog while a live active Clore order already exists.");
  }
  const wallet = await readWalletSummary(config, forceRefresh);
  if (wallet.availableUsdBalance === null) {
    throw new Error("Could not read USD-like wallet balance for watchdog arm.");
  }

  const requestedDeadlineMinutes = Number(getArg("hard-deadline-minutes") ?? execution.hardSessionLimitMinutes);
  const requestedHardBudgetUsd = Number(getArg("hard-budget-usd") ?? execution.firstSessionMaxBudgetUsd);
  if (!Number.isFinite(requestedDeadlineMinutes) || requestedDeadlineMinutes <= 0 || requestedDeadlineMinutes > execution.hardSessionLimitMinutes) throw new Error("Watchdog hard deadline is invalid or exceeds the configured safety limit.");
  if (!Number.isFinite(requestedHardBudgetUsd) || requestedHardBudgetUsd <= 0 || requestedHardBudgetUsd > execution.firstSessionMaxBudgetUsd) throw new Error("Watchdog hard budget is invalid or exceeds the configured safety limit.");
  const now = new Date();
  const state: WatchdogArmState = {
    schemaVersion: 1,
    armed: true,
    sessionNonce: createSessionNonce(),
    serverId,
    orderType: "on-demand",
    currency: "USD-Blockchain",
    startingBalanceUsd: wallet.availableUsdBalance,
    armedAt: now.toISOString(),
    drainingAt: addMinutes(now, Math.max(1, requestedDeadlineMinutes - 10)).toISOString(),
    hardDeadlineAt: addMinutes(now, requestedDeadlineMinutes).toISOString(),
    hardBudgetUsd: requestedHardBudgetUsd,
    budgetSafetyUsd: 0.25,
    emergencyStop: false,
  };

  writeLocalWatchdogArmState(state);
  putRemoteWatchdogState(state);
  const tickCommand = buildNpmCommand(["run", "clore:watchdog:local:tick"]);
  const tick = spawnSync(tickCommand.command, tickCommand.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    timeout: 120000,
  });
  if (tick.status !== 0) {
    throw new Error("Remote watchdog armed, but local watchdog tick failed. Disarm before retrying.");
  }
  await waitForRemoteHeartbeat(state.serverId, state.armedAt);
  const output = JSON.stringify(
    {
      armed: true,
      project_tag: PROJECT_TAG,
      server_id: state.serverId,
      currency: state.currency,
      draining_at: state.drainingAt,
      hard_deadline_at: state.hardDeadlineAt,
      hard_budget_usd: state.hardBudgetUsd,
      local_watchdog_task_installed: true,
      secrets_printed: false,
    },
    null,
    2,
  );
  assertNoSecretOutput(output);
  console.log(output);
}

function status() {
  const remote = readRemoteWatchdogArmState();
  const heartbeat = (() => {
    try {
      return readRemoteWatchdogHeartbeat();
    } catch {
      return null;
    }
  })();
  const output = JSON.stringify(
    {
      remote_armed: remote.armed,
      server_id: remote.serverId,
      currency: remote.currency,
      hard_deadline_at: remote.hardDeadlineAt,
      hard_budget_usd: remote.hardBudgetUsd,
      heartbeat_checked_at: heartbeat?.checked_at ?? null,
      heartbeat_reason: heartbeat?.reason ?? null,
      heartbeat_cancel_called: heartbeat?.cancel_called ?? null,
      secrets_printed: false,
    },
    null,
    2,
  );
  assertNoSecretOutput(output);
  console.log(output);
}

function emergency() {
  const state = readRemoteWatchdogArmState();
  const next = { ...state, emergencyStop: true };
  writeLocalWatchdogArmState(next);
  putRemoteWatchdogState(next);
  const output = JSON.stringify({ emergency_stop_marked: true, server_id: next.serverId, secrets_printed: false }, null, 2);
  assertNoSecretOutput(output);
  console.log(output);
}

function disarm() {
  const state = readRemoteWatchdogArmState();
  const next = { ...state, armed: false, emergencyStop: false };
  writeLocalWatchdogArmState(next);
  putRemoteWatchdogState(next);
  writeFileSync(path.join(process.cwd(), ".secrets", "clore-watchdog-disarmed-at.txt"), `${new Date().toISOString()}\n`, "utf8");
  const output = JSON.stringify({ disarmed: true, server_id: next.serverId, secrets_printed: false }, null, 2);
  assertNoSecretOutput(output);
  console.log(output);
}

async function main() {
  const command = process.argv[2] ?? "status";
  if (command === "arm") await arm();
  else if (command === "status") status();
  else if (command === "emergency") emergency();
  else if (command === "disarm") disarm();
  else throw new Error("Usage: tsx scripts/clore/watchdog-remote.ts arm|status|emergency|disarm");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "remote watchdog command failed");
  process.exitCode = 1;
});
