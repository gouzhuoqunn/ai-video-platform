import "server-only";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertCreateOrderBodySafe,
  buildKeyWithPasswordFallbackCreateOrderBody,
} from "./order-execution";
import {
  consumePasswordFallbackAttempt,
  createManualParityState,
  passwordFallbackAvailableForOrder,
  repairAuthorizedKeysText,
  writeManualParityState,
} from "./manual-parity";
import {
  assertNoSshCredentialMaterial,
  assertPublicKeyMatchesCanonicalIdentity,
  buildSanitizedSshCredentialSummary,
  deriveCanonicalSshIdentity,
  parseNormalizedOpenSshPublicKey,
} from "./ssh-identity";
import { buildSshArgs } from "./ssh-client";
import {
  buildScpFromRemoteArgs,
  buildScpToRemoteArgs,
  buildSshCommandArgs,
} from "../gpu-providers/common";
import type { GpuTarget } from "../gpu-providers/types";
import { ensureValidatedProjectSshKey } from "./ssh-key-validation";
import { buildStage4J2FinalRetryPlan } from "../stage4j2-final-retry-plan";
import { cleanupOrderKnownHosts, prepareOrderKnownHostsPath } from "./ssh-readiness-policy";

function generateKey(filePath: string, comment: string) {
  const result = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", filePath], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, String(result.stderr));
}

