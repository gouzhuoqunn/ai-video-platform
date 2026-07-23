import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD,
  assertDeploymentHostAllowed,
  deploymentFailureCount,
  isDeploymentHostBlacklisted,
  readTemporaryDeploymentDeniedServerIds,
  recordDeploymentFailure,
  recordTemporaryDeploymentDeny,
} from "./deployment-host-blacklist";
import { loadCloreConfig } from "./config";

const root = mkdtempSync(path.join(os.tmpdir(), "clore-deployment-blacklist-"));
const historyPath = path.join(root, "history.json");

try {
  assert.equal(DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD, 2);
  assert.equal(isDeploymentHostBlacklisted("98682", historyPath), false);
  recordDeploymentFailure({ serverId: "98682", orderId: "first", reason: "deployment_timeout" }, historyPath);
  recordDeploymentFailure({ serverId: "98682", orderId: "second", reason: "deployment_timeout" }, historyPath);
  assert.equal(deploymentFailureCount("98682", historyPath), 2);
  assert.equal(isDeploymentHostBlacklisted("98682", historyPath), true);
  const previousPath = process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH;
  process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH = historyPath;
  assert.throws(() => assertDeploymentHostAllowed("98682"), /excluded after 2 deployment failures/);
  if (previousPath === undefined) delete process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH;
  else process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH = previousPath;
  assert.equal(recordDeploymentFailure({ serverId: "not-a-server", reason: "ignored" }, historyPath), null);
  const denyPath = path.join(root, "temp-deny.json");
  const previousDenyPath = process.env.CLORE_TEMP_EXCLUDED_SERVERS_PATH;
  process.env.CLORE_TEMP_EXCLUDED_SERVERS_PATH = denyPath;
  recordTemporaryDeploymentDeny({ serverId: "79245", orderId: "1974873", reason: "deploying_proxy_502_timeout", failedAt: "2026-07-23T00:00:00.000Z" }, denyPath);
  recordTemporaryDeploymentDeny({ serverId: "11111", reason: "expired", failedAt: "2026-07-20T00:00:00.000Z", ttlMs: 1000 }, denyPath);
  assert.deepEqual(readTemporaryDeploymentDeniedServerIds(denyPath, new Date("2026-07-23T01:00:00.000Z").getTime()), ["79245"]);
  assert.ok(loadCloreConfig().excludedServerIds.includes("79245"), "temporary deployment denylist is loaded into marketplace exclusions");
  assert.ok(!loadCloreConfig().excludedServerIds.includes("11111"), "expired temporary deployment denylist entries are ignored");
  if (previousDenyPath === undefined) delete process.env.CLORE_TEMP_EXCLUDED_SERVERS_PATH;
  else process.env.CLORE_TEMP_EXCLUDED_SERVERS_PATH = previousDenyPath;
  console.log("Clore deployment host blacklist tests passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
