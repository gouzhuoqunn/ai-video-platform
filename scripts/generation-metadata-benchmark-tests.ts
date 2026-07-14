import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BENCHMARK_SAMPLES } from "../benchmarks/v1/suite";
import { blindReviewId, canRunQualityBenchmark, isProductionPromotionAllowed, MANUAL_IMAGE_SCORES, MANUAL_VIDEO_SCORES, OBJECTIVE_BENCHMARK_METRICS, SMOKE_TEST_PLAN } from "../src/lib/generation/benchmark-plan";
import { requiredDiskGbForProfile } from "../src/lib/generation/gpu-profiles";
import { FIRST_ROUND_METADATA_AUDITS, getReportedBaselineTotalGb, isFullRevision } from "../src/lib/generation/model-metadata";
import { getFirstRoundBaselines, MODEL_CANDIDATES, validateModelCandidate } from "../src/lib/generation/model-registry";
import { FIRST_ROUND_CAPACITY_PLAN, PRODUCTION_CURRENT_JSON_KEYS, PRODUCTION_PROFILE_PATHS, R2_SHARED_COMPONENT_PREFIXES, withDiskReserve } from "../src/lib/generation/r2-cache-plan";
import { WORKFLOW_TEMPLATES } from "../src/lib/generation/workflow-registry";

function main() {
  const firstRound = getFirstRoundBaselines();
  assert.deepEqual(firstRound.map((candidate) => candidate.key).sort(), [
    "flux2-klein-4b-official",
    "flux2-klein-9b-official",
    "wan22-a14b-i2v-fp8-official",
    "wan22-ti2v-5b-official",
  ]);
  assert.equal(FIRST_ROUND_METADATA_AUDITS.length, 4);
  assert.equal(new Set(FIRST_ROUND_METADATA_AUDITS.map((audit) => audit.candidateKey)).size, 4);

  for (const candidate of MODEL_CANDIDATES) {
    assert.deepEqual(validateModelCandidate(candidate), [], `${candidate.key} must satisfy the model schema`);
    if (candidate.benchmark_round === "second") assert.notEqual(candidate.status, "eligible_for_benchmark", "second-round candidates cannot be eligible until metadata is locked");
    if (candidate.status === "eligible_for_benchmark") assert.match(candidate.revision, /^[a-f0-9]{40}$/, "eligible candidates need immutable revisions");
  }
  for (const audit of FIRST_ROUND_METADATA_AUDITS) {
    assert.ok(audit.license.length > 0, `${audit.candidateKey} needs a license`);
    assert.equal(audit.metadataStatus, MODEL_CANDIDATES.find((candidate) => candidate.key === audit.candidateKey)?.status);
    assert.equal(audit.linuxAmd64, true);
    if (audit.access === "gated") {
      assert.equal(audit.anonymousReadable, false);
      assert.ok(audit.userActionRequired.length > 0, "gated metadata must record user action");
    } else {
      assert.ok(isFullRevision(audit.revision), `${audit.candidateKey} must use a full revision SHA`);
    }
    for (const file of audit.files) {
      assert.ok(file.verification !== undefined);
      assert.ok(file.sha256 === null || /^[a-f0-9]{64}$/.test(file.sha256));
    }
  }

  assert.equal(getReportedBaselineTotalGb(), 173.93);
  assert.equal(FIRST_ROUND_CAPACITY_PLAN.conservativeCacheGb, 173.93);
  assert.equal(FIRST_ROUND_CAPACITY_PLAN.verifiedDedupGb, 0, "never dedupe without matching hashes");
  assert.equal(FIRST_ROUND_CAPACITY_PLAN.requiredDisk4090Gb, withDiskReserve(38.28));
  assert.equal(FIRST_ROUND_CAPACITY_PLAN.requiredDisk5090Gb, withDiskReserve(135.65));
  assert.equal(requiredDiskGbForProfile("rtx4090", FIRST_ROUND_CAPACITY_PLAN.session4090Gb), 200);
  assert.equal(requiredDiskGbForProfile("rtx5090", FIRST_ROUND_CAPACITY_PLAN.session5090Gb), 250);

  const images = BENCHMARK_SAMPLES.filter((sample) => sample.kind === "image");
  const videos = BENCHMARK_SAMPLES.filter((sample) => sample.kind === "video");
  assert.equal(images.length, 8);
  assert.equal(videos.length, 8);
  assert.equal(new Set(BENCHMARK_SAMPLES.map((sample) => sample.blindSampleId)).size, BENCHMARK_SAMPLES.length);
  for (const sample of BENCHMARK_SAMPLES) {
    assert.ok(sample.prompt.length > 0 && sample.negativePrompt.length > 0);
    assert.ok(Number.isInteger(sample.seed));
    assert.ok(sample.width > 0 && sample.height > 0 && sample.frames > 0 && sample.steps > 0);
    if (sample.inputAsset) {
      const sha256 = createHash("sha256").update(readFileSync(sample.inputAsset.path)).digest("hex");
      assert.equal(sha256, sample.inputAsset.sha256);
      assert.match(sample.inputAsset.source, /synthetic|public-domain/i);
    }
  }

  assert.equal(SMOKE_TEST_PLAN.length, 4);
  assert.ok(SMOKE_TEST_PLAN.some((entry) => entry.candidateKey === "flux2-klein-9b-official" && !entry.executable));
  assert.ok(SMOKE_TEST_PLAN.filter((entry) => entry.sample.kind === "video").every((entry) => entry.resolution === "480p_video"));
  const qualityBlocked = canRunQualityBenchmark({ candidate: firstRound[0], passedRuns: 1, attemptedRuns: 2, unrecoverableOom: false, nodesComplete: true, validOutput: true, unloadSucceeded: true });
  const qualityAllowed = canRunQualityBenchmark({ candidate: firstRound[0], passedRuns: 2, attemptedRuns: 2, unrecoverableOom: false, nodesComplete: true, validOutput: true, unloadSucceeded: true });
  assert.equal(qualityBlocked, false);
  assert.equal(qualityAllowed, true);
  assert.equal(isProductionPromotionAllowed(), false);
  assert.equal(WORKFLOW_TEMPLATES.video_i2v.key, "video_i2v");
  assert.equal(WORKFLOW_TEMPLATES.video_flf2v.key, "video_flf2v");
  assert.notEqual(WORKFLOW_TEMPLATES.video_i2v.key, WORKFLOW_TEMPLATES.video_flf2v.key);
  const blindId = blindReviewId("wan22-ti2v-5b-official", videos[0], 1);
  assert.ok(!blindId.includes("wan22") && !blindId.includes("flux"));
  assert.equal(MANUAL_IMAGE_SCORES.length, 5);
  assert.equal(MANUAL_VIDEO_SCORES.length, 7);
  assert.ok(OBJECTIVE_BENCHMARK_METRICS.includes("estimated_cost_usd"));
  assert.deepEqual(PRODUCTION_PROFILE_PATHS, ["rtx4090/image", "rtx4090/video", "rtx5090/image", "rtx5090/video"]);
  assert.deepEqual(PRODUCTION_CURRENT_JSON_KEYS, ["production/rtx4090/image/current.json", "production/rtx4090/video/current.json", "production/rtx5090/image/current.json", "production/rtx5090/video/current.json"]);
  assert.ok(R2_SHARED_COMPONENT_PREFIXES.includes("shared/text-encoders"));
  assert.ok(R2_SHARED_COMPONENT_PREFIXES.includes("custom-node-locks"));

  console.log("generation metadata and benchmark plan tests passed");
}

main();
