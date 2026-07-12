export type SessionCostInput = {
  gpuPriceUsdPerHour: number;
  maxSessionHours: number;
  coldStartMinutes: number;
  warmStartMinutes: number;
  hardSessionLimitMinutes: number;
  monthlySessions: number;
  modelStorageGb: number;
  r2FreeGb: number;
  r2PricePerGbMonth: number;
  cloreBalanceUsd: number;
  reserveUsd: number;
  volumeMinutesSavedPerSession: number;
  volumeExtraMonthlyCost?: number;
};

export type SessionCostResult = {
  coldSessionCostUsd: number;
  warmSessionCostUsd: number;
  coldStartCostUsd: number;
  warmStartCostUsd: number;
  r2MonthlyCostUsd: number;
  monthlyCostsUsd: Record<"one" | "two" | "four", number>;
  usableBalanceUsd: number;
  fullPlannedSessionsFromBalance: number;
  fullPlannedSessionsAfterReserve: number;
  volumeBreakEvenUsdPerMonth: number;
  currentSingleSessionCostUsd: number;
  optimizedSingleSessionCostUsd: number;
  savingsPerSessionMinutes: number;
  monthlyTotalUsd: Record<string, number>;
  theoreticalSessionsFromBalance: number;
  safeSessionsFromBalance: number;
  idleShutdownMinutes: number;
  shouldKeepVolume: boolean;
  idleShutdownThresholdMinutes: number;
  drainAtMinutes: number;
  cleanupAtMinutes: number;
};

export const DEFAULT_SESSION_COST_INPUT: SessionCostInput = {
  gpuPriceUsdPerHour: readNumber("GPU_PRICE_USD_PER_HOUR", 0.7),
  maxSessionHours: readNumber("GPU_SESSION_HOURS", 6),
  coldStartMinutes: readNumber("GPU_COLD_START_MINUTES", 60),
  warmStartMinutes: readNumber("GPU_WARM_START_MINUTES", 15),
  hardSessionLimitMinutes: readNumber("GPU_HARD_SESSION_LIMIT_MINUTES", 380),
  monthlySessions: readNumber("GPU_MONTHLY_SESSIONS", 2),
  modelStorageGb: readNumber("WAN_MODEL_STORAGE_GB", 34.2),
  r2FreeGb: readNumber("R2_FREE_GB", 10),
  r2PricePerGbMonth: readNumber("R2_PRICE_PER_GB_MONTH", 0.015),
  cloreBalanceUsd: readNumber("CLORE_BALANCE_USD", 11),
  reserveUsd: readNumber("CLORE_RESERVE_USD", 1),
  volumeMinutesSavedPerSession: readNumber("CLORE_VOLUME_MINUTES_SAVED_PER_SESSION", 10),
};

