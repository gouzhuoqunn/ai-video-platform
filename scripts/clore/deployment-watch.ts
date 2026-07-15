import { getCloreDeploymentHold } from "./deployment-hold";
import { loadCloreConfig } from "./config";
import { assertNoSecretOutput, sleep } from "./client";
import { findBootstrapImageCandidates, summarizeBootstrapImageCandidate } from "./bootstrap-image-profile";
import { readLiveMarketplace, readLiveOrdersSummary } from "./live";

function numberArg(name: string, fallback: number) {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  return value && Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

async function main() {
  const rounds = numberArg("rounds", 2);
  const intervalMs = numberArg("interval-ms", 5 * 60 * 1000);
  const config = loadCloreConfig();
  for (let round = 1; round <= rounds; round += 1) {
    const [marketplace, orders] = await Promise.all([readLiveMarketplace(config, { forceRefresh: true }), readLiveOrdersSummary(config, { forceRefresh: true })]);
    const output = { mode: "read_only_deployment_watch", round, rounds, deployment_hold: getCloreDeploymentHold().enabled, active_order: orders.some((order) => order.active), candidates: findBootstrapImageCandidates(marketplace, config).slice(0, 3).map(summarizeBootstrapImageCandidate), create_order_called: false };
    assertNoSecretOutput(JSON.stringify(output));
    console.log(JSON.stringify(output));
    if (round < rounds) await sleep(intervalMs);
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "Clore deployment watch failed"); process.exitCode = 1; });
