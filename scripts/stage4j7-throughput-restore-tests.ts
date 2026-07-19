import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  buildExactRanges,
  classifyRestoreThroughput,
  decideQualificationOutcome,
  evaluateRestoreGate,
  mayCreateQualificationOrder,
  rankRestoreCandidates,
  sanitizeRestoreLogText,
  summarizeRestoreProbe,
} from "./model-cache/restore-throughput";

const MIB = 1024 ** 2;

const ranges = buildExactRanges(35_572_266_487, 8);
assert.equal(ranges.length, 8);
assert.equal(ranges[0].start, 0);
assert.equal(ranges.at(-1)?.end, 35_572_266_486);
for (let index = 1; index < ranges.length; index += 1) {
  assert.equal(ranges[index - 1].end + 1, ranges[index].start);
}
assert.equal(ranges.reduce((total, range) => total + range.length, 0), 35_572_266_487);

assert.equal(classifyRestoreThroughput(15 * MIB), "healthy");
assert.equal(classifyRestoreThroughput(8 * MIB), "acceptable_extended");
assert.equal(classifyRestoreThroughput(5.63 * MIB), "slow");
assert.equal(classifyRestoreThroughput(4.99 * MIB), "inadequate");

const probe = summarizeRestoreProbe({
  measuredAt: "2026-07-19T00:00:00.000Z",
  durationSeconds: 24,
  restoreBytes: 35_572_266_487,
  objects: [
    { objectId: "object-a", requestedBytes: 192 * MIB, receivedBytes: 192 * MIB, durationSeconds: 23, httpStatuses: [206], rangeSupported: true },
    { objectId: "object-b", requestedBytes: 192 * MIB, receivedBytes: 192 * MIB, durationSeconds: 24, httpStatuses: [206], rangeSupported: true },
  ],
});
assert.equal(probe.receivedBytes, 384 * MIB);
assert.equal(probe.allRangesAccepted, true);
assert.equal(probe.band, "healthy");
assert.ok((probe.estimatedFullRestoreSeconds ?? Infinity) < 60 * 60);

const oldDeadline = evaluateRestoreGate({
  remainingBytes: 35_572_266_487 - 4_336_910_336,
  measuredBytesPerSecond: 5_632_351,
  elapsedSeconds: 770,
  fixedAllowanceSeconds: 55 * 60,
  hourlyUsd: 0.26,
  walletSpentUsd: 0.12,
  walletCapUsd: 1.25,
  wallClockCapSeconds: 120 * 60,
  drainingAtSeconds: 105 * 60,
});
assert.equal(oldDeadline.allowed, false);
assert.equal(oldDeadline.reason, "restore_does_not_fit_draining_deadline");

const revisedGate = evaluateRestoreGate({
  remainingBytes: 35_572_266_487,
  measuredBytesPerSecond: 16 * MIB,
  elapsedSeconds: 8 * 60,
  fixedAllowanceSeconds: 55 * 60,
  hourlyUsd: 0.65,
  walletSpentUsd: 0.08,
  walletCapUsd: 1.25,
  wallClockCapSeconds: 240 * 60,
  drainingAtSeconds: 220 * 60,
});
assert.equal(revisedGate.allowed, true);
assert.ok(revisedGate.projectedSpendUsd <= 1.25);

const observedRateRevisedGate = evaluateRestoreGate({
  remainingBytes: 35_572_266_487,
  measuredBytesPerSecond: 5.63 * MIB,
  elapsedSeconds: 5 * 60,
  fixedAllowanceSeconds: 55 * 60,
  hourlyUsd: 0.26,
  walletSpentUsd: 0,
  walletCapUsd: 1.25,
  wallClockCapSeconds: 240 * 60,
  drainingAtSeconds: 220 * 60,
});
assert.equal(observedRateRevisedGate.band, "slow");
assert.equal(observedRateRevisedGate.allowed, false);
assert.equal(observedRateRevisedGate.reason, "restore_does_not_fit_draining_deadline");
assert.ok(observedRateRevisedGate.projectedSpendUsd <= 1.25);

