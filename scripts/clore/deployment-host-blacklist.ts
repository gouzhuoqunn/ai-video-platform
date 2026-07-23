import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD = 2;
export const TEMPORARY_DEPLOYMENT_DENY_MS = 24 * 60 * 60 * 1000;

export type DeploymentFailure = {
  failedAt: string;
  orderId: string | null;
  reason: string;
};

export type DeploymentFailureHost = {
  serverId: string;
  deploymentFailures: number;
  failures: DeploymentFailure[];
};

type DeploymentFailureHistory = {
  schemaVersion: 1;
  hosts: Record<string, DeploymentFailureHost>;
};

export type TemporaryDeploymentDeniedHost = {
  serverId: string;
  deniedUntil: string;
  reason: string;
  orderId: string | null;
  failedAt: string;
};

type TemporaryDeploymentDenylist = {
  schemaVersion: 1;
  servers: TemporaryDeploymentDeniedHost[];
};

function defaultHistory(): DeploymentFailureHistory {
  return { schemaVersion: 1, hosts: {} };
}

export function deploymentFailureHistoryPath() {
  return process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH?.trim()
    || path.join(process.cwd(), ".secrets", "clore-deployment-failure-history.json");
}

export function temporaryDeploymentDenylistPath() {
  return process.env.CLORE_TEMP_EXCLUDED_SERVERS_PATH?.trim()
    || path.join(process.cwd(), ".secrets", "clore-temp-excluded-servers.json");
}

function validServerId(serverId: string) {
  return /^\d+$/.test(serverId);
}

function readHistory(filePath = deploymentFailureHistoryPath()): DeploymentFailureHistory {
  if (!existsSync(filePath)) return defaultHistory();
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DeploymentFailureHistory>;
    if (parsed.schemaVersion !== 1 || !parsed.hosts || typeof parsed.hosts !== "object") return defaultHistory();
    return { schemaVersion: 1, hosts: parsed.hosts };
  } catch {
    return defaultHistory();
  }
}

function writeHistory(history: DeploymentFailureHistory, filePath = deploymentFailureHistoryPath()) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
}

export function deploymentFailureCount(serverId: string, filePath?: string) {
  if (!validServerId(serverId)) return 0;
  return readHistory(filePath).hosts[serverId]?.deploymentFailures ?? 0;
}

export function isDeploymentHostBlacklisted(serverId: string, filePath?: string) {
  return deploymentFailureCount(serverId, filePath) >= DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD;
}

export function recordDeploymentFailure(input: { serverId: string; orderId?: string | null; reason: string; failedAt?: string }, filePath?: string) {
  if (!validServerId(input.serverId)) return null;
  const history = readHistory(filePath);
  const current = history.hosts[input.serverId] ?? {
    serverId: input.serverId,
    deploymentFailures: 0,
    failures: [],
  };
  const failure: DeploymentFailure = {
    failedAt: input.failedAt ?? new Date().toISOString(),
    orderId: input.orderId ?? null,
    reason: input.reason.slice(0, 160),
  };
  const updated: DeploymentFailureHost = {
    ...current,
    deploymentFailures: current.deploymentFailures + 1,
    failures: [...current.failures, failure].slice(-20),
  };
  history.hosts[input.serverId] = updated;
  writeHistory(history, filePath);
  return updated;
}

function readTemporaryDenylist(filePath = temporaryDeploymentDenylistPath()): TemporaryDeploymentDenylist {
  if (!existsSync(filePath)) return { schemaVersion: 1, servers: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const now = Date.now();
    const rawServers = Array.isArray(parsed)
      ? parsed.map((serverId) => ({ serverId: String(serverId), deniedUntil: new Date(now + TEMPORARY_DEPLOYMENT_DENY_MS).toISOString(), reason: "legacy_temp_exclusion", orderId: null, failedAt: new Date(now).toISOString() }))
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { servers?: unknown[] }).servers)
        ? (parsed as { servers: unknown[] }).servers
        : [];
    const servers = rawServers
      .map((entry): TemporaryDeploymentDeniedHost | null => {
        if (typeof entry === "string" || typeof entry === "number") {
          const serverId = String(entry).trim();
          return validServerId(serverId)
            ? { serverId, deniedUntil: new Date(now + TEMPORARY_DEPLOYMENT_DENY_MS).toISOString(), reason: "legacy_temp_exclusion", orderId: null, failedAt: new Date(now).toISOString() }
            : null;
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const record = entry as Record<string, unknown>;
        const serverId = String(record.serverId ?? record.server_id ?? "").trim();
        const deniedUntil = typeof record.deniedUntil === "string" ? record.deniedUntil : typeof record.expiresAt === "string" ? record.expiresAt : "";
        if (!validServerId(serverId) || !Number.isFinite(new Date(deniedUntil).getTime()) || new Date(deniedUntil).getTime() <= now) return null;
        return {
          serverId,
          deniedUntil,
          reason: typeof record.reason === "string" ? record.reason.slice(0, 160) : "deployment_failed",
          orderId: typeof record.orderId === "string" || typeof record.order_id === "string" ? String(record.orderId ?? record.order_id) : null,
          failedAt: typeof record.failedAt === "string" ? record.failedAt : new Date(now).toISOString(),
        };
      })
      .filter((entry): entry is TemporaryDeploymentDeniedHost => Boolean(entry));
    return { schemaVersion: 1, servers };
  } catch {
    return { schemaVersion: 1, servers: [] };
  }
}

function writeTemporaryDenylist(denylist: TemporaryDeploymentDenylist, filePath = temporaryDeploymentDenylistPath()) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(denylist, null, 2)}\n`, "utf8");
}

export function readTemporaryDeploymentDeniedServerIds(filePath?: string, now = Date.now()) {
  return [...new Set(readTemporaryDenylist(filePath).servers
    .filter((entry) => new Date(entry.deniedUntil).getTime() > now)
    .map((entry) => entry.serverId))];
}

export function recordTemporaryDeploymentDeny(input: { serverId: string; orderId?: string | null; reason: string; failedAt?: string; ttlMs?: number }, filePath?: string) {
  if (!validServerId(input.serverId)) return null;
  const failedAt = input.failedAt ?? new Date().toISOString();
  const deniedUntil = new Date(new Date(failedAt).getTime() + (input.ttlMs ?? TEMPORARY_DEPLOYMENT_DENY_MS)).toISOString();
  const denylist = readTemporaryDenylist(filePath);
  const next: TemporaryDeploymentDeniedHost = {
    serverId: input.serverId,
    deniedUntil,
    reason: input.reason.slice(0, 160),
    orderId: input.orderId ?? null,
    failedAt,
  };
  denylist.servers = [next, ...denylist.servers.filter((entry) => entry.serverId !== input.serverId)];
  writeTemporaryDenylist(denylist, filePath);
  return next;
}

export function assertDeploymentHostAllowed(serverId: string) {
  if (isDeploymentHostBlacklisted(serverId)) {
    throw new Error(`Clore host ${serverId} is excluded after ${DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD} deployment failures.`);
  }
}
