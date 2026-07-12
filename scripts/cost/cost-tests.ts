import { calculateSessionCost, DEFAULT_SESSION_COST_INPUT } from "./session-cost";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const result = calculateSessionCost(DEFAULT_SESSION_COST_INPUT);
  assert(result.coldSessionCostUsd === 4.2, "6h at 0.70 USD/h must cost 4.20 USD.");
  assert(result.r2MonthlyCostUsd === 0.36, "34.2GB with 10GB free at 0.015 USD/GB-month must cost 0.36 USD/month.");
  assert(result.fullPlannedSessionsFromBalance === 2, "11 USD should support two full planned sessions.");
  assert(result.fullPlannedSessionsAfterReserve === 2, "10 usable USD should support two full planned sessions.");
  assert(result.idleShutdownThresholdMinutes === 15, "idle shutdown threshold must stay 15 minutes.");
  assert(result.drainAtMinutes === 330, "drain should start at 5h30m.");
  assert(result.cleanupAtMinutes === 380, "cleanup safety plan should be around 6h20m.");
  assert(result.volumeBreakEvenUsdPerMonth === 0.23, "2 sessions saving 10 minutes each at 0.70 USD/h should break even at about 0.23 USD/month.");
  console.log("Cost session tests passed.");
}

void main();
