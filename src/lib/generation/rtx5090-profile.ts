import type { GpuProfileKey } from "./gpu-profiles";

export type OutputCapability = {
  key: "medium_image" | "high_image_final" | "medium_long_video" | "high_long_video_final";
  generation: { width: number; height: number };
  final: { width: number; height: number };
  strategy: "native_expected" | "upscale_or_refinement_expected";
};

export const RTX5090_BLACKWELL_PROFILE = {
  id: "rtx5090-blackwell-nonpaid",
  gpu: "rtx5090" as GpuProfileKey,
  displayName: "RTX 5090 / Blackwell（未付费验证）",
  verified: false,
  runtime: { cuda: "12.8", torch: "2.7.1+cu128", triton: "3.3.x" },
  preservedProfile: "rtx4090",
  capabilities: [
    { key: "medium_image", generation: { width: 1536, height: 1024 }, final: { width: 1536, height: 1024 }, strategy: "native_expected" },
    { key: "high_image_final", generation: { width: 1536, height: 1536 }, final: { width: 2048, height: 2048 }, strategy: "upscale_or_refinement_expected" },
    { key: "medium_long_video", generation: { width: 1280, height: 720 }, final: { width: 1280, height: 720 }, strategy: "native_expected" },
    { key: "high_long_video_final", generation: { width: 1280, height: 720 }, final: { width: 1920, height: 1080 }, strategy: "upscale_or_refinement_expected" },
  ] satisfies OutputCapability[],
  readiness: { hardwareDetected: false, runtimeCompatible: false, native2048Verified: false, native1080Verified: false, paidSessionCompleted: false },
} as const;

export function resolveGpuProfile(gpuName: string) {
  return /5090/i.test(gpuName) ? RTX5090_BLACKWELL_PROFILE : { id: "rtx4090-verified", gpu: "rtx4090" as const, displayName: "RTX 4090（已验证路径）", verified: true };
}

