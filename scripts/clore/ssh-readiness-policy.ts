import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { SshTarget } from "./ssh-client";

export type CloreSshReadinessClassification =
  | "ssh_tcp_not_ready"
  | "ssh_host_key_changed"
  | "ssh_key_not_injected_yet"
  | "ssh_public_key_rejected"
  | "ssh_transport_timeout"
  | "ssh_ready";

export type SshProbeResult = { status: number | null; stdout?: string | null; stderr?: string | null; timedOut?: boolean };
export type ProviderSshState = { deploymentReady: boolean; target: SshTarget | null };

export const SSH_KEY_READINESS_WINDOW_MS = 120_000;
export const SSH_KEY_READINESS_BACKOFF_MS = [5_000, 10_000, 15_000, 20_000] as const;
export const CLORE_ORDER_KNOWN_HOSTS_DIR = path.join(process.cwd(), ".secrets", "clore-order-known-hosts");

export function orderKnownHostsPath(orderId: string) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(orderId)) throw new Error("clore_order_id_invalid_for_known_hosts");
  return path.join(CLORE_ORDER_KNOWN_HOSTS_DIR, `${orderId}.known_hosts`);
}

export function prepareOrderKnownHostsPath(orderId: string) {
  const filePath = orderKnownHostsPath(orderId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  return filePath;
}

export function cleanupOrderKnownHosts(orderId: string) {
  rmSync(orderKnownHostsPath(orderId), { force: true });
}

export function classifySshProbe(result: SshProbeResult, finalAttempt = false): CloreSshReadinessClassification {
  if (result.status === 0) return "ssh_ready";
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key verification failed|offending .* key/i.test(output)) return "ssh_host_key_changed";
  if (result.timedOut || /connection timed out|operation timed out|banner exchange.*timed out|connect to host .* timed out/i.test(output)) return "ssh_transport_timeout";
  if (/connection reset|kex_exchange_identification|connection closed by remote host|connection refused|no route to host/i.test(output)) return "ssh_tcp_not_ready";
  if (/permission denied|authentication failed|publickey|no supported authentication methods/i.test(output)) {
    return finalAttempt ? "ssh_public_key_rejected" : "ssh_key_not_injected_yet";
  }
  return "ssh_transport_timeout";
}

export async function awaitOrderSshReadiness(input: {
  readProviderState: () => Promise<ProviderSshState>;
  tcpProbe: (target: SshTarget) => Promise<boolean>;
  keyProbe: (target: SshTarget, knownHostsPath: string) => Promise<SshProbeResult>;
  refreshKnownHost: (target: SshTarget, knownHostsPath: string) => Promise<void> | void;
  knownHostsPath: string;
  windowMs?: number;
  backoffMs?: readonly number[];
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const backoff = input.backoffMs ?? SSH_KEY_READINESS_BACKOFF_MS;
  const startedAt = now();
  const deadline = startedAt + (input.windowMs ?? SSH_KEY_READINESS_WINDOW_MS);
  let attempts = 0;
  let lastClassification: CloreSshReadinessClassification = "ssh_tcp_not_ready";
  let target: SshTarget | null = null;
  let backoffIndex = 0;

  while (now() <= deadline) {
    const state = await input.readProviderState();
    target = state.target;
    if (!state.deploymentReady || !target || !(await input.tcpProbe(target))) {
      lastClassification = "ssh_tcp_not_ready";
    } else {
      attempts += 1;
      let result = await input.keyProbe(target, input.knownHostsPath);
      lastClassification = classifySshProbe(result);
      if (lastClassification === "ssh_host_key_changed") {
        await input.refreshKnownHost(target, input.knownHostsPath);
        attempts += 1;
        result = await input.keyProbe(target, input.knownHostsPath);
        lastClassification = classifySshProbe(result);
      }
      if (lastClassification === "ssh_ready") {
        return { ready: true as const, classification: lastClassification, attempts, durationMs: now() - startedAt, target };
      }
    }

    const delay = backoff[Math.min(backoffIndex, backoff.length - 1)] ?? 20_000;
    backoffIndex += 1;
    if (now() + delay > deadline) break;
    await sleep(delay);
  }

  if (lastClassification === "ssh_key_not_injected_yet") lastClassification = "ssh_public_key_rejected";
  return { ready: false as const, classification: lastClassification, attempts, durationMs: now() - startedAt, target };
}
