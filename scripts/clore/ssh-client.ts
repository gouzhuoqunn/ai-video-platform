import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const CLORE_KNOWN_HOSTS_PATH = path.join(process.cwd(), ".secrets", "clore-known-hosts");
const PRIVATE_KEY_NAME = "clore_ai_video_worker_ed25519";
const PROJECT_KEY_OVERRIDE_PATH = path.join(process.cwd(), ".secrets", "clore-project-ssh-key.json");

export type SshTarget = {
  host: string;
  port: number;
  user: string;
};

export const SSH_READINESS_TIMEOUT_MS = 8 * 60 * 1000;
export const SSH_READINESS_POLL_INTERVAL_MS = 30 * 1000;
export const SSH_EARLY_RESET_FAILURES = 5;

export type SshReadinessFailureKind = "connection_reset" | "banner_timeout" | "timeout" | "other";

export function classifySshReadinessFailure(output: string): SshReadinessFailureKind {
  if (/connection reset|kex_exchange_identification/i.test(output)) return "connection_reset";
  if (/banner exchange|banner timeout/i.test(output)) return "banner_timeout";
  if (/timed out|timeout/i.test(output)) return "timeout";
  return "other";
}

export function shouldStopSshReadinessEarly(failures: SshReadinessFailureKind[]) {
  if (failures.length < SSH_EARLY_RESET_FAILURES) return false;
  return failures.slice(-SSH_EARLY_RESET_FAILURES).every((failure) => failure === "connection_reset");
}

export function getPrivateKeyPath() {
  if (existsSync(PROJECT_KEY_OVERRIDE_PATH)) {
    const value = JSON.parse(readFileSync(PROJECT_KEY_OVERRIDE_PATH, "utf8")) as { privateKeyPath?: string };
    if (value.privateKeyPath && existsSync(value.privateKeyPath)) return value.privateKeyPath;
  }
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".ssh", PRIVATE_KEY_NAME);
}

export function getPublicKeyPath(configuredPath?: string) {
  if (existsSync(PROJECT_KEY_OVERRIDE_PATH)) {
    const value = JSON.parse(readFileSync(PROJECT_KEY_OVERRIDE_PATH, "utf8")) as { publicKeyPath?: string };
    if (value.publicKeyPath && existsSync(value.publicKeyPath)) return value.publicKeyPath;
  }
  return configuredPath ?? `${getPrivateKeyPath()}.pub`;
}

export function buildSshArgs(target: SshTarget, command: string, options: { requirePrivateKey?: boolean } = {}) {
  const privateKeyPath = getPrivateKeyPath();
  if (options.requirePrivateKey !== false && !existsSync(privateKeyPath)) {
    throw new Error("Dedicated Clore SSH private key is missing.");
  }
  if (!target.host || !Number.isInteger(target.port) || target.port <= 0) {
    throw new Error("Invalid SSH target.");
  }
  if (command.includes("StrictHostKeyChecking=no")) {
    throw new Error("StrictHostKeyChecking=no is not allowed.");
  }
  return [
    "-i",
    privateKeyPath,
    "-o",
    `UserKnownHostsFile=${CLORE_KNOWN_HOSTS_PATH}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "PasswordAuthentication=no",
    "-p",
    String(target.port),
    `${target.user}@${target.host}`,
    command,
  ];
}

export function sanitizeSshTarget(target: SshTarget) {
  return {
    host_suffix: target.host.split(".").slice(-2).join("."),
    port: target.port,
    user: target.user,
    full_command_returned: false,
  };
}
