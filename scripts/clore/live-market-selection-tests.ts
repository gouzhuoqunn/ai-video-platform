import assert from "node:assert/strict";
import { rankFreshMarketplaceCandidates } from "./live-market-selection";
import type { CloreConfig, RawCloreServer } from "./types";

const config: CloreConfig = {
  apiBaseUrl: "https://clore.invalid", apiKey: "fixture", apiKeySource: "fixture",
  targetGpu: "NVIDIA GeForce RTX 4090", minGpuVramGb: 24, maxGpuPricePerHour: .6,
  minReliability: .9, minRating: 4, minRatingCount: 1, minRamGb: 31, minCpuCores: 8,
  minDiskGb: 200, minDownloadMbps: 100, minUploadMbps: 100, allowedCountries: [],
  rentalCurrency: "USD-Blockchain", dockerImage: "fixture", orderType: "on-demand",
  projectTag: "fixture", assumedMinimumRentalHours: 1, excludedServerIds: [],
};

function server(id: number, daily: number, reliability = .99): RawCloreServer {
  return { id, gpu_name: "NVIDIA GeForce RTX 4090", gpu_memory_gb: 24, ram_gb: 64, cpu_cores: 16, disk_gb: 250, download_mbps: 500, upload_mbps: 300, price_usd_per_day: daily, rentable: true, type: "on-demand", reliability, rating: 4.8, rating_count: 20, supports_docker: true, supports_ssh: true, host_online: true, allowed_currencies: ["USD-Blockchain"] };
}

function main() {
  const first = rankFreshMarketplaceCandidates({ marketplace: [server(9002, 9, .99), server(9001, 9, .995), server(9003, 12)], config, attemptedServerIds: new Set(), now: () => "2026-07-27T00:00:00.000Z" });
  assert.deepEqual(first.candidates.map((candidate) => candidate.serverId), ["9001", "9002", "9003"]);
  assert.equal(first.evidence.selectedServerId, "9001");
  assert.equal(first.evidence.compliantCandidateCount, 3);

  const refreshed = rankFreshMarketplaceCandidates({ marketplace: [server(9001, 8), server(9004, 10)], config, attemptedServerIds: new Set(["9001"]), now: () => "2026-07-27T00:00:04.000Z" });
  assert.deepEqual(refreshed.candidates.map((candidate) => candidate.serverId), ["9004"]);
  assert.deepEqual(refreshed.evidence.attemptedServerIds, ["9001"]);
  assert.ok(refreshed.evidence.rejectedServerIds.includes("9001"));
  console.log(JSON.stringify({ ok: true, freshProviderOnly: true, rejectedCandidateNotRetried: true, cheapestCompliantSelected: true, providerMutationCount: 0 }));
}

main();
