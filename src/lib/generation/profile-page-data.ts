import { GPU_PROFILES, type GpuProfileKey } from "./gpu-profiles";
import { getCandidatesForSlot, type ModelSlotKey } from "./model-registry";

export function getGenerationProfilePageData(profile: GpuProfileKey) {
  const gpu = GPU_PROFILES[profile];
  const imageSlot = `${profile}_image` as ModelSlotKey;
  const videoSlot = `${profile}_video` as ModelSlotKey;
  return {
    gpu,
    imageCandidates: getCandidatesForSlot(imageSlot),
    videoCandidates: getCandidatesForSlot(videoSlot),
    runtime: {
      name: "ComfyUI unified runtime",
      mode: "mock",
      bindHost: "127.0.0.1",
      publicPorts: "none",
    },
  };
}
