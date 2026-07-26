import { normalizeCloreServer } from "./marketplace";
import type { CloreCandidate, CloreConfig, RawCloreServer } from "./types";

export type MarketScanEvidence = {
  scannedAt: string;
  totalServerCount: number;
  compliantCandidateCount: number;
  rejectedServerIds: string[];
  attemptedServerIds: string[];
  selectedServerId: string | null;
  selectedHourlyUsd: number | null;
};

/** A fresh provider response only; no persisted candidate or UI cache enters here. */
export function rankFreshMarketplaceCandidates(input: {
  marketplace: RawCloreServer[];
  config: CloreConfig;
  attemptedServerIds: ReadonlySet<string>;
  now?: () => string;
}): { candidates: CloreCandidate[]; evidence: MarketScanEvidence } {
  const scannedAt = (input.now ?? (() => new Date().toISOString()))();
  const normalized = input.marketplace.map((server) => normalizeCloreServer(server, input.config));
  const compliant = normalized
    .filter((candidate) => candidate.rejectionReasons.length === 0)
    .filter((candidate) => candidate.priceOriginalAmount !== null && candidate.priceOriginalUnit === "day")
    .filter((candidate) => !input.attemptedServerIds.has(candidate.serverId))
    .sort((left, right) =>
      (left.priceUsdPerHour ?? Number.POSITIVE_INFINITY) - (right.priceUsdPerHour ?? Number.POSITIVE_INFINITY) ||
      (right.reliability ?? Number.NEGATIVE_INFINITY) - (left.reliability ?? Number.NEGATIVE_INFINITY) ||
      left.serverId.localeCompare(right.serverId),
    );
  const selected = compliant[0] ?? null;
  return {
    candidates: compliant,
    evidence: {
      scannedAt,
      totalServerCount: normalized.length,
      compliantCandidateCount: compliant.length,
      rejectedServerIds: normalized.filter((candidate) => candidate.rejectionReasons.length > 0 || input.attemptedServerIds.has(candidate.serverId)).map((candidate) => candidate.serverId).slice(0, 50),
      attemptedServerIds: [...input.attemptedServerIds],
      selectedServerId: selected?.serverId ?? null,
      selectedHourlyUsd: selected?.priceUsdPerHour ?? null,
    },
  };
}
