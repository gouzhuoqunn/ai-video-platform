import type { CloreCandidate } from "../../../scripts/clore/types";

export type GpuProfileKey = "rtx4090" | "rtx5090";

export type OffloadPolicy = "aggressive" | "balanced";

export type GpuProfile = {
  key: GpuProfileKey;
  displayName: string;
  exactGpuName: string;
  minimumVramGb: number;
  allowDisplayVramTolerance: boolean;
  hardMinimumRamGb: number;
  preferredRamGb: number;
  hardMinimumDiskGb: number;
  preferredDiskGb: number;
  offloadPolicy: OffloadPolicy;
};

export type GpuProfileEvaluation = {
  profile: GpuProfileKey;
  accepted: boolean;
  preferred: boolean;
  reasons: string[];
};

export const GPU_PROFILES: Record<GpuProfileKey, GpuProfile> = {
  rtx4090: {
    key: "rtx4090",
    displayName: "RTX 4090",
    exactGpuName: "NVIDIA GeForce RTX 4090",
    minimumVramGb: 24,
    allowDisplayVramTolerance: false,
    hardMinimumRamGb: 64,
    preferredRamGb: 96,
    hardMinimumDiskGb: 200,
    preferredDiskGb: 250,
    offloadPolicy: "aggressive",
  },
  rtx5090: {
    key: "rtx5090",
    displayName: "RTX 5090",
    exactGpuName: "NVIDIA GeForce RTX 5090",
    minimumVramGb: 31,
    allowDisplayVramTolerance: true,
    hardMinimumRamGb: 80,
    preferredRamGb: 128,
    hardMinimumDiskGb: 250,
    preferredDiskGb: 300,
    offloadPolicy: "balanced",
  },
};

export function isAcceptedVram(profile: GpuProfile, candidate: Pick<CloreCandidate, "gpuMemoryGb" | "gpuMemoryRawUnit">) {
  if (candidate.gpuMemoryGb === null) return false;
  if (candidate.gpuMemoryGb >= profile.minimumVramGb) return true;
  return Boolean(profile.allowDisplayVramTolerance && candidate.gpuMemoryRawUnit === "display_gb" && candidate.gpuMemoryGb >= 30.5);
}

export function evaluateCandidateForProfile(
  profileKey: GpuProfileKey,
  candidate: Pick<CloreCandidate, "gpuNormalizedName" | "gpuCount" | "gpuMemoryGb" | "gpuMemoryRawUnit" | "ramGb" | "diskGb" | "orderType">,
): GpuProfileEvaluation {
  const profile = GPU_PROFILES[profileKey];
  const reasons: string[] = [];

  if (candidate.gpuNormalizedName !== profile.exactGpuName) reasons.push(`GPU is not exact ${profile.displayName}`);
  if (candidate.gpuCount !== 1) reasons.push("GPU count is not 1");
  if (candidate.orderType !== "on-demand") reasons.push("order is not on-demand");
  if (!isAcceptedVram(profile, candidate)) reasons.push("VRAM below profile minimum");
  if ((candidate.ramGb ?? 0) < profile.hardMinimumRamGb) reasons.push("RAM below profile hard minimum");
  if ((candidate.diskGb ?? 0) < profile.hardMinimumDiskGb) reasons.push("disk below profile hard minimum");

  const accepted = reasons.length === 0;
  const preferred =
    accepted &&
    (candidate.ramGb ?? 0) >= profile.preferredRamGb &&
    (candidate.diskGb ?? 0) >= profile.preferredDiskGb;

  return { profile: profileKey, accepted, preferred, reasons };
}

export function listGpuProfiles() {
  return Object.values(GPU_PROFILES);
}

export function requiredDiskGbForProfile(profileKey: GpuProfileKey, plannedModelSyncGb: number) {
  if (!Number.isFinite(plannedModelSyncGb) || plannedModelSyncGb < 0) {
    throw new Error("planned model sync size must be a non-negative number");
  }
  const profile = GPU_PROFILES[profileKey];
  const withReserve = Math.ceil(plannedModelSyncGb * 1.2 * 100) / 100;
  return Math.max(profile.hardMinimumDiskGb, withReserve);
}
