import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MANUAL_PARITY_STATE_PATH = path.join(process.cwd(), ".secrets", "clore-manual-parity-session.json");
export const MANUAL_PARITY_ASKPASS_PATH = path.join(process.cwd(), ".secrets", "clore-manual-parity-askpass.sh");
export const MANUAL_PARITY_NODE_PRELOAD_PATH = path.join(process.cwd(), "scripts", "clore", "password-askpass-preload.cjs");

export type ManualParitySessionState = {
  schemaVersion: 1;
  serverId: string;
  orderId: string | null;
  createdAt: string;
  expiresAt: string;
  sshPassword: string;
  sshHost: string | null;
  sshPort: number | null;
  passwordAuthSucceeded: boolean;
  keyInstalled: boolean;
  keyAuthSucceeded: boolean;
};

export function generateStrongSshPassword() {
  return `S3r-${randomBytes(10).toString("hex")}Aa7`;
}

export function readManualParityState(filePath = MANUAL_PARITY_STATE_PATH) {
  if (!existsSync(filePath)) return null;
  const state = JSON.parse(readFileSync(filePath, "utf8")) as ManualParitySessionState;
  if (state.schemaVersion !== 1 || !/^\d+$/.test(state.serverId) || !/^[A-Za-z0-9+=.@/-]{20,32}$/.test(state.sshPassword) || Date.parse(state.expiresAt) <= Date.now()) throw new Error("manual_parity_state_invalid_or_expired");
  return state;
}

export function writeManualParityState(state: ManualParitySessionState, filePath = MANUAL_PARITY_STATE_PATH) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const partial = `${filePath}.${process.pid}.part`;
  writeFileSync(partial, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(partial, filePath);
  return state;
}

export function createManualParityState(serverId: string, filePath = MANUAL_PARITY_STATE_PATH) {
  const now = new Date();
  return writeManualParityState({ schemaVersion: 1, serverId, orderId: null, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 180 * 60_000).toISOString(), sshPassword: generateStrongSshPassword(), sshHost: null, sshPort: null, passwordAuthSucceeded: false, keyInstalled: false, keyAuthSucceeded: false }, filePath);
}

export function updateManualParityState(update: Partial<Omit<ManualParitySessionState, "schemaVersion" | "sshPassword">>, filePath = MANUAL_PARITY_STATE_PATH) {
  const state = readManualParityState(filePath); if (!state) throw new Error("manual_parity_state_missing");
  return writeManualParityState({ ...state, ...update }, filePath);
}

export function ensureManualParityAskpass() {
  if (process.platform === "win32") return process.execPath;
  mkdirSync(path.dirname(MANUAL_PARITY_ASKPASS_PATH), { recursive: true });
  const body = `#!/bin/sh\nexec "${process.execPath}" --require "${MANUAL_PARITY_NODE_PRELOAD_PATH}"\n`;
  writeFileSync(MANUAL_PARITY_ASKPASS_PATH, body, { encoding: "utf8", mode: 0o700 });
  return MANUAL_PARITY_ASKPASS_PATH;
}

export function clearManualParitySecrets() {
  rmSync(MANUAL_PARITY_STATE_PATH, { force: true });
  rmSync(MANUAL_PARITY_ASKPASS_PATH, { force: true });
}
