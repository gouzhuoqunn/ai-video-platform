const MIB = 1024 ** 2;

export type RestoreThroughputBand =
  | "healthy"
  | "acceptable_extended"
  | "slow"
  | "inadequate";

export type RestoreProbeObject = {
  objectId: string;
  requestedBytes: number;
  receivedBytes: number;
  durationSeconds: number;
  httpStatuses: number[];
  rangeSupported: boolean;
};

export type RestoreProbeSummary = {
  measuredAt: string;
  requestedBytes: number;
  receivedBytes: number;
  durationSeconds: number;
  aggregateBytesPerSecond: number;
  aggregateMiBPerSecond: number;
  estimatedFullRestoreSeconds: number | null;
  band: RestoreThroughputBand;
  objects: Array<RestoreProbeObject & {
    bytesPerSecond: number;
    mibPerSecond: number;
  }>;
  allRangesAccepted: boolean;
};

export function classifyRestoreThroughput(bytesPerSecond: number): RestoreThroughputBand {
  const mibPerSecond = bytesPerSecond / MIB;
  if (mibPerSecond >= 15) return "healthy";
  if (mibPerSecond >= 8) return "acceptable_extended";
  if (mibPerSecond >= 5) return "slow";
  return "inadequate";
}

export function summarizeRestoreProbe(input: {
  measuredAt?: string;
  durationSeconds: number;
  restoreBytes?: number;
  objects: RestoreProbeObject[];
}): RestoreProbeSummary {
  const receivedBytes = input.objects.reduce((total, object) => total + object.receivedBytes, 0);
  const requestedBytes = input.objects.reduce((total, object) => total + object.requestedBytes, 0);
  const aggregateBytesPerSecond = receivedBytes / Math.max(0.001, input.durationSeconds);
  return {
    measuredAt: input.measuredAt ?? new Date().toISOString(),
    requestedBytes,
    receivedBytes,
    durationSeconds: input.durationSeconds,
    aggregateBytesPerSecond,
    aggregateMiBPerSecond: aggregateBytesPerSecond / MIB,
    estimatedFullRestoreSeconds: input.restoreBytes === undefined
      ? null
      : input.restoreBytes / Math.max(1, aggregateBytesPerSecond),
    band: classifyRestoreThroughput(aggregateBytesPerSecond),
    objects: input.objects.map((object) => {
      const bytesPerSecond = object.receivedBytes / Math.max(0.001, object.durationSeconds);
      return { ...object, bytesPerSecond, mibPerSecond: bytesPerSecond / MIB };
    }),
    allRangesAccepted: input.objects.every((object) =>
      object.rangeSupported && object.httpStatuses.length > 0 && object.httpStatuses.every((status) => status === 206)),
  };
}

export type RestoreGateInput = {
  remainingBytes: number;
  measuredBytesPerSecond: number;
  elapsedSeconds: number;
  fixedAllowanceSeconds: number;
  hourlyUsd: number;
  walletSpentUsd: number;
  walletCapUsd: number;
  wallClockCapSeconds: number;
  drainingAtSeconds: number;
  safetyMultiplier?: number;
};

export type RestoreGateResult = {
  allowed: boolean;
  reason: string;
  band: RestoreThroughputBand;
  rawRestoreEtaSeconds: number;
  guardedRestoreEtaSeconds: number;
  projectedAdditionalBillingSeconds: number;
  projectedCompletionSeconds: number;
  projectedSpendUsd: number;
  remainingWallClockSeconds: number;
  remainingWalletUsd: number;
  safetyMultiplier: number;
};

