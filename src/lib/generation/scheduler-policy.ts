export type SchedulerPolicy = {
  imageOnlyBatchThreshold: number;
  videoI2vBatchThreshold: number;
  combinedChainBatchThreshold: number;
  maximumWaitMinutes: number;
  maximumActiveOrders: 1;
  immediateStartsImmediately: true;
  longVideo: {
    maximumConsecutiveSegments: number;
    maximumSegmentsPerSession: number;
    sessionWallMinutes: number;
    drainingAtMinutes: number;
    sessionSpendLimitUsd: number;
  };
};

export const DEFAULT_PRODUCTION_SCHEDULER_POLICY: SchedulerPolicy = {
  imageOnlyBatchThreshold: 3,
  videoI2vBatchThreshold: 2,
  combinedChainBatchThreshold: 2,
  maximumWaitMinutes: 360,
  maximumActiveOrders: 1,
  immediateStartsImmediately: true,
  longVideo: {
    maximumConsecutiveSegments: 4,
    maximumSegmentsPerSession: 12,
    sessionWallMinutes: 150,
    drainingAtMinutes: 135,
    sessionSpendLimitUsd: 0.75,
  },
};

function boundedInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

export function loadSchedulerPolicy(environment: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env): SchedulerPolicy {
  return {
    imageOnlyBatchThreshold: boundedInteger(environment.GENERATION_IMAGE_BATCH_THRESHOLD, DEFAULT_PRODUCTION_SCHEDULER_POLICY.imageOnlyBatchThreshold, 50),
    videoI2vBatchThreshold: boundedInteger(environment.GENERATION_VIDEO_BATCH_THRESHOLD, DEFAULT_PRODUCTION_SCHEDULER_POLICY.videoI2vBatchThreshold, 50),
    combinedChainBatchThreshold: boundedInteger(environment.GENERATION_COMBINED_BATCH_THRESHOLD, DEFAULT_PRODUCTION_SCHEDULER_POLICY.combinedChainBatchThreshold, 50),
    maximumWaitMinutes: boundedInteger(environment.GENERATION_MAX_WAIT_MINUTES, DEFAULT_PRODUCTION_SCHEDULER_POLICY.maximumWaitMinutes, 1440),
    maximumActiveOrders: 1,
    immediateStartsImmediately: true,
    longVideo: {
      maximumConsecutiveSegments: boundedInteger(environment.GENERATION_LONG_VIDEO_MAX_CONSECUTIVE, DEFAULT_PRODUCTION_SCHEDULER_POLICY.longVideo.maximumConsecutiveSegments, 20),
      maximumSegmentsPerSession: boundedInteger(environment.GENERATION_LONG_VIDEO_MAX_PER_SESSION, DEFAULT_PRODUCTION_SCHEDULER_POLICY.longVideo.maximumSegmentsPerSession, 60),
      sessionWallMinutes: boundedInteger(environment.GENERATION_LONG_VIDEO_SESSION_MINUTES, DEFAULT_PRODUCTION_SCHEDULER_POLICY.longVideo.sessionWallMinutes, 360),
      drainingAtMinutes: boundedInteger(environment.GENERATION_LONG_VIDEO_DRAINING_MINUTES, DEFAULT_PRODUCTION_SCHEDULER_POLICY.longVideo.drainingAtMinutes, 330),
      sessionSpendLimitUsd: 0.75,
    },
  };
}

export type FairnessTask = {
  priority: "normal" | "immediate";
  modelProfile: string;
  longVideoProjectId?: string | null;
  createdAt: string;
};

export function rankTasksForLoadedSession<T extends FairnessTask>(
  tasks: T[],
  session: {
    loadedModels?: string[];
    activeLongVideoProjectId?: string | null;
    consecutiveLongVideoSegments?: number;
  } | null,
  policy = DEFAULT_PRODUCTION_SCHEDULER_POLICY,
) {
  const wanLoaded = session?.loadedModels?.includes("wan22-remix-14b-i2v-fp8") === true;
  const fairnessBoundary = (session?.consecutiveLongVideoSegments ?? 0) >= policy.longVideo.maximumConsecutiveSegments;
  const rank = (task: T) => {
    const activeLong = Boolean(task.longVideoProjectId && task.longVideoProjectId === session?.activeLongVideoProjectId);
    const urgentShortWan = task.modelProfile === "wan22-remix-14b-i2v-fp8" && !task.longVideoProjectId && task.priority === "immediate";
    if (wanLoaded && activeLong && !fairnessBoundary) return 0;
    if (wanLoaded && urgentShortWan) return 1;
    if (task.longVideoProjectId) return 2;
    return 3;
  };
  return [...tasks].sort((left, right) =>
    rank(left) - rank(right)
    || (left.priority === right.priority ? 0 : left.priority === "immediate" ? -1 : 1)
    || Date.parse(left.createdAt) - Date.parse(right.createdAt));
}
