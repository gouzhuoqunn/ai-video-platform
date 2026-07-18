import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseCloreOrder } from "./clore/order-readiness-parser";
import { buildSshArgs } from "./clore/ssh-client";
import {
  awaitOrderSshReadiness,
  classifySshProbe,
  cleanupOrderKnownHosts,
  orderKnownHostsPath,
  prepareOrderKnownHostsPath,
} from "./clore/ssh-readiness-policy";

const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "scripts", "clore", "fixtures", "stage4h6-ssh-fixtures.sanitized.json"), "utf8")) as {
  deployed_before_key_injection: Record<string, unknown>;
  stderr: Record<string, string>;
};
const parsed = parseCloreOrder(fixture.deployed_before_key_injection);
assert.equal(parsed.deploymentReady, true);
assert.deepEqual(parsed.ssh, { host: "proxy.example.invalid", port: 2442, user: "root" });
assert.ok(buildSshArgs(parsed.ssh, "true", { requirePrivateKey: false, knownHostsPath: "order-scoped-fixture" }).includes("UserKnownHostsFile=order-scoped-fixture"));

assert.equal(classifySshProbe({ status: 255, stderr: fixture.stderr.host_key_changed }), "ssh_host_key_changed");
assert.equal(classifySshProbe({ status: null, stderr: fixture.stderr.transport_timeout, timedOut: true }), "ssh_transport_timeout");
assert.equal(classifySshProbe({ status: 255, stderr: fixture.stderr.connection_reset }), "ssh_tcp_not_ready");
assert.equal(classifySshProbe({ status: 255, stderr: fixture.stderr.key_not_injected }), "ssh_key_not_injected_yet");
assert.equal(classifySshProbe({ status: 255, stderr: fixture.stderr.key_not_injected }, true), "ssh_public_key_rejected");

async function main() {
let clock = 0;
let providerReads = 0;
let authAttempts = 0;
const delayed = await awaitOrderSshReadiness({
  knownHostsPath: "fixture-known-hosts",
  now: () => clock,
  sleep: async (milliseconds) => { clock += milliseconds; },
  readProviderState: async () => { providerReads += 1; return { deploymentReady: true, target: parsed.ssh }; },
  tcpProbe: async () => true,
  keyProbe: async () => { authAttempts += 1; return authAttempts < 3 ? { status: 255, stderr: fixture.stderr.key_not_injected } : { status: 0 }; },
  refreshKnownHost: () => { throw new Error("host key refresh should not run for delayed key injection"); },
});
assert.equal(delayed.ready, true);
assert.equal(delayed.classification, "ssh_ready");
assert.equal(delayed.attempts, 3);
assert.equal(providerReads, 3, "provider state must be reread before each retry");
assert.deepEqual(delayed.target, parsed.ssh, "provider endpoint must remain exact");

clock = 0;
let changedAttempts = 0;
let refreshed = 0;
const changed = await awaitOrderSshReadiness({
  knownHostsPath: "order-scoped-fixture",
  now: () => clock,
  sleep: async (milliseconds) => { clock += milliseconds; },
  readProviderState: async () => ({ deploymentReady: true, target: parsed.ssh }),
  tcpProbe: async () => true,
  keyProbe: async () => { changedAttempts += 1; return changedAttempts === 1 ? { status: 255, stderr: fixture.stderr.host_key_changed } : { status: 0 }; },
  refreshKnownHost: (_target, knownHostsPath) => { assert.equal(knownHostsPath, "order-scoped-fixture"); refreshed += 1; },
});
assert.equal(changed.ready, true);
assert.equal(changed.attempts, 2);
assert.equal(refreshed, 1);

clock = 0;
const tcpTimeout = await awaitOrderSshReadiness({
  windowMs: 20_000,
  knownHostsPath: "tcp-timeout-fixture",
  now: () => clock,
  sleep: async (milliseconds) => { clock += milliseconds; },
  readProviderState: async () => ({ deploymentReady: true, target: parsed.ssh }),
  tcpProbe: async () => false,
  keyProbe: async () => { throw new Error("key probe must not run before TCP"); },
  refreshKnownHost: () => undefined,
});
assert.equal(tcpTimeout.ready, false);
assert.equal(tcpTimeout.classification, "ssh_tcp_not_ready");

clock = 0;
const permanent = await awaitOrderSshReadiness({
  windowMs: 20_000,
  knownHostsPath: "permanent-rejection-fixture",
  now: () => clock,
  sleep: async (milliseconds) => { clock += milliseconds; },
  readProviderState: async () => ({ deploymentReady: true, target: parsed.ssh }),
  tcpProbe: async () => true,
  keyProbe: async () => ({ status: 255, stderr: fixture.stderr.key_not_injected }),
  refreshKnownHost: () => undefined,
});
assert.equal(permanent.ready, false);
assert.equal(permanent.classification, "ssh_public_key_rejected");

const cleanupOrderId = "stage4h6-fixture-cleanup";
const scopedPath = prepareOrderKnownHostsPath(cleanupOrderId);
writeFileSync(scopedPath, "fixture host key\n", "utf8");
assert.equal(scopedPath, orderKnownHostsPath(cleanupOrderId));
cleanupOrderKnownHosts(cleanupOrderId);
assert.equal(existsSync(scopedPath), false);

console.log(JSON.stringify({
  ok: true,
  providerMutations: 0,
  exactEndpoint: parsed.ssh,
  delayedKeyInjectionAttempts: delayed.attempts,
  changedHostKeyRefreshed: refreshed,
  classifications: ["ssh_tcp_not_ready", "ssh_host_key_changed", "ssh_key_not_injected_yet", "ssh_public_key_rejected", "ssh_transport_timeout", "ssh_ready"],
  orderScopedKnownHostsCleanup: true,
}));
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
