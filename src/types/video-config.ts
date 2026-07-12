import type { AvailableVideoModelKey, VideoJobStatus, VideoModelKey } from "@/types/video-jobs";

export type VideoModelConfig = {
  key: VideoModelKey;
  name: string;
  type: string;
  durationSeconds: number;
  resolution: "480p" | "720p";
  creditCost: number;
  estimatedTime: string;
  supportsFirstFrame: boolean;
  available: boolean;
};

export const videoModels: VideoModelConfig[] = [
  {
    key: "lightweight-video",
    name: "轻量视频模型",
    type: "文生视频",
    durationSeconds: 5,
    resolution: "480p",
    creditCost: 5,
    estimatedTime: "约1分钟",
    supportsFirstFrame: false,
    available: true,
  },
  {
    key: "standard-video",
    name: "标准视频模型",
    type: "文生视频 / 图生视频",
    durationSeconds: 5,
    resolution: "720p",
    creditCost: 10,
    estimatedTime: "约3分钟",
    supportsFirstFrame: true,
    available: true,
  },
  {
    key: "high-quality-video",
    name: "高质量视频模型",
    type: "文生视频 / 图生视频",
    durationSeconds: 5,
    resolution: "720p",
    creditCost: 20,
    estimatedTime: "约5分钟",
    supportsFirstFrame: true,
    available: false,
  },
];

export const availableVideoModelKeys: AvailableVideoModelKey[] = ["lightweight-video", "standard-video"];

export const videoModelLabels: Record<VideoModelKey, string> = {
  "lightweight-video": "轻量视频模型",
  "standard-video": "Wan2.2 TI2V-5B",
  "high-quality-video": "高质量视频模型",
};

export const videoJobStatusLabels: Record<VideoJobStatus, string> = {
  queued: "排队中",
  processing: "生成中",
  succeeded: "已完成",
  failed: "生成失败",
  canceled: "已取消",
};

export const videoJobStatusDescriptions: Record<VideoJobStatus, string> = {
  queued: "任务正在等待Worker领取。",
  processing: "Worker正在模拟处理任务。",
  succeeded: "任务已完成，可以播放或下载。",
  failed: "任务失败，已按规则退还积分。",
  canceled: "任务已取消，已按规则退还积分。",
};
