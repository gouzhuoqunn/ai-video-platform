import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { cloreRequest, sleep } from "./client";
import { loadCloreConfig } from "./config";
import { clearManualParitySecrets, ensureManualParityAskpass, MANUAL_PARITY_NODE_PRELOAD_PATH, MANUAL_PARITY_STATE_PATH, readManualParityState, updateManualParityState } from "./manual-parity";
import { orderRecords, parseCloreOrder, readinessIssue, type CloreReadinessIssue } from "./order-readiness-parser";
import { readActiveOrder, writeActiveOrder } from "./order-state";
import { buildSshArgs, CLORE_KNOWN_HOSTS_PATH, getPublicKeyPath, type SshTarget } from "./ssh-client";
import { FIXED_RUNTIME_DIGEST } from "../gpu-providers/common";

function getArg(name: string) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function tcpReachable(target: SshTarget) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const done = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.setTimeout(5000, () => done(false)); socket.once("connect", () => done(true)); socket.once("error", () => done(false));
  });
}

function authResult(result: ReturnType<typeof spawnSync>) {
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return { ok: result.status === 0, authFailed: /permission denied|authentication failed|publickey|number of password prompts exceeded/i.test(output) };
}

function refreshEphemeralProxyKnownHost(target: SshTarget) {
  const endpoint = `[${target.host}]:${target.port}`;
  spawnSync("ssh-keygen", ["-R", endpoint, "-f", CLORE_KNOWN_HOSTS_PATH], { encoding: "utf8", timeout: 15_000, stdio: "pipe" });
}

function keySsh(target: SshTarget, command: string) {
  return authResult(spawnSync("ssh", buildSshArgs(target, command), { encoding: "utf8", timeout: 20_000, stdio: "pipe" }));
}

function passwordSsh(target: SshTarget, command: string) {
  const askpass = ensureManualParityAskpass();
  const args = ["-o", `UserKnownHostsFile=${CLORE_KNOWN_HOSTS_PATH}`, "-o", "StrictHostKeyChecking=accept-new", "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1", "-p", String(target.port), `${target.user}@${target.host}`, command];
  const env: NodeJS.ProcessEnv = { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "stage3r", CLORE_MANUAL_PARITY_STATE_PATH: MANUAL_PARITY_STATE_PATH };
  if (process.platform === "win32") env.NODE_OPTIONS = `--require=${MANUAL_PARITY_NODE_PRELOAD_PATH}`;
  return authResult(spawnSync("ssh", args, { encoding: "utf8", timeout: 20_000, stdio: "pipe", env }));
}

