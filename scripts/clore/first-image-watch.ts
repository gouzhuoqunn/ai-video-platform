import { loadCloreConfig } from "./config";
import { assertNoSecretOutput, sleep } from "./client";
import { readLiveMarketplace, readLiveOrdersSummary, readWalletSummary } from "./live";
import { findBootstrapImageCandidates, summarizeBootstrapImageCandidate } from "./bootstrap-image-profile";

const WATCH_INTERVAL_MS = 5 * 60 * 1000;
const WATCH_TIMEOUT_MS = 60 * 60 * 1000;

async function main() {
  const config = loadCloreConfig();
  const startedAt = Date.now();
  while (Date.now() - startedAt < WATCH_TIMEOUT_MS) {
    const [wallet, orders, marketplace] = await Promise.all([readWalletSummary(config), readLiveOrdersSummary(config), readLiveMarketplace(config)]);
    const active = orders.find((order) => order.active);
    const candidates = active ? [] : findBootstrapImageCandidates(marketplace, config);
    const output = JSON.stringify({
      mode: "read_only_first_image_candidate_watch",
      active_order: Boolean(active),
      available_usd_balance: wallet.availableUsdBalance,
      candidate_available: candidates.length > 0,
      candidates: candidates.slice(0, 3).map(summarizeBootstrapImageCandidate),
      elapsed_minutes: Math.floor((Date.now() - startedAt) / 60000),
      next_action: candidates.length > 0 ? "recheck candidate, wallet, and active order before one guarded create" : "wait",
      creates_order: false,
    }, null, 2);
    assertNoSecretOutput(output);
    console.log(output);
    if (candidates.length > 0) return;
    await sleep(WATCH_INTERVAL_MS);
  }
  console.log(JSON.stringify({ mode: "read_only_first_image_candidate_watch", candidate_available: false, timed_out_minutes: 60, creates_order: false }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "first-image watch failed");
  process.exitCode = 1;
});
