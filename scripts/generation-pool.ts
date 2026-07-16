import { assertNoSecretOutput } from "./clore/client";
import { findBootstrapImageCandidates } from "./clore/bootstrap-image-profile";
import { loadCloreConfig } from "./clore/config";
import { readLiveMarketplace } from "./clore/live";
import { applyMarketObservation, armGenerationPool, generationPoolSummary, readGenerationPool, type PoolCandidate } from "../src/lib/generation/task-pool";

function asPoolCandidate(candidate: ReturnType<typeof findBootstrapImageCandidates>[number]): PoolCandidate {
  return {
    serverId: candidate.serverId,
    gpu: candidate.gpu,
    vramGb: candidate.gpuMemoryGb ?? 0,
    reliability: candidate.reliability,
    rating: candidate.rating,
    projectedCostUsd: candidate.projectedFirstImageCostUsd ?? Number.POSITIVE_INFINITY,
    hourlyUsd: candidate.effectivePriceUsdPerHour ?? Number.POSITIVE_INFINITY,
  };
}

async function dryRun() {
  const armed = armGenerationPool();
  if (!armed.armed) return { ...generationPoolSummary(armed.state), orderWouldBeCreated: false, exactReason: armed.reason, marketplaceRequestMade: false };
  const state = readGenerationPool();
  const nextAt = state.scheduler.nextMarketplaceRequestAt ? Date.parse(state.scheduler.nextMarketplaceRequestAt) : 0;
  if (nextAt > Date.now()) return { ...generationPoolSummary(state), orderWouldBeCreated: false, exactReason: `一分钟限频生效；下次只读查询时间为 ${state.scheduler.nextMarketplaceRequestAt}。`, marketplaceRequestMade: false };
  const config = loadCloreConfig();
  if (!config.apiKey) return { ...generationPoolSummary(state), orderWouldBeCreated: false, exactReason: "缺少本地 Clore 只读凭据，未查询市场。", marketplaceRequestMade: false };
  const candidates = findBootstrapImageCandidates(await readLiveMarketplace(config, { forceRefresh: true }), config).map(asPoolCandidate);
  const observed = applyMarketObservation(candidates);
  return { ...generationPoolSummary(observed.state), orderWouldBeCreated: observed.orderWouldBeCreated, exactReason: observed.reason, selectedCandidate: observed.candidate ? { serverId: observed.candidate.serverId, gpu: observed.candidate.gpu, hourlyUsd: observed.candidate.hourlyUsd, projectedCostUsd: observed.candidate.projectedCostUsd } : null, marketplaceRequestMade: true };
}

async function main() {
  const command = process.argv[2] ?? "status";
  const output = command === "status" ? generationPoolSummary() : command === "arm" ? (() => { const result = armGenerationPool(); return { ...generationPoolSummary(result.state), armed: result.armed, reusedPersistedBatch: result.reusedPersistedBatch, exactReason: result.reason }; })() : command === "dry-run" ? await dryRun() : (() => { throw new Error("Use status, arm, or dry-run."); })();
  const text = JSON.stringify(output, null, 2);
  assertNoSecretOutput(text);
  console.log(text);
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "generation pool command failed"); process.exitCode = 1; });
