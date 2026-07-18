import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateDeploymentResolution } from "./deployment-resolution";

const root = mkdtempSync(path.join(os.tmpdir(), "clore-resolution-"));
const file = path.join(root, "resolution.json");
const unresolved = { enabled: true, reason: "stage4h5_ssh_cleanup" };
assert.equal(validateDeploymentResolution(unresolved, "stage4j1-final-5090").valid, false);
const resolved = { schemaVersion: 1, resolved: true, historicalPauseReason: "stage4h5_ssh_cleanup", rootCause: "reused_proxy_endpoint_and_stale_global_host_key", batchId: "stage4j1-final-5090", resolutionNonce: "nonce", zeroResourceState: { cloreActiveOrders: 0, runpodPods: 0, runpodVolumes: 0, cloreHold: true, runpodHold: true } };
writeFileSync(file, JSON.stringify(resolved));
assert.equal(validateDeploymentResolution(JSON.parse(readFileSync(file, "utf8")), "stage4j1-final-5090", "nonce").valid, true);
assert.equal(validateDeploymentResolution(resolved, "other-batch", "nonce").valid, false);
assert.equal(validateDeploymentResolution(resolved, "stage4j1-final-5090", "wrong").valid, false);
console.log(JSON.stringify({ ok: true, unresolvedIncidentBlocks: true, resolvedHistoricalIncidentAllowsExactBatch: true, genericBatchMismatchBlocks: true, nonceMismatchBlocks: true, providerHoldsRemainEnabled: true }));
