import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  LOCAL_WATCHDOG_ARM_PATH,
  WATCHDOG_BUCKET,
  WATCHDOG_HEARTBEAT_KEY,
  WATCHDOG_STATE_KEY,
  validateWatchdogArmState,
  type WatchdogArmState,
} from "./watchdog-core";

const WRANGLER_CONFIG = "cloudflare/clore-watchdog/wrangler.toml";
export const LOCAL_WATCHDOG_HEARTBEAT_PATH = path.join(process.cwd(), ".secrets", "clore-local-watchdog-heartbeat.json");
export const LOCAL_WATCHDOG_TASK_NAME = "AiVideoPlatformCloreWatchdog";
export const LOCAL_WATCHDOG_READY_PATH = path.join(process.cwd(), ".secrets", "clore-watchdog-ready.json");
type WatchdogReadyReceipt = { serverId: string; sessionNonce: string; checkedAt: string };

function secretsPath(relativePath: string) {
  return path.join(process.cwd(), relativePath);
}

function buildWranglerCommand(args: string[]) {
  return process.platform === "win32"
    ? { command: "cmd.exe", args: ["/c", "npx", "wrangler", ...args] }
    : { command: "npx", args: ["wrangler", ...args] };
}

function makeWranglerTempDir() {
  const baseDir = path.join(process.cwd(), ".secrets");
  mkdirSync(baseDir, { recursive: true });
  return mkdtempSync(path.join(baseDir, "clore-watchdog-"));
}

export function createSessionNonce() {
  return randomBytes(18).toString("base64url");
}

export function readLocalWatchdogArmState() {
  const filePath = secretsPath(LOCAL_WATCHDOG_ARM_PATH);
  if (!existsSync(filePath)) return null;
  const state = JSON.parse(readFileSync(filePath, "utf8")) as WatchdogArmState;
  validateWatchdogArmState(state);
  return state;
}

export function writeLocalWatchdogArmState(state: WatchdogArmState) {
  validateWatchdogArmState(state);
  const filePath = secretsPath(LOCAL_WATCHDOG_ARM_PATH);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function writeWatchdogReadyReceipt(receipt: WatchdogReadyReceipt) {
  mkdirSync(path.dirname(LOCAL_WATCHDOG_READY_PATH), { recursive: true });
  writeFileSync(LOCAL_WATCHDOG_READY_PATH, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

export function readWatchdogReadyReceipt(): WatchdogReadyReceipt | null {
  if (!existsSync(LOCAL_WATCHDOG_READY_PATH)) return null;
  try {
    const receipt = JSON.parse(readFileSync(LOCAL_WATCHDOG_READY_PATH, "utf8")) as Partial<WatchdogReadyReceipt>;
    if (!receipt.serverId || !receipt.sessionNonce || !receipt.checkedAt) return null;
    return { serverId: receipt.serverId, sessionNonce: receipt.sessionNonce, checkedAt: receipt.checkedAt };
  } catch { return null; }
}

function runWrangler(args: string[]) {
  const wrangler = buildWranglerCommand(args);
  let last: ReturnType<typeof spawnSync> | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = spawnSync(wrangler.command, wrangler.args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120000,
    });
    if (result.status === 0) return result.stdout;
    last = result;
    const message = `${result.stderr || result.stdout || result.error?.message || "wrangler failed"}`;
    if (!/fetch failed|network|connect/i.test(message)) break;
  }
  const spawnError = last?.error ? ` (${last.error.message})` : "";
  const message = `${last?.stderr || last?.stdout || "wrangler failed"}`.replace(/auth:\s*[A-Za-z0-9_-]+/gi, "auth:<redacted>");
  throw new Error(`${message.trim()}${spawnError}`.trim());
}

export function putRemoteWatchdogState(state: WatchdogArmState) {
  validateWatchdogArmState(state);
  const dir = makeWranglerTempDir();
  const file = path.join(dir, "active-session.json");
  try {
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    runWrangler([
      "r2",
      "object",
      "put",
      `${WATCHDOG_BUCKET}/${WATCHDOG_STATE_KEY}`,
      "--file",
      file,
      "--remote",
      "--content-type",
      "application/json",
      "--config",
      WRANGLER_CONFIG,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function getRemoteObjectJson<T>(key: string) {
  const dir = makeWranglerTempDir();
  const file = path.join(dir, "object.json");
  try {
    runWrangler(["r2", "object", "get", `${WATCHDOG_BUCKET}/${key}`, "--file", file, "--remote", "--config", WRANGLER_CONFIG]);
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readRemoteWatchdogArmState() {
  const state = getRemoteObjectJson<WatchdogArmState>(WATCHDOG_STATE_KEY);
  validateWatchdogArmState(state);
  return state;
}

export function readRemoteWatchdogHeartbeat() {
  return getRemoteObjectJson<{
    checked_at: string;
    armed: boolean;
    server_id: string | null;
    active_order_count: number;
    decision: string;
    reason: string;
    cancel_called: boolean;
  }>(WATCHDOG_HEARTBEAT_KEY);
}

export function isLocalWatchdogTaskInstalled() {
  if (process.platform !== "win32") return false;
  const result = spawnSync("schtasks.exe", ["/Query", "/TN", LOCAL_WATCHDOG_TASK_NAME], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
}

export function installLocalWatchdogTask() {
  if (process.platform !== "win32") {
    throw new Error("Local Clore watchdog scheduled task is currently implemented for Windows only.");
  }
  const scriptPath = path.join(process.cwd(), "scripts", "clore", "local-watchdog-hidden.vbs");
  const action = `wscript.exe //B //Nologo "${scriptPath}"`;
  const result = spawnSync(
    "schtasks.exe",
    ["/Create", "/F", "/SC", "MINUTE", "/MO", "1", "/TN", LOCAL_WATCHDOG_TASK_NAME, "/TR", action],
    { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to install local watchdog scheduled task.");
  }
}
