export type CloreExecutionConfig = {
  enabled: boolean;
  firstSessionMaxBudgetUsd: number;
  balanceReserveUsd: number;
  maxGpuPricePerHour: number;
  hardSessionLimitMinutes: number;
  orderStartTimeoutMinutes: number;
  workerReadyTimeoutMinutes: number;
  firstGpuSession: boolean;
};

function readNumber(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadCloreExecutionConfig(): CloreExecutionConfig {
  return {
    enabled: process.env.CLORE_ORDER_EXECUTION_ENABLED === "true",
    firstSessionMaxBudgetUsd: readNumber("CLORE_FIRST_SESSION_MAX_BUDGET_USD", 4.5),
    balanceReserveUsd: readNumber("CLORE_BALANCE_RESERVE_USD", 1),
    maxGpuPricePerHour: readNumber("CLORE_MAX_GPU_PRICE_PER_HOUR", 0.7),
    hardSessionLimitMinutes: readNumber("CLORE_HARD_SESSION_LIMIT_MINUTES", 380),
    orderStartTimeoutMinutes: readNumber("CLORE_ORDER_START_TIMEOUT_MINUTES", 15),
    workerReadyTimeoutMinutes: readNumber("CLORE_WORKER_READY_TIMEOUT_MINUTES", 120),
    firstGpuSession: process.env.CLORE_FIRST_GPU_SESSION !== "false",
  };
}
