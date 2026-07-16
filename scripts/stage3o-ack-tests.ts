import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { billingSafetyBlockers, responseSha256, validateSupportAcknowledgement, writeSupportAcknowledgement } from "./clore/support-acknowledgement";

const dir = mkdtempSync(path.join(os.tmpdir(), "stage3o-ack-")); const file = path.join(dir, "ack.json");
const ack = writeSupportAcknowledgement({ ticketId: "CLORE-12345", responseText: "Support agent test@example.com confirms recovery. token=secret-value", recommendedServerIds: ["105175"] }, file);
assert.equal(validateSupportAcknowledgement(ack).valid, true);
assert.equal(JSON.parse(readFileSync(file, "utf8")).ticketId, "CLORE-12345");
assert.equal(readFileSync(file, "utf8").includes("test@example.com"), false);
assert.equal(readFileSync(file, "utf8").includes("secret-value"), false);
assert.match(responseSha256("platform recovered"), /^[a-f0-9]{64}$/);
assert.equal(validateSupportAcknowledgement({ ...ack, acknowledgedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }).valid, false);
const safeBilling = { clore: { activeOrders: 0 }, runpod: { activePods: 0, networkVolumes: 0 }, watchdogs: { remoteArmed: false, scheduledTaskActive: false, processCount: 0, deploymentWatcherProcessCount: 0 }, createLockPresent: false, holds: { clore: true, runpod: true } } as Parameters<typeof billingSafetyBlockers>[0];
assert.deepEqual(billingSafetyBlockers(safeBilling), []); assert.ok(billingSafetyBlockers({ ...safeBilling, createLockPresent: true }).length > 0); assert.ok(billingSafetyBlockers({ ...safeBilling, clore: { ...safeBilling.clore, activeOrders: 1 } }).length > 0);
console.log("Stage 3O acknowledgement age, billing, lock, redaction, and hash gates passed.");
