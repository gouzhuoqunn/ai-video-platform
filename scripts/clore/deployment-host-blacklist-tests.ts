import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD,
  assertDeploymentHostAllowed,
  deploymentFailureCount,
  isDeploymentHostBlacklisted,
  recordDeploymentFailure,
} from "./deployment-host-blacklist";

const root = mkdtempSync(path.join(os.tmpdir(), "clore-deployment-blacklist-"));
const historyPath = path.join(root, "history.json");

try {
  assert.equal(DEPLOYMENT_FAILURE_BLACKLIST_THRESHOLD, 3);
  assert.equal(isDeploymentHostBlacklisted("98682", historyPath), false);
  recordDeploymentFailure({ serverId: "98682", orderId: "first", reason: "deployment_timeout" }, historyPath);
  recordDeploymentFailure({ serverId: "98682", orderId: "second", reason: "deployment_timeout" }, historyPath);
  assert.equal(deploymentFailureCount("98682", historyPath), 2);
  assert.equal(isDeploymentHostBlacklisted("98682", historyPath), false);
  recordDeploymentFailure({ serverId: "98682", orderId: "third", reason: "deployment_timeout" }, historyPath);
  assert.equal(isDeploymentHostBlacklisted("98682", historyPath), true);
  const previousPath = process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH;
  process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH = historyPath;
  assert.throws(() => assertDeploymentHostAllowed("98682"), /excluded after 3 deployment failures/);
  if (previousPath === undefined) delete process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH;
  else process.env.CLORE_DEPLOYMENT_FAILURE_HISTORY_PATH = previousPath;
  assert.equal(recordDeploymentFailure({ serverId: "not-a-server", reason: "ignored" }, historyPath), null);
  console.log("Clore deployment host blacklist tests passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
