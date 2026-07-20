import type { RequiredGpuClass } from "./gpu-execution-state";

export const videoSoundModes = ["silent", "audible"] as const;
export type VideoSoundMode = (typeof videoSoundModes)[number];
export const videoQualityTiers = ["low", "medium", "medium_high", "high"] as const;
export type VideoQualityTier = (typeof videoQualityTiers)[number];
export type VideoModelKey = "video_wan_silent" | "video_ltx_native_audio";
export type AudioOrigin = "none" | "native_model" | "local_voice";

export type VideoProfile = {
  id: string;
  label: string;
  soundMode: VideoSoundMode;
  qualityTier: VideoQualityTier;
  modelKey: VideoModelKey;
  gpuClass: RequiredGpuClass;
  audioOrigin: AudioOrigin;
  width: number;
  height: number;
  frames: number;
  fps: number;
};

const silent: Array<Omit<VideoProfile, "soundMode" | "modelKey" | "audioOrigin" | "label">> = [
  { id: "low_video_4090", qualityTier: "low", gpuClass: "rtx4090", width: 832, height: 480, frames: 33, fps: 16 },
  { id: "medium_video_4090", qualityTier: "medium", gpuClass: "rtx4090", width: 1280, height: 720, frames: 81, fps: 16 },
  { id: "medium_video_5090", qualityTier: "medium_high", gpuClass: "rtx5090", width: 1280, height: 720, frames: 81, fps: 16 },
  { id: "high_video_5090", qualityTier: "high", gpuClass: "rtx5090", width: 1280, height: 720, frames: 81, fps: 16 },
];

const labelByTier: Record<VideoQualityTier, string> = { low: "低", medium: "中", medium_high: "中高", high: "高" };

export const VIDEO_PROFILES: VideoProfile[] = [
  ...silent.map((profile) => ({ ...profile, label: `无声·${labelByTier[profile.qualityTier]}`, soundMode: "silent" as const, modelKey: "video_wan_silent" as const, audioOrigin: "none" as const })),
  ...silent.map((profile) => ({
    ...profile,
    id: `audible_${profile.id}`,
    label: `有声·${labelByTier[profile.qualityTier]}`,
    soundMode: "audible" as const,
    modelKey: "video_ltx_native_audio" as const,
    audioOrigin: "native_model" as const,
  })),
];

export function getVideoProfile(id: string | null | undefined) {
  return VIDEO_PROFILES.find((profile) => profile.id === id) ?? VIDEO_PROFILES[0];
}

export function videoQueueId(soundMode: VideoSoundMode, gpuClass: RequiredGpuClass) {
  return `${soundMode}:${gpuClass}` as const;
}

export type NativeAudioExecutionContract = {
  modelKey: "video_ltx_native_audio";
  immutableRevision: string;
  soundMode: "audible";
  prompt: string;
  firstFrameRef: string | null;
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  seed: number;
  audioRequired: true;
  expectedOutput: { relativeMp4: string; requireAudioStream: true; seekable: true; durationToleranceMs: number };
  result: { ffprobeEvidence: Record<string, string | number | boolean | null>; sha256: string | null; failureReason: string | null; cancellationState: "none" | "requested" | "recovered" };
};
