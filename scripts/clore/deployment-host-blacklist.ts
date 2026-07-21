import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD = 3;

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

function defaultHistory(): DeploymentFailureHistory {
  return { schemaVersion: 1, hosts: {} };
}

export function deploymentFailureHistoryPath() {
  return process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH?.trim()
    || path.join(process.cwd(), ".secrets", "clore-deployment-failure-history.json");
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

export function assertDeploymentHostAllowed(serverId: string) {
  if (isDeploymentHostBlacklisted(serverId)) {
    throw new Error(`Clore host ${serverId} is excluded after ${DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD} deployment failures.`);
  }
}
