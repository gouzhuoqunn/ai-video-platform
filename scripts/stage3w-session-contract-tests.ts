import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildStage3WOverride, rankStage3WCandidates } from "./stage3w-wan-retry-session";
import type { GpuCandidate } from "./gpu-providers/types";

const override = buildStage3WOverride(new Date("2026-07-17T00:00:00.000Z"));
assert.deepEqual(override.limits, { maxHostAttempts: 2, maxFailedDeploymentSpendUsd: 0.35, maxTotalSpendUsd: 2, wallClockMinutes: 150 });
assert.equal(Date.parse(override.expires_at) - Date.parse(override.created_at), 150 * 60_000); assert.equal(override.one_use, true); assert.match(override.integrity_sha256, /^[a-f0-9]{64}$/);

const candidate = (id: string, gpu = "RTX 4090", price = 0.3): GpuCandidate => ({ id, gpuType: gpu, priority: 1, vramGb: 24, gpuCount: 1, minimumRamGb: 64, containerDiskGb: 200, volumeGb: 0, hourlyUsd: price, availability: "High", reliability: 0.98, rating: 4.9, downloadMbps: 500, uploadMbps: 500, interruptible: false });
const ranked = rankStage3WCandidates([candidate("other", "RTX 4090", 0.2), candidate("105178", "RTX 4090", 0.4), candidate("29167", "RTX 4090", 0.5), candidate("5090", "RTX 5090", 0.1), { ...candidate("disk"), containerDiskGb: 179 }, { ...candidate("ram"), minimumRamGb: 31 }, { ...candidate("vram"), vramGb: 22 }, candidate("too-expensive", "RTX 4090", 0.8)]);
assert.deepEqual(ranked.map((value) => value.id), ["29167", "105178", "other", "5090"]); assert.ok(ranked.every((value) => (value.hourlyUsd ?? Infinity) * 2.5 + 0.1 <= 2));

const runner = readFileSync("scripts/comfy-remote-runner.ts", "utf8");
assert.ok(runner.includes('const partialPath = `${sourcePath}.part`')); assert.ok(runner.includes("renameSync(partialPath, sourcePath)"));
const persistentFunction = runner.slice(runner.indexOf("export function downloadRemoteRunnerOutputPersistent"), runner.indexOf("export function removeRemoteRunnerOutput"));
assert.ok(!persistentFunction.includes("rm -f ${remotePath}"), "persistent download must leave remote source available for fallback");

const session = readFileSync("scripts/stage3w-wan-retry-session.ts", "utf8");
assert.ok(session.includes("remoteFallback(target")); assert.ok(session.includes("local-ffmpeg.stderr.txt") || readFileSync("scripts/stage3o-wan-executor.ts", "utf8").includes("local-ffmpeg.stderr.txt"));
assert.ok(session.includes("both_conversions_failed")); assert.ok(session.indexOf("await syncMedia") < session.indexOf("await cleanup(session"), "order cleanup must follow local media validation/fallback");
assert.ok(session.includes('cloreProfile: "clore_key_only"')); assert.ok(session.includes("--hard-deadline-minutes=150")); assert.ok(session.includes("--hard-budget-usd=2.0"));
assert.ok(session.includes('process.env.CLORE_ORDER_EXECUTION_ENABLED = "true"')); assert.ok(session.includes('process.env.CLORE_FIRST_SESSION_MAX_BUDGET_USD = String(LIMITS.maxTotalSpendUsd)'));
assert.ok(!session.includes("runRemoteFirstImage")); assert.ok(!session.includes("restore-flux"));
console.log(JSON.stringify({ stage3w_override_verified: true, candidate_policy_verified: true, persistent_partial_atomic_verified: true, remote_fallback_before_cleanup_verified: true, wan_only_verified: true }, null, 2));
