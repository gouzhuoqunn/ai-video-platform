import { readFileSync } from "node:fs";
import path from "node:path";
import { assertCloreApiKey, loadCloreConfig } from "./config";
import { assertNoSecretOutput } from "./client";
import { readLiveMarketplace, readWalletSummary } from "./live";
import { applyWalletBalance, evaluateMarketplace, summarizeCandidate } from "./marketplace";
import type { RawCloreServer } from "./types";
import { writeSanitizedFixture } from "./fixtures";

function readMockMarketplace() {
  return JSON.parse(readFileSync(path.join(process.cwd(), "scripts", "clore", "mock-marketplace.json"), "utf8")) as RawCloreServer[];
}

function closestRejected(candidates: ReturnType<typeof applyWalletBalance>) {
  return candidates
    .filter((candidate) => /rtx\s+5090/i.test(candidate.gpu))
    .sort((left, right) => left.rejectionReasons.length - right.rejectionReasons.length)
    .slice(0, 5)
    .map((candidate) => ({
      ...summarizeCandidate(candidate),
      rejection_reasons: candidate.rejectionReasons,
    }));
}

async function main() {
  const config = loadCloreConfig();
  const mock = process.argv.includes("--mock");
  if (!mock) {
    assertCloreApiKey(config);
  }
  const wallet = mock ? { availableUsdBalance: null } : await readWalletSummary(config);
  const rawServers = mock ? readMockMarketplace() : await readLiveMarketplace(config);
  const evaluated = evaluateMarketplace(rawServers, config);
  const candidates = applyWalletBalance(evaluated.candidates, wallet.availableUsdBalance);
  const matches = applyWalletBalance(evaluated.matches, wallet.availableUsdBalance);
  const payload = {
    mode: mock ? "mock-marketplace" : "live-marketplace-read-only",
    api_key_loaded: mock ? false : Boolean(config.apiKey),
    filters: {
      gpu: "exact RTX 5090",
      gpu_count: 1,
      order_type: "on-demand",
      max_usd_per_hour: config.maxGpuPricePerHour,
      min_reliability: config.minReliability,
      min_rating: config.minRating,
      min_rating_count: config.minRatingCount,
      min_ram_gb: config.minRamGb,
      min_cpu_cores: config.minCpuCores,
      min_disk_gb: config.minDiskGb,
      min_download_mbps: config.minDownloadMbps,
      min_upload_mbps: config.minUploadMbps,
      assumed_minimum_rental_hours: config.assumedMinimumRentalHours,
    },
    wallet: {
      available_usd_balance: wallet.availableUsdBalance,
      source: mock ? "mock mode, wallet not queried" : "live wallet read-only",
    },
    matches: matches.slice(0, 5).map(summarizeCandidate),
    closest_rejected_5090: matches.length === 0 ? closestRejected(candidates) : undefined,
    rejected_summary:
      matches.length === 0
        ? {
            total_servers_checked: candidates.length,
            rtx5090_like_rejected: candidates.filter((candidate) => /rtx\s+5090/i.test(candidate.gpu)).length,
            note: "Only closest rejected RTX 5090-like candidates are shown; full raw marketplace response is not printed.",
          }
        : undefined,
    note: "No order was created. Spot, 4090 fallback, and relaxed privacy filters are not used.",
  };
  const output = JSON.stringify(payload, null, 2);
  assertNoSecretOutput(output);
  if (!mock) {
    writeSanitizedFixture("latest-marketplace", payload);
  }
  console.log(output);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "clore find failed");
  process.exitCode = 1;
});
