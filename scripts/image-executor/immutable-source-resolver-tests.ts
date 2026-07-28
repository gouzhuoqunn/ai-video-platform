import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ImmutableSourceResolutionError,
  immutableSourceCachePath,
  resolveImmutableSource,
  type ImmutableSourceEndpoint,
} from "./immutable-source-resolver";
import {
  RTX4090_GOLDEN_DEPLOYMENT_PROFILE,
  applyPublishedAgentSourcePatch,
} from "./rtx4090-golden-deployment-profile";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const root = mkdtempSync(path.join(os.tmpdir(), "immutable-source-resolver-"));
const profileFingerprint = "a".repeat(64);
const commit = "b".repeat(40);
const exactBytes = Buffer.from("print('immutable source')\n", "utf8");
const exactSha256 = sha256(exactBytes);
const endpoints: ImmutableSourceEndpoint[] = [
  { id: "primary", url: "https://primary.invalid/exact.py" },
  { id: "alternate", url: "https://alternate.invalid/exact.py" },
];
const response = (bytes: Buffer, contentType = "text/plain; charset=utf-8") =>
  new Response(bytes, { status: 200, headers: { "content-type": contentType, "content-length": String(bytes.length) } });
const reset = () => Object.assign(new Error("socket reset"), { cause: { code: "ECONNRESET" } });

function predecessorFromPinnedAgent() {
  // Read the exact immutable commit bytes directly.  Reversing a sequence of
  // forward patches is not a valid source-of-truth operation: replacement
  // contexts can overlap after earlier edits, even when forward application
  // is deterministic and strictly verified.
  return execFileSync(
    "git",
    [
      "show",
      `${RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable.commit}:scripts/clore/diagnostic-agent.py`,
    ],
    { cwd: process.cwd(), timeout: 5_000, maxBuffer: 2 * 1024 * 1024 },
  );
}

async function main() {
  let primaryCalls = 0;
  const primary = await resolveImmutableSource({
    profileFingerprint,
    commit,
    sourcePath: "exact.py",
    expectedSha256: exactSha256,
    endpoints,
    cacheRoot: path.join(root, "primary"),
    fetchImpl: (async () => {
      primaryCalls += 1;
      return response(exactBytes);
    }) as typeof fetch,
  });
  assert.equal(primary.endpointId, "primary");
  assert.equal(primary.source, "endpoint");
  assert.equal(primaryCalls, 1);
  assert.equal(primary.sha256, exactSha256);

  let fallbackCalls = 0;
  const fallbackRoot = path.join(root, "fallback");
  const fallback = await resolveImmutableSource({
    profileFingerprint,
    commit,
    sourcePath: "exact.py",
    expectedSha256: exactSha256,
    endpoints,
    cacheRoot: fallbackRoot,
    fetchImpl: (async (url: string | URL | Request) => {
      fallbackCalls += 1;
      if (String(url).includes("primary")) throw reset();
      return response(exactBytes, "application/octet-stream");
    }) as typeof fetch,
  });
  assert.equal(fallback.endpointId, "alternate");
  assert.equal(fallbackCalls, 2);
  assert.deepEqual(
    fallback.evidence.map((item) => item.classification),
    ["cache_missing", "transport_failed", "verified"],
  );

  let cacheNetworkCalls = 0;
  const cached = await resolveImmutableSource({
    profileFingerprint,
    commit,
    sourcePath: "different-name-cannot-select-cache.py",
    expectedSha256: exactSha256,
    endpoints,
    cacheRoot: fallbackRoot,
    fetchImpl: (async () => {
      cacheNetworkCalls += 1;
      throw reset();
    }) as typeof fetch,
  });
  assert.equal(cached.source, "cache");
  assert.equal(cacheNetworkCalls, 0);
  assert.equal(cached.evidence[0].classification, "cache_verified");

  const corruptRoot = path.join(root, "corrupt");
  const corruptPath = immutableSourceCachePath({
    cacheRoot: corruptRoot,
    profileFingerprint,
    commit,
    expectedSha256: exactSha256,
  });
  mkdirSync(path.dirname(corruptPath), { recursive: true });
  writeFileSync(corruptPath, "corrupt", "utf8");
  await assert.rejects(
    () => resolveImmutableSource({
      profileFingerprint,
      commit,
      sourcePath: "exact.py",
      expectedSha256: exactSha256,
      endpoints,
      cacheRoot: corruptRoot,
      fetchImpl: (async () => {
        throw reset();
      }) as typeof fetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ImmutableSourceResolutionError);
      assert.equal(error.message, "immutable_source_unavailable");
      assert.equal(error.evidence[0].classification, "cache_corrupt");
      return true;
    },
  );

  let wrongHashCalls = 0;
  await assert.rejects(
    () => resolveImmutableSource({
      profileFingerprint,
      commit,
      sourcePath: "exact.py",
      expectedSha256: exactSha256,
      endpoints: [...endpoints, { id: "must_not_run", url: "https://third.invalid/exact.py" }],
      cacheRoot: path.join(root, "wrong-hash"),
      fetchImpl: (async (url: string | URL | Request) => {
        wrongHashCalls += 1;
        if (String(url).includes("primary")) throw reset();
        return response(Buffer.from("wrong immutable bytes\n", "utf8"));
      }) as typeof fetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ImmutableSourceResolutionError);
      assert.equal(error.message, "immutable_source_sha256_mismatch");
      assert.equal(error.evidence.at(-1)?.classification, "sha256_mismatch");
      return true;
    },
  );
  assert.equal(wrongHashCalls, 2, "a wrong hash is fatal and cannot fall through to another endpoint");

  const predecessor = predecessorFromPinnedAgent();
  assert.equal(sha256(predecessor), RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable.agentSourceSha256);
  const reconstructed = applyPublishedAgentSourcePatch(predecessor);
  assert.equal(sha256(reconstructed), RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable.agentSha256);
  assert.deepEqual(reconstructed, readFileSync(path.join(process.cwd(), "scripts", "clore", "diagnostic-agent.py")));

  console.log(JSON.stringify({
    immutableSourceResolverTestsPassed: true,
    primaryEndpointVerified: true,
    alternateAfterResetVerified: true,
    exactCacheVerifiedOffline: true,
    corruptCacheRejected: true,
    wrongHashFatal: true,
    exactAgentReconstructionVerified: true,
    providerMutationCount: 0,
  }));
}

void main()
  .finally(() => rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
