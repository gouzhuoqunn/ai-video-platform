import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { cloreRequest, sleep } from "./client";
import { loadCloreConfig } from "./config";
import { clearManualParitySecrets, consumePasswordFallbackAttempt, ensureManualParityAskpass, MANUAL_PARITY_NODE_PRELOAD_PATH, MANUAL_PARITY_STATE_PATH, passwordFallbackAvailableForOrder, readManualParityState, updateManualParityState } from "./manual-parity";
import { orderRecords, parseCloreOrder, readinessIssue, type CloreReadinessIssue } from "./order-readiness-parser";
import { readActiveOrder, writeActiveOrder } from "./order-state";
import { buildSshArgs, type SshTarget } from "./ssh-client";
import { awaitOrderSshReadiness, prepareOrderKnownHostsPath, type CloreSshReadinessClassification } from "./ssh-readiness-policy";
import { FIXED_RUNTIME_DIGEST } from "../gpu-providers/common";
import { ensureValidatedProjectSshKey } from "./ssh-key-validation";

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
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT", ok: result.status === 0, authFailed: /permission denied|authentication failed|publickey|number of password prompts exceeded/i.test(output) };
}

function refreshEphemeralProxyKnownHost(target: SshTarget, knownHostsPath: string) {
  const endpoint = `[${target.host}]:${target.port}`;
  spawnSync("ssh-keygen", ["-R", endpoint, "-f", knownHostsPath], { encoding: "utf8", timeout: 15_000, stdio: "pipe" });
}

function keySsh(target: SshTarget, command: string, knownHostsPath: string) {
  return authResult(spawnSync("ssh", buildSshArgs(target, command, { knownHostsPath, connectTimeoutSeconds: 15 }), { encoding: "utf8", timeout: 20_000, stdio: "pipe" }));
}

function passwordSsh(target: SshTarget, command: string, knownHostsPath: string) {
  const askpass = ensureManualParityAskpass();
  const args = ["-o", `UserKnownHostsFile=${knownHostsPath}`, "-o", "StrictHostKeyChecking=accept-new", "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no", "-o", "IdentityAgent=none", "-o", "NumberOfPasswordPrompts=1", "-o", "ConnectTimeout=15", "-T", "-p", String(target.port), `${target.user}@${target.host}`, command];
  const env: NodeJS.ProcessEnv = { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "stage3r", CLORE_MANUAL_PARITY_STATE_PATH: MANUAL_PARITY_STATE_PATH };
  if (process.platform === "win32") env.NODE_OPTIONS = `--require=${MANUAL_PARITY_NODE_PRELOAD_PATH}`;
  return authResult(spawnSync("ssh", args, { encoding: "utf8", timeout: 20_000, stdio: "pipe", env }));
}