function expectFailure(fn: () => unknown, pattern: RegExp) {
  assert.throws(fn, pattern);
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const root = mkdtempSync(path.join(process.cwd(), ".secrets", "stage4j2-credential-test-"));
try {
  const keyA = path.join(root, "fixture-a");
  const keyB = path.join(root, "fixture-b");
  generateKey(keyA, "stage4j2-a");
  generateKey(keyB, "stage4j2-b");
  const identityA = deriveCanonicalSshIdentity(keyA);
  const identityB = deriveCanonicalSshIdentity(keyB);

  assert.equal(identityA.algorithm, "ssh-ed25519");
  assert.equal(identityA.publicKeySource, "derived_from_private_key");
  assert.equal(identityA.normalizedPublicKey.split(/\r?\n/).length, 1);
  assert.notEqual(identityA.normalizedPublicKey.charCodeAt(0), 0xfeff);
  assertPublicKeyMatchesCanonicalIdentity(identityA.normalizedPublicKey, identityA);
  expectFailure(() => assertPublicKeyMatchesCanonicalIdentity(identityB.normalizedPublicKey, identityA), /fingerprint_mismatch/);

  const password = "S3r-0123456789abcdefAa7";
  const body = buildKeyWithPasswordFallbackCreateOrderBody({
    serverId: "12345",
    currency: "USD-Blockchain",
    sshPassword: password,
    sshPublicKey: identityA.normalizedPublicKey,
    requiredPriceForApi: 5.5,
  });
  assertCreateOrderBodySafe(body);
  const missing = { ...body, ssh_key: undefined };
  expectFailure(() => assertCreateOrderBodySafe(missing), /normalized non-empty OpenSSH public key/);
  expectFailure(() => assertCreateOrderBodySafe({ ...body, ssh_key: keyA }), /normalized non-empty OpenSSH public key/);
  expectFailure(() => parseNormalizedOpenSshPublicKey(`\ufeff${identityA.normalizedPublicKey}`), /bom_forbidden/);
  expectFailure(() => parseNormalizedOpenSshPublicKey(`${identityA.normalizedPublicKey}\ncomment`), /one_line/);

  const summary = buildSanitizedSshCredentialSummary(body.ssh_key, identityA);
  const serializedSummary = JSON.stringify(summary);
  assertNoSshCredentialMaterial(serializedSummary);
  assert.ok(!serializedSummary.includes(identityA.normalizedPublicKey));
  expectFailure(() => assertNoSshCredentialMaterial(identityA.normalizedPublicKey), /credential_material/);

  const canonical = ensureValidatedProjectSshKey();
  const knownHostsPath = prepareOrderKnownHostsPath("stage4j2-fixture");
  const target: GpuTarget = {
    provider: "clore",
    host: "fixture.invalid",
    port: 2222,
    username: "root",
    sshKeyPath: canonical.privateKeyPath,
    sshCredentialSource: "canonical_clore_project_key",
    sshIdentityFingerprint: canonical.fingerprint,
    gpuProfile: "rtx5090",
    runtimeDigest: "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    knownHostsPath,
  };
  const readiness = buildSshArgs({ host: target.host, port: target.port, user: target.username }, "true", { knownHostsPath });
  const runtime = buildSshCommandArgs(target, "runtime-fixture");
  const upload = buildScpToRemoteArgs(target, "fixture", "/workspace/fixture");
  const download = buildScpFromRemoteArgs(target, "/workspace/fixture", "fixture");
  for (const args of [readiness, runtime, upload, download]) {
    assert.equal(option(args, "-i"), canonical.privateKeyPath);
    assert.ok(args.includes("IdentitiesOnly=yes"));
    assert.ok(args.includes("IdentityAgent=none"));
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(args.includes(`UserKnownHostsFile=${knownHostsPath}`));
  }
  assert.ok(readiness.includes("-T"));
  assert.ok(runtime.includes("-T"));
  assert.equal(option(readiness, "-i"), option(runtime, "-i"));
  assert.equal(option(runtime, "-i"), option(upload, "-i"));
  cleanupOrderKnownHosts("stage4j2-fixture");

  const fallbackPath = path.join(root, "password-fallback.json");
  const initial = createManualParityState("12345", fallbackPath);
  assert.equal(passwordFallbackAvailableForOrder(initial, "9001"), false);
  const configured = writeManualParityState({ ...initial, orderId: "9001", passwordConfiguredInPayload: true }, fallbackPath);
  assert.equal(passwordFallbackAvailableForOrder(configured, "9001"), true);
  consumePasswordFallbackAttempt("9001", fallbackPath);
  assert.equal(passwordFallbackAvailableForOrder(JSON.parse(readFileSync(fallbackPath, "utf8")), "9001"), false);
  const repaired = repairAuthorizedKeysText("", identityA.normalizedPublicKey);
  assert.equal(repaired, `${identityA.normalizedPublicKey}\n`);
  assert.equal(repairAuthorizedKeysText(repaired, identityA.normalizedPublicKey), repaired);
  const readinessSource = readFileSync(path.join(process.cwd(), "scripts", "clore", "order-readiness.ts"), "utf8");
  assert.equal((readinessSource.match(/const password = passwordSsh/g) ?? []).length, 1);
  const providerSource = readFileSync(path.join(process.cwd(), "scripts", "gpu-providers", "clore.ts"), "utf8");
  assert.match(providerSource, /\/5090\/i\.test\(input\.candidate\.gpuType \?\? ""\) \? 0\.65 : 0\.7/);
  const bootstrapSource = readFileSync(path.join(process.cwd(), "scripts", "clore", "clore-light-bootstrap.sh"), "utf8");
  assert.match(bootstrapSource, /\[ "\$profile" = rtx5090 \]/);
  assert.match(bootstrapSource, /download\.pytorch\.org\/whl\/cu128/);
  assert.match(bootstrapSource, /'torch==2\.7\.1'/);
  const watchdogSource = readFileSync(path.join(process.cwd(), "scripts", "clore", "watchdog-remote.ts"), "utf8");
  assert.match(watchdogSource, /getArg\("draining-at-minutes"\)/);
  const sessionSource = readFileSync(path.join(process.cwd(), "scripts", "stage4j1-session.ts"), "utf8");
  for (const contract of [
    /maxOrders: 1/,
    /maxActiveOrders: 1/,
    /maxPreSshAttempts: 1/,
    /maxHourlyUsd: 0\.65/,
    /walletDeltaCapUsd: 3/,
    /wallClockMinutes: 300/,
    /drainingAtMinutes: 270/,
    /orderType: "on-demand"/,
    /noReplacementOrder: true/,
  ]) assert.match(sessionSource, contract);

  const plan = buildStage4J2FinalRetryPlan();
  assert.equal(plan.provider_mutations, 0);
  assert.equal(plan.paid_execution_authorized, false);
  assert.equal(plan.prepared_batch_reused, true);
  assert.equal(plan.global_known_hosts_used, false);
  assert.equal(plan.order_password_fallback_prepared, true);
  writeFileSync(path.join(root, "result.json"), `${JSON.stringify({ passed: true })}\n`, "utf8");

  console.log(JSON.stringify({
    credential_contract_tests_passed: true,
    matching_key_pair_passed: true,
    mismatched_key_pair_failed_closed: true,
    malformed_public_keys_failed_closed: true,
    all_ssh_components_share_identity: true,
    ssh_agent_fallback_disabled: true,
    password_fallback_requires_payload_configuration: true,
    synthetic_authorized_keys_repair_passed: true,
    order_scoped_known_hosts_preserved: true,
    rtx5090_revalidation_cap_usd_per_hour: 0.65,
    rtx5090_torch_profile: "2.7.1+cu128",
    watchdog_draining_at_minutes_supported: true,
    one_order_authorization_contract: true,
    plan_provider_mutations: 0,
    key_material_printed: false,
  }, null, 2));
} finally {
  const resolved = path.resolve(root);
  const secretsRoot = path.resolve(process.cwd(), ".secrets");
  if (resolved.startsWith(`${secretsRoot}${path.sep}`)) rmSync(resolved, { recursive: true, force: true });
}