export function evaluateRestoreGate(input: RestoreGateInput): RestoreGateResult {
  const band = classifyRestoreThroughput(input.measuredBytesPerSecond);
  const safetyMultiplier = input.safetyMultiplier ??
    (band === "healthy" ? 1.2 : band === "acceptable_extended" ? 1.35 : band === "slow" ? 1.6 : 2);
  const rawRestoreEtaSeconds = input.remainingBytes / Math.max(1, input.measuredBytesPerSecond);
  const guardedRestoreEtaSeconds = rawRestoreEtaSeconds * safetyMultiplier;
  const projectedAdditionalBillingSeconds = guardedRestoreEtaSeconds + input.fixedAllowanceSeconds;
  const projectedCompletionSeconds = input.elapsedSeconds + projectedAdditionalBillingSeconds;
  const projectedSpendUsd = input.walletSpentUsd + input.hourlyUsd * projectedAdditionalBillingSeconds / 3600;
  const remainingWallClockSeconds = Math.max(0, Math.min(input.wallClockCapSeconds, input.drainingAtSeconds) - input.elapsedSeconds);
  const remainingWalletUsd = Math.max(0, input.walletCapUsd - input.walletSpentUsd);
  let reason = "restore_gate_passed";
  if (!Number.isFinite(input.measuredBytesPerSecond) || input.measuredBytesPerSecond <= 0 || band === "inadequate") {
    reason = "restore_probe_throughput_inadequate";
  } else if (projectedCompletionSeconds > input.drainingAtSeconds) {
    reason = "restore_does_not_fit_draining_deadline";
  } else if (projectedCompletionSeconds > input.wallClockCapSeconds) {
    reason = "restore_does_not_fit_wall_clock_cap";
  } else if (projectedSpendUsd > input.walletCapUsd) {
    reason = "restore_does_not_fit_wallet_cap";
  }
  return {
    allowed: reason === "restore_gate_passed",
    reason,
    band,
    rawRestoreEtaSeconds,
    guardedRestoreEtaSeconds,
    projectedAdditionalBillingSeconds,
    projectedCompletionSeconds,
    projectedSpendUsd,
    remainingWallClockSeconds,
    remainingWalletUsd,
    safetyMultiplier,
  };
}

export type RestoreCandidate = {
  id: string;
  compatible: boolean;
  incompatibilityReasons?: string[];
  downloadMbps: number | null;
  uploadMbps: number | null;
  reliability: number | null;
  diskSpeedMbps: number | null;
  hourlyUsd: number | null;
};

export type RestoreCandidateHistory = {
  candidateId: string;
  actualProbeMiBPerSecond?: number;
  probePassed?: boolean;
  successfulRestore?: boolean;
};

export type RankedRestoreCandidate = RestoreCandidate & {
  rejected: boolean;
  rejectionReasons: string[];
  historicalTier: number;
  advertisedRestoreEtaSeconds: number | null;
  scoreEvidence: {
    compatibility: "pass" | "reject";
    historical: "known_good_restore" | "probe_passed" | "probe_failed" | "unknown";
    advertisedDownloadMbps: number | null;
    advertisedUploadMbps: number | null;
    advertisedRestoreEtaSeconds: number | null;
    reliability: number | null;
    diskSpeedMbps: number | null;
    hourlyUsd: number | null;
  };
};

export function rankRestoreCandidates(input: {
  candidates: RestoreCandidate[];
  history?: RestoreCandidateHistory[];
  restoreBytes: number;
  fixedAllowanceSeconds: number;
  drainingAtSeconds: number;
  advertisedEfficiency?: number;
}): RankedRestoreCandidate[] {
  const history = new Map((input.history ?? []).map((entry) => [entry.candidateId, entry]));
  const efficiency = input.advertisedEfficiency ?? 0.55;
  const ranked = input.candidates.map((candidate): RankedRestoreCandidate => {
    const prior = history.get(candidate.id);
    const historicalTier = prior?.successfulRestore ? 3 : prior?.probePassed ? 2 : prior?.probePassed === false ? 0 : 1;
    const advertisedBytesPerSecond = candidate.downloadMbps === null
      ? null
      : candidate.downloadMbps * 1_000_000 / 8 * efficiency;
    const advertisedRestoreEtaSeconds = advertisedBytesPerSecond === null
      ? null
      : input.restoreBytes / Math.max(1, advertisedBytesPerSecond);
    const rejectionReasons = [...(candidate.incompatibilityReasons ?? [])];
    if (!candidate.compatible) rejectionReasons.push("base_candidate_incompatible");
    if (advertisedRestoreEtaSeconds !== null &&
        advertisedRestoreEtaSeconds + input.fixedAllowanceSeconds > input.drainingAtSeconds) {
      rejectionReasons.push("advertised_bandwidth_clearly_inadequate_for_restore");
    }
    if (prior?.probePassed === false) rejectionReasons.push("historical_actual_source_probe_failed");
    return {
      ...candidate,
      rejected: rejectionReasons.length > 0,
      rejectionReasons: [...new Set(rejectionReasons)],
      historicalTier,
      advertisedRestoreEtaSeconds,
      scoreEvidence: {
        compatibility: candidate.compatible ? "pass" : "reject",
        historical: prior?.successfulRestore
          ? "known_good_restore"
          : prior?.probePassed
            ? "probe_passed"
            : prior?.probePassed === false
              ? "probe_failed"
              : "unknown",
        advertisedDownloadMbps: candidate.downloadMbps,
        advertisedUploadMbps: candidate.uploadMbps,
        advertisedRestoreEtaSeconds,
        reliability: candidate.reliability,
        diskSpeedMbps: candidate.diskSpeedMbps,
        hourlyUsd: candidate.hourlyUsd,
      },
    };
  });
  return ranked.sort((left, right) => {
    if (left.rejected !== right.rejected) return left.rejected ? 1 : -1;
    if (left.historicalTier !== right.historicalTier) return right.historicalTier - left.historicalTier;
    const leftAdvertised = left.downloadMbps ?? -1;
    const rightAdvertised = right.downloadMbps ?? -1;
    if (leftAdvertised !== rightAdvertised) return rightAdvertised - leftAdvertised;
    const leftReliability = left.reliability ?? -1;
    const rightReliability = right.reliability ?? -1;
    if (leftReliability !== rightReliability) return rightReliability - leftReliability;
    const leftDisk = left.diskSpeedMbps ?? -1;
    const rightDisk = right.diskSpeedMbps ?? -1;
    if (leftDisk !== rightDisk) return rightDisk - leftDisk;
    return (left.hourlyUsd ?? Number.POSITIVE_INFINITY) - (right.hourlyUsd ?? Number.POSITIVE_INFINITY);
  });
}