const ranked = rankRestoreCandidates({
  restoreBytes: 35_572_266_487,
  fixedAllowanceSeconds: 55 * 60,
  drainingAtSeconds: 220 * 60,
  candidates: [
    { id: "historical", compatible: true, downloadMbps: 300, uploadMbps: 100, reliability: 0.997, diskSpeedMbps: 700, hourlyUsd: 0.6 },
    { id: "fast-new", compatible: true, downloadMbps: 900, uploadMbps: 300, reliability: 0.999, diskSpeedMbps: 1200, hourlyUsd: 0.64 },
    { id: "advertised-slow", compatible: true, downloadMbps: 20, uploadMbps: 10, reliability: 0.999, diskSpeedMbps: 900, hourlyUsd: 0.4 },
  ],
  history: [{ candidateId: "historical", probePassed: true, successfulRestore: true }],
});
assert.equal(ranked[0].id, "historical");
assert.equal(ranked.at(-1)?.id, "advertised-slow");
assert.equal(ranked.at(-1)?.rejectionReasons.includes("advertised_bandwidth_clearly_inadequate_for_restore"), true);
assert.equal(ranked[0].scoreEvidence.advertisedDownloadMbps, 300);

const oneQualification = {
  productionOrders: 0,
  qualificationOrders: 1,
  sequentialOrders: 1,
  activeOrders: 0,
  restoreStarted: false,
  inferenceStarted: false,
  cumulativeWalletDeltaUsd: 0.35,
};
assert.deepEqual(mayCreateQualificationOrder(oneQualification, 0.4), { allowed: true, reasons: [] });
assert.equal(decideQualificationOutcome({
  state: { ...oneQualification, activeOrders: 1 },
  probePassed: true,
  dynamicGatePassed: true,
  projectedAlternativeUsd: 0,
}).action, "continue_same_order");
assert.equal(decideQualificationOutcome({
  state: { ...oneQualification, activeOrders: 1 },
  probePassed: false,
  dynamicGatePassed: false,
  projectedAlternativeUsd: 0.4,
}).action, "cancel_then_try_one_alternative");
assert.equal(decideQualificationOutcome({
  state: { ...oneQualification, qualificationOrders: 2, sequentialOrders: 2, activeOrders: 1 },
  probePassed: false,
  dynamicGatePassed: false,
  projectedAlternativeUsd: 0.2,
}).action, "stop_without_replacement");
assert.equal(mayCreateQualificationOrder({
  productionOrders: 0,
  qualificationOrders: 1,
  sequentialOrders: 1,
  activeOrders: 0,
  restoreStarted: true,
  inferenceStarted: false,
  cumulativeWalletDeltaUsd: 0.35,
}, 0.4).allowed, false);
assert.equal(mayCreateQualificationOrder({
  productionOrders: 0,
  qualificationOrders: 2,
  sequentialOrders: 2,
  activeOrders: 0,
  restoreStarted: false,
  inferenceStarted: false,
  cumulativeWalletDeltaUsd: 0.9,
}, 0.4).allowed, false);
assert.equal(mayCreateQualificationOrder({
  ...oneQualification,
  activeOrders: 1,
}, 0.1).allowed, false);
assert.equal(mayCreateQualificationOrder({
  ...oneQualification,
  cumulativeWalletDeltaUsd: 1.1,
}, 0.2).allowed, false);
assert.equal(decideQualificationOutcome({
  state: { ...oneQualification, restoreStarted: true, activeOrders: 1 },
  probePassed: false,
  dynamicGatePassed: false,
  projectedAlternativeUsd: 0.1,
}).action, "stop_without_replacement");
assert.equal(decideQualificationOutcome({
  state: { ...oneQualification, inferenceStarted: true, activeOrders: 1 },
  probePassed: false,
  dynamicGatePassed: false,
  projectedAlternativeUsd: 0.1,
}).action, "stop_without_replacement");

const sanitized = sanitizeRestoreLogText(
  "GET https://example.invalid/model?X-Amz-Signature=abc token=secret password=hunter2 ssh_key=AAA",
);
assert.equal(sanitized.includes("X-Amz"), false);
assert.equal(sanitized.includes("hunter2"), false);
assert.equal(sanitized.includes("AAA"), false);

const python = spawnSync("python", ["scripts/clore/restore-production-r2-tests.py"], {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: 60_000,
});
assert.equal(python.status, 0, `${python.stdout}\n${python.stderr}`);
assert.match(python.stdout, /stage4j7_python_restore_fixtures=passed/);

console.log("stage4j7_throughput_restore_fixtures=passed");
