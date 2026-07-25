import { existsSync, readFileSync } from "node:fs";
import { LOCAL_WATCHDOG_HEARTBEAT_PATH, isLocalWatchdogTaskInstalled, readLocalWatchdogArmState, readRemoteWatchdogArmState, readRemoteWatchdogHeartbeat, readWatchdogReadyReceipt } from "./watchdog-io";

function assertRecent(timestamp: string | undefined, label: string) {
  if (!timestamp) throw new Error(`${label} heartbeat is missing.`);
  const ageMs = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 3 * 60 * 1000) {
    throw new Error(`${label} heartbeat is stale.`);
  }
}

function readLocalHeartbeat() {
  if (!existsSync(LOCAL_WATCHDOG_HEARTBEAT_PATH)) {
    throw new Error("Local watchdog heartbeat is missing.");
  }
  return JSON.parse(readFileSync(LOCAL_WATCHDOG_HEARTBEAT_PATH, "utf8")) as {
    checked_at?: string;
    api_available?: boolean;
    reason?: string;
  };
}

export function assertWatchdogsReadyForCreate(serverId: string) {
  if (!isLocalWatchdogTaskInstalled()) {
    throw new Error("Local Windows watchdog scheduled task is not installed.");
  }
  const localState = readLocalWatchdogArmState();
  if (!localState?.armed || localState.serverId !== serverId) {
    throw new Error("Local watchdog is not armed for the selected server.");
  }
  const localHeartbeat = readLocalHeartbeat();
  assertRecent(localHeartbeat.checked_at, "Local watchdog");
  if (localHeartbeat.api_available === false || localHeartbeat.reason === "api_unavailable") {
    throw new Error("Local watchdog is not healthy.");
  }
  // `arm` has already proven remote state + heartbeat and records the exact
  // nonce. Reuse that very short-lived proof so a transient R2 read cannot
  // invalidate the same order immediately before create_order.
  const receipt = readWatchdogReadyReceipt();
  if (receipt && receipt.serverId === serverId && receipt.sessionNonce === localState.sessionNonce) {
    assertRecent(receipt.checkedAt, "Watchdog readiness receipt");
    return;
  }
  const remoteState = readRemoteWatchdogArmState();
  if (!remoteState.armed || remoteState.serverId !== serverId) {
    throw new Error("Remote watchdog is not armed for the selected server.");
  }
  if (remoteState.sessionNonce !== localState.sessionNonce) {
    throw new Error("Remote and local watchdog nonces do not match.");
  }
  if (localState.currency !== "USD-Blockchain" || remoteState.currency !== "USD-Blockchain") {
    throw new Error("Watchdog currency must be USD-Blockchain.");
  }

  const remoteHeartbeat = readRemoteWatchdogHeartbeat();
  assertRecent(remoteHeartbeat.checked_at, "Remote watchdog");
  if (remoteHeartbeat.server_id !== serverId || remoteHeartbeat.reason === "api_unavailable") {
    throw new Error("Remote watchdog is not healthy for the selected server.");
  }
}
