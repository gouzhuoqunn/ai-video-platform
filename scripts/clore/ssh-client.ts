import { existsSync } from "node:fs";
import path from "node:path";

export const CLORE_KNOWN_HOSTS_PATH = path.join(process.cwd(), ".secrets", "clore-known-hosts");
const PRIVATE_KEY_NAME = "clore_ai_video_worker_ed25519";

export type SshTarget = {
  host: string;
  port: number;
  user: string;
};

export function getPrivateKeyPath() {
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".ssh", PRIVATE_KEY_NAME);
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
