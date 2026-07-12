import { assertCloreApiKey, loadCloreConfig } from "./config";
import { assertNoSecretOutput } from "./client";
import { readLiveMarketplace, readWalletSummary } from "./live";
import { applyWalletBalance, evaluateMarketplace } from "./marketplace";
import { writeSanitizedFixture } from "./fixtures";

async function main() {
  const config = loadCloreConfig();
  assertCloreApiKey(config);
  const summary = await readWalletSummary(config);
  const { matches } = evaluateMarketplace(await readLiveMarketplace(config), config);
  const cheapest = applyWalletBalance(matches, summary.availableUsdBalance)[0];
  const payload = {
    mode: "live-wallet-read-only",
    balances: summary.balances.map((balance) => ({
      name: balance.name,
      currency: balance.currency,
      available: balance.balance,
      usd_like: balance.isUsdLike,
    })),
    available_usd_balance: summary.availableUsdBalance,
    balance_source: summary.source,
    planned_order_currency: config.rentalCurrency,
    cheapest_compliant_5090: cheapest
      ? {
          server_id: cheapest.serverId,
          usd_per_hour: cheapest.priceUsdPerHour,
          six_hour_cost_usd: cheapest.sixHourCostUsd,
          balance_sufficient_for_6h: cheapest.balanceSufficientForSixHours,
          balance_margin_usd: cheapest.balanceMarginUsd,
        }
      : null,
    balance_changes_made: false,
    hidden_sensitive_fields: ["deposit addresses", "full wallet object", "api key"],
  };
  const output = JSON.stringify(payload, null, 2);
  assertNoSecretOutput(output);
  writeSanitizedFixture("latest-wallet", payload);
  console.log(output);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "clore wallet failed");
  process.exitCode = 1;
});
