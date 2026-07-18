import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { GpuTarget } from "./types";
import { deriveCanonicalSshIdentity } from "../clore/ssh-identity";
import { getPrivateKeyPath } from "../clore/ssh-client";

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

function resolvedTransportIdentity(target: GpuTarget) {
  if (target.provider !== "clore" || target.sshCredentialSource !== "canonical_clore_project_key") {
    return target.sshKeyPath;
  }
  const identity = deriveCanonicalSshIdentity(getPrivateKeyPath());
  if (
    path.resolve(target.sshKeyPath) !== identity.privateKeyPath ||
    target.sshIdentityFingerprint !== identity.fingerprint
  ) {
    throw new Error("clore_ssh_target_identity_mismatch");
  }
  if (!target.knownHostsPath) throw new Error("clore_order_scoped_known_hosts_required");
  return identity.privateKeyPath;
}

function deterministicTransportOptions(target: GpuTarget) {
  return [
    ...(target.knownHostsPath ? ["-o", `UserKnownHostsFile=${target.knownHostsPath}`] : []),
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "PreferredAuthentications=publickey",
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
  ];
}

export function buildSshCommandArgs(target: GpuTarget, command: string) {
  return [
    "-i", resolvedTransportIdentity(target),
    ...deterministicTransportOptions(target),
    "-T",
    "-p", String(target.port),
    `${target.username}@${target.host}`,
    command,
  ];
}

export function buildScpToRemoteArgs(target: GpuTarget, localPath: string, remotePath: string) {
  return [
    "-i", resolvedTransportIdentity(target),
    ...deterministicTransportOptions(target),
    "-P", String(target.port),
    localPath,
    `${target.username}@${target.host}:${remotePath}`,
  ];
}

export function buildScpFromRemoteArgs(target: GpuTarget, remotePath: string, localPath: string) {
  return [
    "-i", resolvedTransportIdentity(target),
    ...deterministicTransportOptions(target),
    "-P", String(target.port),
    `${target.username}@${target.host}:${remotePath}`,
    localPath,
  ];
}

export function sshCommand(target: GpuTarget, command: string, timeoutMs = 60_000) {
  return spawnSync("ssh", buildSshCommandArgs(target, command), { encoding: "utf8", timeout: timeoutMs });
}

export function scpFile(target: GpuTarget, localPath: string, remotePath: string, timeoutMs = 120_000) {
  return spawnSync("scp", buildScpToRemoteArgs(target, localPath, remotePath), { encoding: "utf8", timeout: timeoutMs });
}

export function scpFromRemote(target: GpuTarget, remotePath: string, localPath: string, timeoutMs = 120_000) {
  if (!remotePath.startsWith("/workspace/") || /[\r\n]/.test(remotePath)) throw new Error("Refusing unsafe remote download path.");
  return spawnSync("scp", buildScpFromRemoteArgs(target, remotePath, localPath), { encoding: "utf8", timeout: timeoutMs });
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