function shellQuote(value: string) { return `'${value.replace(/'/g, `'"'"'`)}'`; }

export function projectKeyInstallCommand() {
  const publicKey = ensureValidatedProjectSshKey().normalizedPublicKey;
  const quoted = shellQuote(publicKey);
  return `set -e; umask 077; mkdir -p /root/.ssh; touch /root/.ssh/authorized_keys; grep -qxF ${quoted} /root/.ssh/authorized_keys || printf '%s\\n' ${quoted} >> /root/.ssh/authorized_keys; chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys`;
}

async function main() {
  const orderId = getArg("order-id"); if (!orderId) throw new Error("clore:readiness requires --order-id=<id>.");
  const requestedTimeout = Number(getArg("timeout-minutes") ?? 10);
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0 || requestedTimeout > 10) throw new Error("clore:readiness --timeout-minutes must be between 1 and 10.");
  const startedAt = Date.now(); const deadline = startedAt + requestedTimeout * 60_000; const config = loadCloreConfig();
  const knownHostsPath = prepareOrderKnownHostsPath(orderId);
  let latest = null as ReturnType<typeof parseCloreOrder> | null; let tcpReached = false; let passwordAuthSucceeded = false; let keyInstalled = false; let keyAuthSucceeded = false; let authFailed = false; let issue: CloreReadinessIssue = "order_not_deployed";
  let preparedEndpoint: string | null = null;
  let sshClassification: CloreSshReadinessClassification | null = null;
  let keyAttempts = 0;
  let keyReadinessDurationMs = 0;
  let passwordFallbackAttempted = false;

  async function readLatest() {
    const raw = orderRecords(await cloreRequest<unknown>(config, "/my_orders", {}, { forceRefresh: true })).find((item) => String(item.id ?? item.order_id) === orderId);
    latest = raw ? parseCloreOrder(raw) : null;
    return latest;
  }

  while (Date.now() < deadline) {
    await readLatest();
    if (latest?.terminal) break;
    if (latest) {
      issue = readinessIssue(latest, { tcpReached, authSucceeded: keyAuthSucceeded, authFailed });
      // The provider may retain the textual "deploying" status after it has
      // published a live SSH endpoint. TCP plus project-key authentication is
      // stronger evidence than that lagging status field.
      if (latest.active && latest.ssh) {
        let sshTarget = latest.ssh;
        const endpoint = `${sshTarget.host}:${sshTarget.port}`;
        if (preparedEndpoint !== endpoint) { refreshEphemeralProxyKnownHost(sshTarget, knownHostsPath); preparedEndpoint = endpoint; }
        tcpReached = await tcpReachable(sshTarget);
        if (tcpReached) {
          const fallback = readManualParityState();
          const readiness = await awaitOrderSshReadiness({
            knownHostsPath,
            windowMs: Math.min(120_000, Math.max(1, deadline - Date.now())),
            readProviderState: async () => {
              const current = await readLatest();
              return { deploymentReady: Boolean(current?.active && current?.ssh), target: current?.ssh ?? null };
            },
            tcpProbe: tcpReachable,
            keyProbe: async (target, scopedPath) => keySsh(target, "true", scopedPath),
            refreshKnownHost: (target, scopedPath) => refreshEphemeralProxyKnownHost(target, scopedPath),
          });
          keyAttempts = readiness.attempts;
          keyReadinessDurationMs = readiness.durationMs;
          sshClassification = readiness.classification;
          keyAuthSucceeded = readiness.ready;
          tcpReached = readiness.classification !== "ssh_tcp_not_ready";
          if (readiness.target) {
            sshTarget = readiness.target;
            latest = latest ? { ...latest, ssh: readiness.target } : latest;
          }
          if (!keyAuthSucceeded && passwordFallbackAvailableForOrder(fallback, orderId)) {
            consumePasswordFallbackAttempt(orderId);
            passwordFallbackAttempted = true;
            const password = passwordSsh(sshTarget, projectKeyInstallCommand(), knownHostsPath);
            passwordAuthSucceeded = password.ok;
            if (password.ok) {
              keyInstalled = true;
              const key = keySsh(sshTarget, "true", knownHostsPath);
              keyAuthSucceeded = key.ok;
              if (key.ok) sshClassification = "ssh_ready";
            }
          }
          authFailed = !keyAuthSucceeded;
          issue = readinessIssue(latest, { tcpReached, authSucceeded: keyAuthSucceeded, authFailed });
          if (issue === "ssh_ready") {
            if (fallback) updateManualParityState({ orderId, sshHost: sshTarget.host, sshPort: sshTarget.port, passwordAuthSucceeded, keyInstalled, keyAuthSucceeded });
            const targetPath = path.join(process.cwd(), ".secrets", "clore-ssh-target.json"); mkdirSync(path.dirname(targetPath), { recursive: true }); const active = readActiveOrder();
            const identity = ensureValidatedProjectSshKey();
            writeFileSync(targetPath, `${JSON.stringify({ order_id: orderId, ...sshTarget, username: sshTarget.user, gpuProfile: active?.gpu_profile ?? "rtx4090", runtimeDigest: FIXED_RUNTIME_DIGEST, knownHostsPath, sshCredentialSource: "canonical_clore_project_key", sshIdentityFingerprint: identity.fingerprint, ssh_auth: { passwordAuthSucceeded, keyInstalled, keyAuthSucceeded, classification: "ssh_ready", attempts: keyAttempts || 1, readinessDurationMs: keyReadinessDurationMs }, updated_at: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
            if (active) writeActiveOrder({ ...active, status: "ready" });
            if (fallback) clearManualParitySecrets();
            console.log(JSON.stringify({ ready: true, issue: "ssh_ready", order_id: orderId, deployment_state: latest.deploymentState, lifecycle_status: latest.lifecycleStatus, ssh_host: sshTarget.host, ssh_port: sshTarget.port, ssh_source: latest.sshSource, password_auth_succeeded: passwordAuthSucceeded, key_installed: keyInstalled, key_auth_succeeded: keyAuthSucceeded, ssh_attempts: keyAttempts || 1, key_readiness_seconds: Math.round(keyReadinessDurationMs / 1000), order_scoped_known_hosts: true, elapsed_seconds: Math.round((Date.now() - startedAt) / 1000), secrets_printed: false }, null, 2));
            return;
          }
          if ((!fallback || passwordFallbackAttempted) && sshClassification) break;
        }
      }
    }
    await sleep(10_000);
  }
  issue = readinessIssue(latest, { tcpReached, authSucceeded: keyAuthSucceeded, authFailed });
  console.log(JSON.stringify({ ready: false, issue: sshClassification ?? issue, order_id: orderId, lifecycle_status: latest?.lifecycleStatus ?? "missing", deployment_state: latest?.deploymentState ?? "unknown", endpoint_published: Boolean(latest?.ssh), ssh_tcp_reachable: tcpReached, password_auth_succeeded: passwordAuthSucceeded, key_installed: keyInstalled, key_auth_succeeded: keyAuthSucceeded, ssh_attempts: keyAttempts, key_readiness_seconds: Math.round(keyReadinessDurationMs / 1000), order_scoped_known_hosts: true, elapsed_seconds: Math.round((Date.now() - startedAt) / 1000), secrets_printed: false }, null, 2));
  process.exitCode = 2;
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "order readiness failed"); process.exitCode = 1; });
