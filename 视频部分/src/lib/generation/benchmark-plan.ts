import { BENCHMARK_SAMPLES, type BenchmarkSample } from "../../../benchmarks/v1/suite";
import { getMetadataAudit, isFullRevision } from "./model-metadata";
import { getFirstRoundBaselines, type ModelCandidate } from "./model-registry";

export type BenchmarkStage = "smoke" | "quality";
export type BenchmarkMetricName =
  | "cold_sync_seconds"
  | "runtime_start_seconds"
  | "model_load_seconds"
  | "generation_seconds"
  | "warm_generation_seconds"
  | "peak_vram_mb"
  | "peak_ram_mb"
  | "disk_bytes"
  | "output_bytes"
  | "oom_count"
  | "crash_count"
  | "retry_count"
  | "unload_seconds"
  | "estimated_cost_usd";

export type ManualImageScore = "prompt_adherence" | "identity_consistency" | "anatomy" | "composition" | "visual_quality";
export type ManualVideoScore = "motion_quality" | "identity_consistency" | "temporal_stability" | "prompt_adherence" | "start_frame_adherence" | "end_frame_adherence" | "camera_motion_quality";

export const OBJECTIVE_BENCHMARK_METRICS: BenchmarkMetricName[] = [
  "cold_sync_seconds", "runtime_start_seconds", "model_load_seconds", "generation_seconds", "warm_generation_seconds", "peak_vram_mb", "peak_ram_mb", "disk_bytes", "output_bytes", "oom_count", "crash_count", "retry_count", "unload_seconds", "estimated_cost_usd",
];
export const MANUAL_IMAGE_SCORES: ManualImageScore[] = ["prompt_adherence", "identity_consistency", "anatomy", "composition", "visual_quality"];
export const MANUAL_VIDEO_SCORES: ManualVideoScore[] = ["motion_quality", "identity_consistency", "temporal_stability", "prompt_adherence", "start_frame_adherence", "end_frame_adherence", "camera_motion_quality"];

export type SmokePlanEntry = {
  candidateKey: string;
  stage: "smoke";
  sample: BenchmarkSample;
  requiredRuns: 2;
  resolution: "low_image" | "480p_video";
  executable: boolean;
  blockedReason: string | null;
};

export const SMOKE_TEST_PLAN: SmokePlanEntry[] = getFirstRoundBaselines().map((candidate) => {
  const audit = getMetadataAudit(candidate.key);
  const video = candidate.task_type === "video";
  const sample = BENCHMARK_SAMPLES.find((item) => item.id === (video ? "video-i2v-single-frame" : "image-cinematic-closeup"))!;
  const executable = Boolean(audit && isFullRevision(audit.revision) && audit.access === "public");
  return {
    candidateKey: candidate.key,
    stage: "smoke",
    sample,
    requiredRuns: 2,
    resolution: video ? "480p_video" : "low_image",
    executable,
    blockedReason: executable ? null : "metadata access or full revision SHA is not ready",
  };
});

export type SmokeResult = {
  candidate: ModelCandidate;
  passedRuns: number;
  attemptedRuns: number;
  unrecoverableOom: boolean;
  nodesComplete: boolean;
  validOutput: boolean;
  unloadSucceeded: boolean;
};

export function canRunQualityBenchmark(result: SmokeResult) {
  return result.attemptedRuns >= 2 && result.passedRuns === result.attemptedRuns && !result.unrecoverableOom && result.nodesComplete && result.validOutput && result.unloadSucceeded;
}

export function blindReviewId(candidateKey: string, sample: BenchmarkSample, run: number) {
  const candidateIndex = getFirstRoundBaselines().findIndex((candidate) => candidate.key === candidateKey);
  if (candidateIndex < 0 || run < 1) throw new Error("unknown candidate or run");
  return `${sample.blindSampleId}-R${run.toString().padStart(2, "0")}-C${(candidateIndex + 1).toString().padStart(2, "0")}`;
}

export function isProductionPromotionAllowed() {
  return false;
}
