import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildOperatorRetryOverride, consumeOperatorRetryOverride, markOperatorRetryConsumed, operatorRetryPaths, readOperatorRetryOverride, validateOperatorRetryOverride, writeOperatorRetryOverride } from "./clore/operator-retry-override";
import { writeSupportAcknowledgement } from "./clore/support-acknowledgement";
import { deploymentReadinessTimeoutMs, MAX_FAILED_DEPLOYMENT_SPEND_USD, MAX_HOST_ATTEMPTS, rankStage3OCandidates, resolveStage3PAuthorization } from "./generation-live-session";
import type { GpuCandidate } from "./gpu-providers/types";
import { buildStage3OWanWorkflow, validateStage3OWanWorkflow } from "./stage3o-wan-executor";

function temporaryPaths(label: string) { return operatorRetryPaths(mkdtempSync(path.join(os.tmpdir(), label))); }
const paths = temporaryPaths("stage3p-override-");
const override = buildOperatorRetryOverride(new Date(), 180);
assert.deepEqual(Object.keys(override).sort(), ["createdAt", "expiresAt", "integritySha256", "limits", "nonce"]);
assert.equal(validateOperatorRetryOverride(override).valid, true);
writeOperatorRetryOverride(override, paths);
assert.equal(readOperatorRetryOverride(paths).valid, true);
const tampered = { ...override, limits: { ...override.limits, maxSessionSpendUsd: 2.4 } };
assert.equal(validateOperatorRetryOverride(tampered).valid, false);
consumeOperatorRetryOverride(paths);
assert.equal(existsSync(paths.available), false); assert.equal(existsSync(paths.consuming), true);
assert.deepEqual(readOperatorRetryOverride(paths).blockers, ["operator_retry_already_consuming"]);
markOperatorRetryConsumed(paths); markOperatorRetryConsumed(paths);
assert.equal(existsSync(paths.consumed), true); assert.deepEqual(readOperatorRetryOverride(paths).blockers, ["operator_retry_already_consumed"]);

const fallbackPaths = temporaryPaths("stage3p-fallback-"); writeOperatorRetryOverride(buildOperatorRetryOverride(), fallbackPaths);
const missingSupport = path.join(os.tmpdir(), `missing-support-${process.pid}-${Date.now()}.json`);
assert.equal(resolveStage3PAuthorization({ supportPath: missingSupport, overridePaths: fallbackPaths }).method, "operator_retry");
const supportFile = path.join(mkdtempSync(path.join(os.tmpdir(), "stage3p-support-")), "ack.json");
writeSupportAcknowledgement({ ticketId: "CLORE-STAGE3P-TEST", responseText: "Platform recovery confirmed for test fixture." }, supportFile);
assert.equal(resolveStage3PAuthorization({ supportPath: supportFile, overridePaths: fallbackPaths }).method, "support_acknowledgement");
assert.equal(existsSync(fallbackPaths.available), true);

const candidate = (id: string, reliability: number, network: number, price = 0.5): GpuCandidate => ({ id, gpuType: "RTX 4090", priority: 0, vramGb: 24, gpuCount: 1, minimumRamGb: 64, containerDiskGb: 200, volumeGb: 0, hourlyUsd: price, reliability, rating: 5, downloadMbps: network, uploadMbps: network, availability: "High", interruptible: false });
assert.deepEqual(rankStage3OCandidates([candidate("cheap", 0.95, 100, 0.3), candidate("reliable", 0.999, 1000, 0.5), candidate("105175", 1, 5000, 0.1)], []).map((item) => item.id), ["reliable", "cheap"]);
assert.equal(MAX_HOST_ATTEMPTS, 1); assert.equal(MAX_FAILED_DEPLOYMENT_SPEND_USD, 0.2);
const wait = deploymentReadinessTimeoutMs(0.7); assert.ok(wait <= 12 * 60_000); assert.ok(0.1 + 0.7 * wait / 3_600_000 <= 0.2001);
assert.equal(validateStage3OWanWorkflow(buildStage3OWanWorkflow({ width: 854, height: 480 })).width, 854);

const liveSource = readFileSync("scripts/generation-live-session.ts", "utf8");
assert.ok(liveSource.includes("imagePreserved: true"));
assert.ok(liveSource.includes("setCloreDeploymentHold(true, \"stage3o_finally\")"));
assert.ok(liveSource.includes("clore:watchdog:remote:disarm"));
assert.ok(liveSource.includes("MAX_HOST_ATTEMPTS = 1"));
const orderSource = readFileSync("scripts/clore/order-execution.ts", "utf8");
assert.ok(orderSource.indexOf("acquireOrderCreateLock") < orderSource.indexOf("await input.beforeCreateRequest?.()"));
assert.ok(orderSource.indexOf("await input.beforeCreateRequest?.()") < orderSource.indexOf('cloreRequest<unknown>(input.config, "/create_order"'));
assert.ok(orderSource.indexOf("await input.afterCreateRequestAttempt?.()") > orderSource.indexOf('cloreRequest<unknown>(input.config, "/create_order"'));
const record = JSON.parse(readFileSync(paths.consumed, "utf8")); writeFileSync(paths.consumed, `${JSON.stringify(record)}\n`, "utf8");
console.log("Stage 3P operator override validation, atomic consumption, preferred gate, one-attempt budget, independence, and cleanup guards passed.");
