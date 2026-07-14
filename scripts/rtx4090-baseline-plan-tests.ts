import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type Rtx4090Plan = {
  schemaVersion: 1;
  profile: string;
  status: string;
  noRealRental: boolean;
  requiresExplicitFutureApproval: boolean;
  cloreOrderExecutionEnabledRequired: boolean;
  budget: { maxSessionHours: number; diskGbMinimum: number; stopAfterFirstSyntheticSmoke: boolean };
  candidates: Array<{ candidateKey: string; slot: string; workflowAsset: string; executionStatus: string; estimatedDiskGb: number; timeoutSeconds: number; smokeSamples: number }>;
  excludedFirstRoundCandidates: string[];
  excludedCandidateFamilies: string[];
};

function main() {
  const plan = JSON.parse(readFileSync("benchmark/rtx4090-baseline-plan.json", "utf8")) as Rtx4090Plan;
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.profile, "rtx4090");
  assert.equal(plan.status, "plan_only_no_gpu_execution");
  assert.equal(plan.noRealRental, true);
  assert.equal(plan.requiresExplicitFutureApproval, true);
  assert.equal(plan.cloreOrderExecutionEnabledRequired, false);
  assert.equal(plan.budget.maxSessionHours, 6);
  assert.equal(plan.budget.diskGbMinimum, 200);
  assert.equal(plan.budget.stopAfterFirstSyntheticSmoke, true);
  assert.deepEqual(
    plan.candidates.map((candidate) => candidate.candidateKey).sort(),
    ["flux2-klein-4b-official", "wan22-ti2v-5b-official"],
  );
  assert.ok(plan.excludedFirstRoundCandidates.includes("flux2-klein-9b-official"));
  assert.ok(plan.excludedFirstRoundCandidates.includes("wan22-a14b-i2v-fp8-official"));
  for (const blocked of ["community-phr00t-aio-second-round", "community-gguf-second-round", "community-kijai-second-round", "flux2-dev-quant-5090"]) {
    assert.ok(plan.excludedCandidateFamilies.includes(blocked), `${blocked} must stay out of the first RTX 4090 round`);
  }
  for (const candidate of plan.candidates) {
    assert.match(candidate.workflowAsset, /^comfy-runtime\/workflows\/official\//);
    assert.ok(candidate.estimatedDiskGb > 0);
    assert.ok(candidate.timeoutSeconds > 0);
    assert.equal(candidate.smokeSamples, 1);
  }
  console.log("RTX 4090 baseline plan tests passed");
}

main();
