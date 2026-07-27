import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD,
  assertDeploymentHostAllowed,
  clearTemporaryDeploymentDeny,
  deploymentFailureCount,
  isDeploymentHostBlacklisted,
  readDeploymentBlacklistedServerIds,
  readTemporaryDeploymentDeniedServerIds,
  recordDeploymentFailure,
  recordDeploymentSuccess,
  recordTemporaryDeploymentDeny,
  scopedDeploymentFailureCount,
} from "./deployment-host-blacklist";
import { loadCloreConfig } from "./config";

const root = mkdtempSync(path.join(os.tmpdir(), "clore-deployment-blacklist-"));
const historyPath = path.join(root, "history.json");
const profileA = "a".repeat(64);
const profileB = "b".repeat(64);

try {
  assert.equal(DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD, 2);
  assert.equal(isDeploymentHostBlacklisted("98682", historyPath), false);
  recordDeploymentFailure({ serverId: "98682", orderId: "first", reason: "deployment_timeout" }, historyPath);
  recordDeploymentFailure({ serverId: "98683", orderId: "only", reason: "single_failure" }, historyPath);
  assert.deepEqual(readDeploymentBlacklistedServerIds(historyPath), []);
  recordDeploymentFailure({ serverId: "98682", orderId: "second", reason: "deployment_timeout" }, historyPath);
  assert.equal(deploymentFailureCount("98682", historyPath), 2);
  assert.equal(isDeploymentHostBlacklisted("98682", historyPath), true);
  assert.deepEqual(readDeploymentBlacklistedServerIds(historyPath), ["98682"]);
  assert.equal(scopedDeploymentFailureCount("98682", profileA, historyPath), 0, "unscoped legacy failures do not poison a distinct immutable deployment profile");
  assert.equal(isDeploymentHostBlacklisted("98682", historyPath, profileA), false);

  recordDeploymentFailure({ serverId: "90001", orderId: "a1", reason: "profile_a_failure", failedAt: "2026-07-27T00:00:00.000Z", profileFingerprint: profileA }, historyPath);
  recordDeploymentFailure({ serverId: "90001", orderId: "a2", reason: "profile_a_failure", failedAt: "2026-07-27T00:01:00.000Z", profileFingerprint: profileA }, historyPath);
  recordDeploymentFailure({ serverId: "90001", orderId: "b1", reason: "profile_b_failure", failedAt: "2026-07-27T00:00:00.000Z", profileFingerprint: profileB }, historyPath);
  recordDeploymentFailure({ serverId: "90001", orderId: "b2", reason: "profile_b_failure", failedAt: "2026-07-27T00:01:00.000Z", profileFingerprint: profileB }, historyPath);
  assert.equal(scopedDeploymentFailureCount("90001", profileA, historyPath), 2);
  assert.equal(scopedDeploymentFailureCount("90001", profileB, historyPath), 2);
  recordDeploymentSuccess({ serverId: "90001", orderId: "a-ok", succeededAt: "2026-07-27T00:02:00.000Z", profileFingerprint: profileA }, historyPath);
  assert.equal(scopedDeploymentFailureCount("90001", profileA, historyPath), 0, "a later success rehabilitates only its exact profile");
  assert.equal(scopedDeploymentFailureCount("90001", profileB, historyPath), 2, "success in another profile cannot erase failures");
  assert.deepEqual(readDeploymentBlacklistedServerIds(historyPath, profileA), []);
  assert.deepEqual(readDeploymentBlacklistedServerIds(historyPath, profileB), ["90001"]);

  const previousPath = process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH;
  process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH = historyPath;
  assert.throws(() => assertDeploymentHostAllowed("98682"), /excluded after 2 deployment failures/);
  assert.ok(loadCloreConfig().excludedServerIds.includes("98682"), "durably blacklisted deployment hosts are loaded into marketplace exclusions");
  assert.ok(!loadCloreConfig().excludedServerIds.includes("98683"), "one deployment failure does not permanently exclude a host");
  assert.ok(!loadCloreConfig({ deploymentProfileFingerprint: profileA }).excludedServerIds.includes("98682"), "legacy failures do not exclude a new immutable deployment profile");
  assert.ok(!loadCloreConfig({ deploymentProfileFingerprint: profileA }).excludedServerIds.includes("90001"), "same-profile success supersedes earlier failures");
  assert.ok(loadCloreConfig({ deploymentProfileFingerprint: profileB }).excludedServerIds.includes("90001"), "another profile remains excluded by its own failures");
  if (previousPath === undefined) delete process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH;
  else process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH = previousPath;
  assert.equal(recordDeploymentFailure({ serverId: "not-a-server", reason: "ignored" }, historyPath), null);
  const denyPath = path.join(root, "temp-deny.json");
  const previousDenyPath = process.env.CLORE_TEMP_EXCLUDED_SERVERS_PATH;
  process.env.CLORE_TEMP_EXCLUDED_SERVERS_PATH = denyPath;
  const recentFailureAt = new Date(Date.now() - 60_000).toISOString();
  recordTemporaryDeploymentDeny({ serverId: "79245", orderId: "1974873", reason: "deploying_proxy_502_timeout", failedAt: recentFailureAt }, denyPath);
  recordTemporaryDeploymentDeny({ serverId: "79246", orderId: "a-deny", reason: "profile_a_timeout", failedAt: recentFailureAt, profileFingerprint: profileA }, denyPath);
  recordTemporaryDeploymentDeny({ serverId: "79246", orderId: "b-deny", reason: "profile_b_timeout", failedAt: recentFailureAt, profileFingerprint: profileB }, denyPath);
  recordTemporaryDeploymentDeny({ serverId: "11111", reason: "expired", failedAt: new Date(Date.now() - 60_000).toISOString(), ttlMs: 1000 }, denyPath);
  assert.deepEqual(readTemporaryDeploymentDeniedServerIds(denyPath).sort(), ["79245", "79246"]);
  assert.deepEqual(readTemporaryDeploymentDeniedServerIds(denyPath, Date.now(), profileA), ["79246"], "a scoped read ignores legacy and other-profile temporary failures");
  assert.deepEqual(readTemporaryDeploymentDeniedServerIds(denyPath, Date.now(), profileB), ["79246"], "same server retains independent temporary records for each profile");
  assert.ok(loadCloreConfig().excludedServerIds.includes("79245"), "temporary deployment denylist is loaded into marketplace exclusions");
  assert.ok(!loadCloreConfig({ deploymentProfileFingerprint: profileA }).excludedServerIds.includes("79245"), "legacy temporary failures do not poison a new profile");
  assert.ok(loadCloreConfig({ deploymentProfileFingerprint: profileA }).excludedServerIds.includes("79246"), "same-profile temporary failures remain excluded");
  assert.ok(!loadCloreConfig().excludedServerIds.includes("11111"), "expired temporary deployment denylist entries are ignored");
  assert.equal(clearTemporaryDeploymentDeny({ serverId: "79246", profileFingerprint: profileA }, denyPath), true);
  assert.deepEqual(readTemporaryDeploymentDeniedServerIds(denyPath, Date.now(), profileA), []);
  assert.deepEqual(readTemporaryDeploymentDeniedServerIds(denyPath, Date.now(), profileB), ["79246"], "rehabilitation is scoped to the successful profile");
  if (previousDenyPath === undefined) delete process.env.CLORE_TEMP_EXCLUDED_SERVERS_PATH;
  else process.env.CLORE_TEMP_EXCLUDED_SERVERS_PATH = previousDenyPath;
  console.log("Clore deployment host blacklist tests passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
