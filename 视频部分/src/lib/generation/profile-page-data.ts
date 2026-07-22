import { GPU_PROFILES, type GpuProfileKey } from "./gpu-profiles";
import { getCandidatesForSlot, type ModelSlotKey } from "./model-registry";
import { FIRST_ROUND_CAPACITY_PLAN } from "./r2-cache-plan";

export function getGenerationProfilePageData(profile: GpuProfileKey) {
  const gpu = GPU_PROFILES[profile];
  const imageSlot = `${profile}_image` as ModelSlotKey;
  const videoSlot = `${profile}_video` as ModelSlotKey;
  return {
    gpu,
    imageCandidates: getCandidatesForSlot(imageSlot),
    videoCandidates: getCandidatesForSlot(videoSlot),
    firstRoundCandidates: [...getCandidatesForSlot(imageSlot), ...getCandidatesForSlot(videoSlot)].filter((candidate) => candidate.benchmark_round === "first"),
    plannedSyncGb: profile === "rtx4090" ? FIRST_ROUND_CAPACITY_PLAN.session4090Gb : FIRST_ROUND_CAPACITY_PLAN.session5090Gb,
    runtime: {
      name: "ComfyUI unified runtime",
      mode: "mock",
      bindHost: "127.0.0.1",
      publicPorts: "none",
    },
  };
}
