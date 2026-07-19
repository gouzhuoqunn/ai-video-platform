import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isManualCandidateDisplayPriceAllowed,
  LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR,
  manualCandidateBasePriceCeiling,
} from "../src/lib/local-lab/gpu-price-filter";

assert.equal(LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR, 5);
assert.equal(isManualCandidateDisplayPriceAllowed(4.99), true, "manual candidates below $5/hour must be visible");
assert.equal(isManualCandidateDisplayPriceAllowed(5), true, "manual candidates at $5/hour must be visible");
assert.equal(isManualCandidateDisplayPriceAllowed(5.000001), false, "manual candidates above $5/hour must be excluded");
assert.equal(isManualCandidateDisplayPriceAllowed(-0.01), false, "negative prices must be excluded");
assert.equal(Number((manualCandidateBasePriceCeiling(0.05) * 1.05).toFixed(6)), 5, "candidate display base-price ceiling must include the renter fee");

const executionConfig = readFileSync("scripts/clore/execution-config.ts", "utf8");
const orderExecution = readFileSync("scripts/clore/order-execution.ts", "utf8");
const cloreConsole = readFileSync("src/lib/local-lab/clore-console.ts", "utf8");
assert.ok(!executionConfig.includes("LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR"), "paid execution config must not use the manual display ceiling");
assert.ok(orderExecution.includes("input.execution.maxGpuPricePerHour"), "paid execution must retain its own hourly authorization cap");
assert.ok(orderExecution.includes("input.execution.firstSessionMaxBudgetUsd"), "paid execution must retain its own budget cap");
assert.ok(cloreConsole.includes("manualCandidateBasePriceCeiling"), "read-only candidates must use the manual display ceiling only");
console.log("Manual GPU candidate price ceiling tests passed.");
