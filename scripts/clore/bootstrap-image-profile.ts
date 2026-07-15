import { computeCloreProjectedCost, evaluateMarketplace } from "./marketplace";
import type { LoadedCloreConfig } from "./order-execution";
import type { CloreCandidate, RawCloreServer } from "./types";

export const BOOTSTRAP_IMAGE_GPU_PROFILE = "bootstrap_image_gpu";
export const FIRST_IMAGE_SESSION_HOURS = 5;

export type BootstrapImageCandidate = CloreCandidate & {
  runtimeGpuProfile: "rtx4090" | "rtx5090" | typeof BOOTSTRAP_IMAGE_GPU_PROFILE;
  gpuPriority: number;
  projectedFirstImageCostUsd: number | null;
};

function gpuProfile(candidate: CloreCandidate): BootstrapImageCandidate["runtimeGpuProfile"] | null {
  const name = candidate.gpuNormalizedName.toLowerCase();
  if (name.includes("rtx 4090")) return "rtx4090";
  if (name.includes("rtx 5090")) return "rtx5090";
  if (/(rtx 3090|rtx a5000|rtx a6000)/.test(name)) return BOOTSTRAP_IMAGE_GPU_PROFILE;
  if (/nvidia/.test(name) && (candidate.gpuMemoryGb ?? 0) >= 16) return BOOTSTRAP_IMAGE_GPU_PROFILE;
  return null;
}

function priority(candidate: CloreCandidate) {
  const name = candidate.gpuNormalizedName.toLowerCase();
  if (name.includes("rtx 4090")) return 0;
  if (name.includes("rtx 5090")) return 1;
  if (/rtx 3090/.test(name)) return 2;
  if (/rtx a5000|rtx a6000/.test(name)) return 3;
  return 4;
}

export function findBootstrapImageCandidates(rawServers: RawCloreServer[], config: LoadedCloreConfig): BootstrapImageCandidate[] {
  const permissive = {
    ...config,
    targetGpu: "NVIDIA GeForce RTX 4090" as const,
    minGpuVramGb: 16,
    minRamGb: 32,
    minDiskGb: 120,
    minCpuCores: 1,
    minReliability: 0,
    minRating: 0,
    minRatingCount: 0,
    minDownloadMbps: 0,
    minUploadMbps: 0,
    maxGpuPricePerHour: 0.7 / 1.05,
    allowedCountries: [],
  };
  const { candidates } = evaluateMarketplace(rawServers, permissive);
  return candidates
    .map((candidate) => {
      const runtimeGpuProfile = gpuProfile(candidate);
      const projected = computeCloreProjectedCost(candidate.priceUsdPerHour, FIRST_IMAGE_SESSION_HOURS);
      return { ...candidate, runtimeGpuProfile, gpuPriority: priority(candidate), projectedFirstImageCostUsd: projected.projectedTotalUsd };
    })
    .filter((candidate): candidate is BootstrapImageCandidate => {
      return Boolean(candidate.runtimeGpuProfile) &&
        candidate.gpuCount === 1 &&
        candidate.rentable &&
        candidate.orderType === "on-demand" &&
        candidate.supportsDocker &&
        candidate.supportsSsh &&
        candidate.driverCompatible !== false &&
        (candidate.gpuMemoryGb ?? 0) >= 16 &&
        (candidate.ramGb ?? 0) >= 32 &&
        (candidate.diskGb ?? 0) >= 120 &&
        candidate.effectivePriceUsdPerHour !== null && candidate.effectivePriceUsdPerHour <= 0.7 &&
        candidate.projectedFirstImageCostUsd !== null && candidate.projectedFirstImageCostUsd <= 4.5 &&
        !config.excludedServerIds.includes(candidate.serverId);
    })
    .sort((left, right) => {
      const reliability = (right.reliability ?? -1) - (left.reliability ?? -1);
      if (reliability) return reliability;
      const rating = (right.rating ?? -1) - (left.rating ?? -1);
      if (rating) return rating;
      if (left.gpuPriority !== right.gpuPriority) return left.gpuPriority - right.gpuPriority;
      const price = (left.effectivePriceUsdPerHour ?? Infinity) - (right.effectivePriceUsdPerHour ?? Infinity);
      if (price) return price;
      const ram = (right.ramGb ?? 0) - (left.ramGb ?? 0);
      if (ram) return ram;
      return (right.diskGb ?? 0) - (left.diskGb ?? 0);
    });
}

export function summarizeBootstrapImageCandidate(candidate: BootstrapImageCandidate) {
  return {
    server_id: candidate.serverId,
    gpu: candidate.gpu,
    gpu_memory_gb: candidate.gpuMemoryGb,
    ram_gb: candidate.ramGb,
    disk_gb: candidate.diskGb,
    effective_usd_per_hour: candidate.effectivePriceUsdPerHour,
    projected_first_image_cost_usd: candidate.projectedFirstImageCostUsd,
    runtime_gpu_profile: candidate.runtimeGpuProfile,
    reliability: candidate.reliability,
    rating: candidate.rating,
    rating_count: candidate.ratingCount,
    country: candidate.country,
  };
}