function readNumber(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function money(value: number) {
  return Number(value.toFixed(2));
}

export function calculateSessionCost(input: SessionCostInput): SessionCostResult {
  const coldSessionCostUsd = input.gpuPriceUsdPerHour * input.maxSessionHours;
  const warmSessionCostUsd = input.gpuPriceUsdPerHour * Math.max(0, input.maxSessionHours - (input.coldStartMinutes - input.warmStartMinutes) / 60);
  const currentSingleSessionCostUsd = input.gpuPriceUsdPerHour * (input.maxSessionHours + input.coldStartMinutes / 60);
  const optimizedSingleSessionCostUsd = input.gpuPriceUsdPerHour * (input.maxSessionHours + input.warmStartMinutes / 60);
  const billableR2Gb = Math.max(0, input.modelStorageGb - input.r2FreeGb);
  const r2MonthlyCostUsd = billableR2Gb * input.r2PricePerGbMonth;
  const usableBalanceUsd = Math.max(0, input.cloreBalanceUsd - input.reserveUsd);
  const volumeBreakEvenUsdPerMonth = calculateVolumeBreakEven(input);
  const savingsPerSessionMinutes = Math.max(0, input.coldStartMinutes - input.warmStartMinutes);
  const displayedOptimizedSingleSessionCostUsd = money(optimizedSingleSessionCostUsd);
  const displayedR2MonthlyCostUsd = money(r2MonthlyCostUsd);

  return {
    coldSessionCostUsd: money(coldSessionCostUsd),
    warmSessionCostUsd: money(warmSessionCostUsd),
    coldStartCostUsd: money((input.coldStartMinutes / 60) * input.gpuPriceUsdPerHour),
    warmStartCostUsd: money((input.warmStartMinutes / 60) * input.gpuPriceUsdPerHour),
    r2MonthlyCostUsd: money(r2MonthlyCostUsd),
    monthlyCostsUsd: {
      one: money(coldSessionCostUsd + r2MonthlyCostUsd),
      two: money(coldSessionCostUsd * 2 + r2MonthlyCostUsd),
      four: money(coldSessionCostUsd * 4 + r2MonthlyCostUsd),
    },
    usableBalanceUsd: money(usableBalanceUsd),
    fullPlannedSessionsFromBalance: Math.floor(input.cloreBalanceUsd / coldSessionCostUsd),
    fullPlannedSessionsAfterReserve: Math.floor(usableBalanceUsd / coldSessionCostUsd),
    volumeBreakEvenUsdPerMonth: money(volumeBreakEvenUsdPerMonth),
    currentSingleSessionCostUsd: money(currentSingleSessionCostUsd),
    optimizedSingleSessionCostUsd: money(optimizedSingleSessionCostUsd),
    savingsPerSessionMinutes,
    monthlyTotalUsd: {
      "1": money(displayedOptimizedSingleSessionCostUsd + displayedR2MonthlyCostUsd),
      "2": money(displayedOptimizedSingleSessionCostUsd * 2 + displayedR2MonthlyCostUsd),
      "4": money(displayedOptimizedSingleSessionCostUsd * 4 + displayedR2MonthlyCostUsd),
    },
    theoreticalSessionsFromBalance: Math.floor(input.cloreBalanceUsd / optimizedSingleSessionCostUsd),
    safeSessionsFromBalance: Math.floor(usableBalanceUsd / optimizedSingleSessionCostUsd),
    idleShutdownMinutes: 15,
    shouldKeepVolume: (input.volumeExtraMonthlyCost ?? Number.POSITIVE_INFINITY) <= volumeBreakEvenUsdPerMonth,
    idleShutdownThresholdMinutes: 15,
    drainAtMinutes: 330,
    cleanupAtMinutes: input.hardSessionLimitMinutes,
  };
}

export function calculateVolumeBreakEven(input: SessionCostInput) {
  return money(input.monthlySessions * (input.volumeMinutesSavedPerSession / 60) * input.gpuPriceUsdPerHour);
}

export function formatSessionCostPlan(input = DEFAULT_SESSION_COST_INPUT) {
  const result = calculateSessionCost(input);
  return {
    assumptions: {
      gpu_price_usd_per_hour: input.gpuPriceUsdPerHour,
      planned_session_hours: input.maxSessionHours,
      cold_start_minutes: input.coldStartMinutes,
      target_warm_start_minutes: input.warmStartMinutes,
      hard_session_limit_minutes: input.hardSessionLimitMinutes,
      monthly_sessions: input.monthlySessions,
      model_storage_gb: input.modelStorageGb,
      r2_free_gb: input.r2FreeGb,
      r2_price_usd_per_gb_month: input.r2PricePerGbMonth,
      clore_balance_usd: input.cloreBalanceUsd,
      reserve_usd: input.reserveUsd,
      volume_minutes_saved_per_session: input.volumeMinutesSavedPerSession,
    },
    costs: result,
    conclusions: [
      "Keep the GPU running only when more jobs are expected within 15 minutes.",
      "Batch work inside one planned session and start draining at 5h30m.",
      "With the default 11 USD balance and 1 USD reserve, two full 6h sessions are possible at 0.70 USD/h.",
      "A persistent volume is only worth paying for when its monthly extra cost is below the break-even value.",
    ],
  };
}

function main() {
  console.log(JSON.stringify(formatSessionCostPlan(), null, 2));
}

if (process.argv[1]?.endsWith("session-cost.ts")) {
  main();
}
