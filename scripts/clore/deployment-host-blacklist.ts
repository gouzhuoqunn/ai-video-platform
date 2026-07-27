import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD = 2;
export const TEMPORARY_DEPLOYMENT_DENY_MS = 24 * 60 * 60 * 1000;

export type DeploymentFailure = {
  failedAt: string;
  orderId: string | null;
  reason: string;
  profileFingerprint: string | null;
};

export type DeploymentSuccess = {
  succeededAt: string;
  orderId: string | null;
  profileFingerprint: string;
};

export type DeploymentFailureHost = {
  serverId: string;
  deploymentFailures: number;
  failures: DeploymentFailure[];
  successes?: DeploymentSuccess[];
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
  profileFingerprint: string | null;
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

function validProfileFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function normalizedProfileFingerprint(value: unknown) {
  if (!validProfileFingerprint(value)) throw new Error("invalid_deployment_profile_fingerprint");
  return value.toLowerCase();
}

function readHistory(filePath = deploymentFailureHistoryPath()): DeploymentFailureHistory {
  if (!existsSync(filePath)) return defaultHistory();
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      schemaVersion?: unknown;
      hosts?: unknown;
    };
    if (parsed.schemaVersion !== 1 || !parsed.hosts || typeof parsed.hosts !== "object" || Array.isArray(parsed.hosts)) return defaultHistory();
    const hosts: Record<string, DeploymentFailureHost> = {};
    for (const [serverId, value] of Object.entries(parsed.hosts as Record<string, unknown>)) {
      if (!validServerId(serverId) || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const failures = Array.isArray(record.failures)
        ? record.failures.flatMap((entry): DeploymentFailure[] => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const failure = entry as Record<string, unknown>;
          if (typeof failure.failedAt !== "string" || typeof failure.reason !== "string") return [];
          return [{
            failedAt: failure.failedAt,
            orderId: typeof failure.orderId === "string" ? failure.orderId : null,
            reason: failure.reason.slice(0, 160),
            profileFingerprint: validProfileFingerprint(failure.profileFingerprint)
              ? failure.profileFingerprint.toLowerCase()
              : null,
          }];
        })
        : [];
      const successes = Array.isArray(record.successes)
        ? record.successes.flatMap((entry): DeploymentSuccess[] => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const success = entry as Record<string, unknown>;
          if (typeof success.succeededAt !== "string" || !validProfileFingerprint(success.profileFingerprint)) return [];
          return [{
            succeededAt: success.succeededAt,
            orderId: typeof success.orderId === "string" ? success.orderId : null,
            profileFingerprint: success.profileFingerprint.toLowerCase(),
          }];
        })
        : [];
      const reportedCount = Number(record.deploymentFailures);
      hosts[serverId] = {
        serverId,
        deploymentFailures: Number.isSafeInteger(reportedCount) && reportedCount >= 0
          ? Math.max(reportedCount, failures.length)
          : failures.length,
        failures,
        ...(successes.length ? { successes } : {}),
      };
    }
    return { schemaVersion: 1, hosts };
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

export function scopedDeploymentFailureCount(serverId: string, profileFingerprint: string, filePath?: string) {
  if (!validServerId(serverId)) return 0;
  const scope = normalizedProfileFingerprint(profileFingerprint);
  const host = readHistory(filePath).hosts[serverId];
  if (!host) return 0;
  const latestSuccess = (host.successes ?? [])
    .filter((success) => success.profileFingerprint === scope)
    .map((success) => Date.parse(success.succeededAt))
    .filter(Number.isFinite)
    .reduce((latest, value) => Math.max(latest, value), Number.NEGATIVE_INFINITY);
  return host.failures.filter((failure) =>
    failure.profileFingerprint === scope &&
    Number.isFinite(Date.parse(failure.failedAt)) &&
    Date.parse(failure.failedAt) >= latestSuccess).length;
}

export function isDeploymentHostBlacklisted(serverId: string, filePath?: string, profileFingerprint?: string) {
  const failures = profileFingerprint !== undefined
    ? scopedDeploymentFailureCount(serverId, profileFingerprint, filePath)
    : deploymentFailureCount(serverId, filePath);
  return failures >= DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD;
}

export function readDeploymentBlacklistedServerIds(filePath?: string, profileFingerprint?: string) {
  const history = readHistory(filePath);
  return [...new Set(Object.keys(history.hosts)
    .filter((serverId) => validServerId(serverId) && isDeploymentHostBlacklisted(serverId, filePath, profileFingerprint)))]
    .sort((left, right) => Number(left) - Number(right));
}

