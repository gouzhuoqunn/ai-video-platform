import { normalizeCloreServer } from "./marketplace";
import type { CloreCandidate, CloreConfig, RawCloreServer } from "./types";
import type { MarketplaceFilterCounts, MarketplaceReadEvidence } from "./live";

export type MarketScanEvidence = {
  scannedAt: string;
  totalServerCount: number | null;
  compliantCandidateCount: number | null;
  rejectedServerIds: string[];
  attemptedServerIds: string[];
  selectedServerId: string | null;
  selectedHourlyUsd: number | null;
  filterCounts: MarketplaceFilterCounts | null;
  marketplaceRead?: Pick<MarketplaceReadEvidence, "classification" | "httpStatus" | "contentType" | "responseByteLength" | "bodySha256" | "selectedListField" | "rawListingCount">;
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
  const rejectionCounts: Record<string, number> = {};
  for (const candidate of normalized) {
    for (const reason of candidate.rejectionReasons) rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
    if (input.attemptedServerIds.has(candidate.serverId)) rejectionCounts["already_attempted"] = (rejectionCounts["already_attempted"] ?? 0) + 1;
  }
  const exact = normalized.filter((candidate) => candidate.gpuNormalizedName === input.config.targetGpu);
  const rentable = exact.filter((candidate) => candidate.rentable);
  const onDemand = rentable.filter((candidate) => candidate.orderType === "on-demand");
  const priceCompliant = onDemand.filter((candidate) => candidate.priceUsdPerHour !== null && candidate.priceUsdPerHour <= input.config.maxGpuPricePerHour);
  const hardwareDeploymentCompliant = priceCompliant.filter((candidate) =>
    /^[1-9]\d*$/.test(candidate.serverId) &&
    candidate.gpuCount === 1 &&
    candidate.hostOnline !== false &&
    candidate.gpuMemoryAccepted &&
    (candidate.ramGb ?? 0) >= input.config.minRamGb &&
    (candidate.cpuCores ?? 0) >= input.config.minCpuCores &&
    (candidate.diskGb ?? 0) >= input.config.minDiskGb &&
    (candidate.downloadMbps ?? 0) >= input.config.minDownloadMbps &&
    (candidate.uploadMbps ?? 0) >= input.config.minUploadMbps &&
    candidate.supportsDocker &&
    candidate.supportsSsh &&
    candidate.driverCompatible !== false,
  );
  const compliant = normalized
    .filter((candidate) => candidate.rejectionReasons.length === 0)
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
      filterCounts: {
        totalProviderListings: normalized.length,
        exactRtx4090Listings: exact.length,
        rentableRtx4090Listings: rentable.length,
        onDemandRtx4090Listings: onDemand.length,
        priceCompliantListings: priceCompliant.length,
        hardwareDeploymentCompliantListings: hardwareDeploymentCompliant.length,
        fullyCompliantCandidates: compliant.length,
        rejectionCounts,
      },
    },
  };
}
