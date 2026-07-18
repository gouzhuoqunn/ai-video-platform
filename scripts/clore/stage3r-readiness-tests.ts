import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildKeyOnlyCreateOrderBody, buildManualParityCreateOrderBody, assertCreateOrderBodySafe } from "./order-execution";
import { parseCloreOrder, parseSshCommand, readinessIssue } from "./order-readiness-parser";
import { syntheticEd25519PublicKey } from "./ssh-test-fixture";

const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "scripts", "clore", "fixtures", "stage3r-real-orders.sanitized.json"), "utf8"));
const closed = parseCloreOrder(fixture.manual_golden);
assert.equal(closed.orderId, "1957892");
assert.equal(closed.serverId, "28726");
assert.equal(closed.terminal, true);
assert.equal(closed.deploymentState, "deployed");
assert.equal(closed.deploymentReady, false);
assert.equal(closed.ssh, null, "a closed response must not invent a hostname from a server id");

const live = parseCloreOrder({ id: 1957892, si: 28726, expired: false, mon_container: 2, pub_cluster: ["n1.msk.cloreai.ru"], tcp_ports: ["22:1584"] });
assert.deepEqual(live.ssh, { host: "n1.msk.cloreai.ru", port: 1584, user: "root" });
assert.equal(live.sshSource, "structured");
assert.equal(readinessIssue(live, { tcpReached: true, authSucceeded: true, authFailed: false }), "ssh_ready");
assert.equal(readinessIssue({ ...live, ssh: null }, { tcpReached: false, authSucceeded: false, authFailed: false }), "deployed_without_ssh_endpoint");
assert.equal(readinessIssue(live, { tcpReached: false, authSucceeded: false, authFailed: false }), "ssh_tcp_unreachable");
assert.equal(readinessIssue(live, { tcpReached: true, authSucceeded: false, authFailed: true }), "ssh_auth_failed");

assert.deepEqual(parseSshCommand("ssh root@n1.msk.cloreai.ru -p 1584"), { host: "n1.msk.cloreai.ru", port: 1584, user: "root" });
assert.deepEqual(parseSshCommand("ssh -p 1584 root@n1.msk.cloreai.ru"), { host: "n1.msk.cloreai.ru", port: 1584, user: "root" });
assert.equal(parseSshCommand("ssh root@n1.msk.clore.ai -p nope"), null);

const parityBody = buildManualParityCreateOrderBody({ serverId: "12345", currency: "USD-Blockchain", sshPassword: "S3r-0123456789abcdefAa7", sshPublicKey: syntheticEd25519PublicKey("stage3r-parity") });
assertCreateOrderBodySafe(parityBody);
assert.deepEqual(Object.keys(parityBody).sort(), ["autossh_entrypoint", "currency", "image", "ports", "renting_server", "ssh_key", "ssh_password", "type"]);
assert.equal(parityBody.image, "cloreai/jupyter:ubuntu24.04-v2");
assert.equal(parityBody.env, undefined);
assert.equal(parityBody.command, undefined);
assert.match(parityBody.ssh_key ?? "", /^ssh-ed25519 /);
assert.equal(parityBody.required_price, undefined);
assert.equal(parityBody.autossh_entrypoint, true);

const keyOnlyBody = buildKeyOnlyCreateOrderBody({ serverId: "29167", currency: "USD-Blockchain", sshPublicKey: syntheticEd25519PublicKey("stage3r-key-only"), requiredPriceForApi: 5.5 });
assertCreateOrderBodySafe(keyOnlyBody);
assert.deepEqual(Object.keys(keyOnlyBody).sort(), ["autossh_entrypoint", "currency", "image", "ports", "renting_server", "required_price", "ssh_key", "type"]);
assert.equal(keyOnlyBody.ssh_password, undefined); assert.equal(keyOnlyBody.env, undefined); assert.equal(keyOnlyBody.command, undefined); assert.equal(keyOnlyBody.required_price, 5.5);

const readinessSource = readFileSync(path.join(process.cwd(), "scripts", "clore", "order-readiness.ts"), "utf8");
assert.ok(readinessSource.includes('ssh-keygen", ["-R", endpoint'), "a reused Clore proxy endpoint must refresh its scoped known-host entry");
assert.ok(readinessSource.includes("awaitOrderSshReadiness"), "key authentication must be attempted before password fallback");
assert.ok(readinessSource.includes("passwordFallbackAvailableForOrder"), "password fallback must require exact order payload configuration");
assert.ok(readinessSource.includes("ssh_auth: { passwordAuthSucceeded, keyInstalled, keyAuthSucceeded"), "sanitized SSH authentication evidence must be persisted");

console.log("Stage 3R real-order parsing, exact SSH endpoint extraction, readiness categories, and manual-parity payload passed.");
