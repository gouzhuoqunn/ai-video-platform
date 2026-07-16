import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildManualParityCreateOrderBody, assertCreateOrderBodySafe } from "./order-execution";
import { parseCloreOrder, parseSshCommand, readinessIssue } from "./order-readiness-parser";

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

const parityBody = buildManualParityCreateOrderBody({ serverId: "12345", currency: "USD-Blockchain", sshPassword: "S3r-0123456789abcdefAa7" });
assertCreateOrderBodySafe(parityBody);
assert.deepEqual(Object.keys(parityBody).sort(), ["currency", "image", "ports", "renting_server", "ssh_password", "type"]);
assert.equal(parityBody.image, "cloreai/jupyter:ubuntu24.04-v2");
assert.equal(parityBody.env, undefined);
assert.equal(parityBody.command, undefined);
assert.equal(parityBody.ssh_key, undefined);
assert.equal(parityBody.required_price, undefined);
assert.equal(parityBody.autossh_entrypoint, undefined);

console.log("Stage 3R real-order parsing, exact SSH endpoint extraction, readiness categories, and manual-parity payload passed.");
