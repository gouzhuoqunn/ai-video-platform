export type SchedulerPolicy = {
  imageOnlyBatchThreshold: number;
  videoI2vBatchThreshold: number;
  combinedChainBatchThreshold: number;
  maximumWaitMinutes: number;
  maximumActiveOrders: 1;
  immediateStartsImmediately: true;
};

export const DEFAULT_PRODUCTION_SCHEDULER_POLICY: SchedulerPolicy = {
  imageOnlyBatchThreshold: 3,
  videoI2vBatchThreshold: 2,
  combinedChainBatchThreshold: 2,
  maximumWaitMinutes: 360,
  maximumActiveOrders: 1,
  immediateStartsImmediately: true,
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
  };
}