export function recordDeploymentFailure(input: { serverId: string; orderId?: string | null; reason: string; failedAt?: string; profileFingerprint?: string }, filePath?: string) {
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
    profileFingerprint: input.profileFingerprint === undefined
      ? null
      : normalizedProfileFingerprint(input.profileFingerprint),
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

export function recordDeploymentSuccess(input: { serverId: string; profileFingerprint: string; orderId?: string | null; succeededAt?: string }, filePath?: string) {
  if (!validServerId(input.serverId)) return null;
  const history = readHistory(filePath);
  const current = history.hosts[input.serverId] ?? {
    serverId: input.serverId,
    deploymentFailures: 0,
    failures: [],
  };
  const success: DeploymentSuccess = {
    succeededAt: input.succeededAt ?? new Date().toISOString(),
    orderId: input.orderId ?? null,
    profileFingerprint: normalizedProfileFingerprint(input.profileFingerprint),
  };
  const updated: DeploymentFailureHost = {
    ...current,
    successes: [...(current.successes ?? []), success].slice(-20),
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
      ? parsed.map((serverId) => ({ serverId: String(serverId), deniedUntil: new Date(now + TEMPORARY_DEPLOYMENT_DENY_MS).toISOString(), reason: "legacy_temp_exclusion", orderId: null, failedAt: new Date(now).toISOString(), profileFingerprint: null }))
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { servers?: unknown[] }).servers)
        ? (parsed as { servers: unknown[] }).servers
        : [];
    const servers = rawServers
      .map((entry): TemporaryDeploymentDeniedHost | null => {
        if (typeof entry === "string" || typeof entry === "number") {
          const serverId = String(entry).trim();
          return validServerId(serverId)
            ? { serverId, deniedUntil: new Date(now + TEMPORARY_DEPLOYMENT_DENY_MS).toISOString(), reason: "legacy_temp_exclusion", orderId: null, failedAt: new Date(now).toISOString(), profileFingerprint: null }
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
          profileFingerprint: validProfileFingerprint(record.profileFingerprint) ? record.profileFingerprint.toLowerCase() : null,
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

export function readTemporaryDeploymentDeniedServerIds(filePath?: string, now = Date.now(), profileFingerprint?: string) {
  const scopedFingerprint = profileFingerprint === undefined
    ? null
    : normalizedProfileFingerprint(profileFingerprint);
  return [...new Set(readTemporaryDenylist(filePath).servers
    .filter((entry) => new Date(entry.deniedUntil).getTime() > now)
    .filter((entry) => !profileFingerprint || entry.profileFingerprint === scopedFingerprint)
    .map((entry) => entry.serverId))];
}

export function recordTemporaryDeploymentDeny(input: { serverId: string; orderId?: string | null; reason: string; failedAt?: string; ttlMs?: number; profileFingerprint?: string }, filePath?: string) {
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
    profileFingerprint: input.profileFingerprint === undefined
      ? null
      : normalizedProfileFingerprint(input.profileFingerprint),
  };
  denylist.servers = [
    next,
    ...denylist.servers.filter((entry) =>
      entry.serverId !== input.serverId || entry.profileFingerprint !== next.profileFingerprint),
  ];
  writeTemporaryDenylist(denylist, filePath);
  return next;
}

/**
 * A successful deployment proves that the exact host/profile is usable again.
 * Remove only that scoped temporary deny entry; legacy and other-profile
 * evidence remains intact for future selection decisions.
 */
export function clearTemporaryDeploymentDeny(input: { serverId: string; profileFingerprint: string }, filePath?: string) {
  if (!validServerId(input.serverId)) return false;
  const profileFingerprint = normalizedProfileFingerprint(input.profileFingerprint);
  const denylist = readTemporaryDenylist(filePath);
  const retained = denylist.servers.filter((entry) =>
    entry.serverId !== input.serverId || entry.profileFingerprint !== profileFingerprint,
  );
  if (retained.length === denylist.servers.length) return false;
  writeTemporaryDenylist({ ...denylist, servers: retained }, filePath);
  return true;
}

export function assertDeploymentHostAllowed(serverId: string) {
  if (isDeploymentHostBlacklisted(serverId)) {
    throw new Error(`Clore host ${serverId} is excluded after ${DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD} deployment failures.`);
  }
}
