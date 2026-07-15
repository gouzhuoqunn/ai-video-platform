import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { spawnSync } from "node:child_process";
import type { GpuTarget } from "./types";

export const FIXED_RUNTIME_DIGEST = "ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime@sha256:187a7eb304075863dbd3f7a1b527530a06783ad8ea0fec5e51e2b9725d1bf137";

export function parseEnvFile(filePath: string) {
  const values = new Map<string, string>();
  if (!existsSync(filePath)) return values;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
  }
  return values;
}

export function sanitizeGpuTarget(target: GpuTarget) {
  return {
    provider: target.provider,
    host_suffix: target.host.split(".").slice(-2).join("."),
    port: target.port,
    username: target.username,
    gpu_profile: target.gpuProfile,
    runtime_digest_pinned: target.runtimeDigest.includes("@sha256:"),
    ssh_private_key_returned: false,
  };
}

export function assertGpuTarget(target: GpuTarget) {
  if (!target.host || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error("GpuTarget SSH endpoint is invalid.");
  if (!target.sshKeyPath || !existsSync(target.sshKeyPath)) throw new Error("GpuTarget SSH private key is unavailable.");
  if (!target.runtimeDigest.includes("@sha256:")) throw new Error("GpuTarget Runtime must use an immutable digest.");
  return target;
}

export function sshCommand(target: GpuTarget, command: string, timeoutMs = 60_000) {
  return spawnSync("ssh", [
    "-i", target.sshKeyPath,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "PasswordAuthentication=no",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-p", String(target.port),
    `${target.username}@${target.host}`,
    command,
  ], { encoding: "utf8", timeout: timeoutMs });
}

export function scpFile(target: GpuTarget, localPath: string, remotePath: string, timeoutMs = 120_000) {
  return spawnSync("scp", [
    "-i", target.sshKeyPath,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "PasswordAuthentication=no",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-P", String(target.port),
    localPath,
    `${target.username}@${target.host}:${remotePath}`,
  ], { encoding: "utf8", timeout: timeoutMs });
}

export async function tcpReachable(host: string, port: number, timeoutMs = 10_000) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