export type QualificationState = {
  productionOrders: number;
  qualificationOrders: number;
  sequentialOrders?: number;
  activeOrders: number;
  restoreStarted: boolean;
  inferenceStarted: boolean;
  cumulativeWalletDeltaUsd: number;
};

export function mayCreateQualificationOrder(state: QualificationState, projectedAdditionalUsd: number) {
  const reasons: string[] = [];
  if (state.activeOrders >= 1) reasons.push("maximum_active_orders_reached");
  if (state.productionOrders >= 1) reasons.push("maximum_production_orders_reached");
  if (state.qualificationOrders >= 2) reasons.push("maximum_qualification_orders_reached");
  if ((state.sequentialOrders ?? state.qualificationOrders) >= 2) reasons.push("maximum_sequential_orders_reached");
  if ((state.restoreStarted || state.inferenceStarted) && state.qualificationOrders >= 1) {
    reasons.push("replacement_forbidden_after_restore_or_inference");
  }
  if (state.cumulativeWalletDeltaUsd + projectedAdditionalUsd > 1.25) reasons.push("combined_wallet_cap_exceeded");
  return { allowed: reasons.length === 0, reasons };
}

export function decideQualificationOutcome(input: {
  state: QualificationState;
  probePassed: boolean;
  dynamicGatePassed: boolean;
  projectedAlternativeUsd: number;
}) {
  if (input.probePassed && input.dynamicGatePassed) {
    return { action: "continue_same_order" as const, reasons: [] as string[] };
  }
  if (input.state.restoreStarted || input.state.inferenceStarted) {
    return { action: "stop_without_replacement" as const, reasons: ["replacement_forbidden_after_restore_or_inference"] };
  }
  const next = mayCreateQualificationOrder(
    { ...input.state, activeOrders: 0 },
    input.projectedAlternativeUsd,
  );
  return next.allowed
    ? { action: "cancel_then_try_one_alternative" as const, reasons: [] as string[] }
    : { action: "stop_without_replacement" as const, reasons: next.reasons };
}

export function sanitizeRestoreLogText(value: string) {
  return value
    .replace(/https:\/\/[^\s"'<>]+/gi, "<redacted-url>")
    .replace(/\b(authorization|token|secret|password|ssh_key|access_key|signature)\b\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>");
}

export function buildExactRanges(totalBytes: number, streamCount: number) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw new Error("range_total_invalid");
  if (!Number.isSafeInteger(streamCount) || streamCount < 1 || streamCount > 64) throw new Error("range_stream_count_invalid");
  const count = Math.min(streamCount, totalBytes);
  const base = Math.floor(totalBytes / count);
  const remainder = totalBytes % count;
  let cursor = 0;
  return Array.from({ length: count }, (_, index) => {
    const length = base + (index < remainder ? 1 : 0);
    const range = { index, start: cursor, end: cursor + length - 1, length };
    cursor += length;
    return range;
  });
}