function shellQuote(value: string) { return `'${value.replace(/'/g, `'"'"'`)}'`; }

function projectKeyInstallCommand(configuredPublicKeyPath?: string) {
  const publicKeyPath = getPublicKeyPath(configuredPublicKeyPath); const publicKey = readFileSync(publicKeyPath, "utf8").split(/\r?\n/)[0].trim();
  if (!/^ssh-ed25519\s+[A-Za-z0-9+/=]+(?:\s+.*)?$/.test(publicKey)) throw new Error("configured_public_key_invalid");
  const quoted = shellQuote(publicKey);
  return `set -e; umask 077; mkdir -p /root/.ssh; touch /root/.ssh/authorized_keys; grep -qxF ${quoted} /root/.ssh/authorized_keys || printf '%s\\n' ${quoted} >> /root/.ssh/authorized_keys; chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys`;
}

async function main() {
  const orderId = getArg("order-id"); if (!orderId) throw new Error("clore:readiness requires --order-id=<id>.");
  const requestedTimeout = Number(getArg("timeout-minutes") ?? 10);
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0 || requestedTimeout > 10) throw new Error("clore:readiness --timeout-minutes must be between 1 and 10.");
  const startedAt = Date.now(); const deadline = startedAt + requestedTimeout * 60_000; const config = loadCloreConfig();
  let latest = null as ReturnType<typeof parseCloreOrder> | null; let tcpReached = false; let passwordAuthSucceeded = false; let keyInstalled = false; let keyAuthSucceeded = false; let authFailed = false; let issue: CloreReadinessIssue = "order_not_deployed";
  let preparedEndpoint: string | null = null;

  while (Date.now() < deadline) {
    const raw = orderRecords(await cloreRequest<unknown>(config, "/my_orders", {}, { forceRefresh: true })).find((item) => String(item.id ?? item.order_id) === orderId);
    latest = raw ? parseCloreOrder(raw) : null;
    if (latest?.terminal) break;
    if (latest) {
      issue = readinessIssue(latest, { tcpReached, authSucceeded: keyAuthSucceeded, authFailed });
      if (latest.deploymentReady && latest.ssh) {
        const endpoint = `${latest.ssh.host}:${latest.ssh.port}`;
        if (preparedEndpoint !== endpoint) { refreshEphemeralProxyKnownHost(latest.ssh); preparedEndpoint = endpoint; }
        tcpReached = await tcpReachable(latest.ssh);
        if (tcpReached) {
          const parity = readManualParityState();
          if (parity && parity.serverId === latest.serverId && (!parity.orderId || parity.orderId === orderId)) {
            const password = passwordSsh(latest.ssh, "true"); passwordAuthSucceeded = password.ok;
            if (password.ok) {
              const installed = passwordSsh(latest.ssh, projectKeyInstallCommand(config.sshPublicKeyPath)); keyInstalled = installed.ok;
              if (installed.ok) { const key = keySsh(latest.ssh, "true"); keyAuthSucceeded = key.ok; }
            } else {
              const existingKey = keySsh(latest.ssh, "true");
              if (existingKey.ok) {
                const installed = keySsh(latest.ssh, projectKeyInstallCommand(config.sshPublicKeyPath)); keyInstalled = installed.ok;
                if (installed.ok) { const key = keySsh(latest.ssh, "true"); keyAuthSucceeded = key.ok; }
              }
            }
            authFailed = !keyAuthSucceeded;
          } else {
            const key = keySsh(latest.ssh, "true"); keyAuthSucceeded = key.ok; authFailed = !key.ok;
          }
          issue = readinessIssue(latest, { tcpReached, authSucceeded: keyAuthSucceeded, authFailed });
          if (issue === "ssh_ready") {
            if (parity) updateManualParityState({ orderId, sshHost: latest.ssh.host, sshPort: latest.ssh.port, passwordAuthSucceeded, keyInstalled, keyAuthSucceeded });
            const targetPath = path.join(process.cwd(), ".secrets", "clore-ssh-target.json"); mkdirSync(path.dirname(targetPath), { recursive: true }); const active = readActiveOrder();
            writeFileSync(targetPath, `${JSON.stringify({ order_id: orderId, ...latest.ssh, username: latest.ssh.user, gpuProfile: active?.gpu_profile ?? "rtx4090", runtimeDigest: FIXED_RUNTIME_DIGEST, ssh_auth: { passwordAuthSucceeded, keyInstalled, keyAuthSucceeded }, updated_at: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
            if (active) writeActiveOrder({ ...active, status: "ready" });
            if (parity) clearManualParitySecrets();
            console.log(JSON.stringify({ ready: true, issue, order_id: orderId, deployment_state: latest.deploymentState, lifecycle_status: latest.lifecycleStatus, ssh_host: latest.ssh.host, ssh_port: latest.ssh.port, ssh_source: latest.sshSource, password_auth_succeeded: passwordAuthSucceeded, key_installed: keyInstalled, key_auth_succeeded: keyAuthSucceeded, elapsed_seconds: Math.round((Date.now() - startedAt) / 1000), secrets_printed: false }, null, 2));
            return;
          }
        }
      }
    }
    await sleep(10_000);
  }
  issue = readinessIssue(latest, { tcpReached, authSucceeded: keyAuthSucceeded, authFailed });
  console.log(JSON.stringify({ ready: false, issue, order_id: orderId, lifecycle_status: latest?.lifecycleStatus ?? "missing", deployment_state: latest?.deploymentState ?? "unknown", endpoint_published: Boolean(latest?.ssh), ssh_tcp_reachable: tcpReached, password_auth_succeeded: passwordAuthSucceeded, key_installed: keyInstalled, key_auth_succeeded: keyAuthSucceeded, elapsed_seconds: Math.round((Date.now() - startedAt) / 1000), secrets_printed: false }, null, 2));
  process.exitCode = 2;
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "order readiness failed"); process.exitCode = 1; });
