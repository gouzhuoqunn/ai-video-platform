import { calculateSessionCost, calculateVolumeBreakEven, DEFAULT_SESSION_COST_INPUT } from "../session-cost";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const result = calculateSessionCost(DEFAULT_SESSION_COST_INPUT);
  assert(result.currentSingleSessionCostUsd === 4.9, "current cold session should cost 4.90 USD.");
  assert(result.optimizedSingleSessionCostUsd === 4.38, "optimized warm session should cost 4.38 USD.");
  assert(result.savingsPerSessionMinutes === 45, "warm start should save 45 minutes.");
  assert(result.r2MonthlyCostUsd === 0.36, "R2 model cache storage should cost about 0.36 USD/month.");
  assert(result.monthlyTotalUsd["2"] === 9.12, "two monthly sessions plus R2 should cost 9.12 USD.");
  assert(result.theoreticalSessionsFromBalance === 2, "11 USD should theoretically cover two optimized sessions.");
  assert(result.safeSessionsFromBalance === 2, "11 USD with 1 USD reserve should still plan two optimized sessions.");
  assert(result.idleShutdownMinutes === 15, "idle shutdown threshold should be 15 minutes.");
  assert(calculateVolumeBreakEven(DEFAULT_SESSION_COST_INPUT) === 0.23, "Clore volume break-even should be about 0.23 USD/month.");

  const keepVolume = calculateSessionCost({ ...DEFAULT_SESSION_COST_INPUT, volumeExtraMonthlyCost: 0.2 });
  const rejectVolume = calculateSessionCost({ ...DEFAULT_SESSION_COST_INPUT, volumeExtraMonthlyCost: 0.3 });
  assert(keepVolume.shouldKeepVolume, "volume should be kept only below break-even.");
  assert(!rejectVolume.shouldKeepVolume, "volume should be rejected above break-even.");

  console.log("Session cost tests passed.");
}

void main();
