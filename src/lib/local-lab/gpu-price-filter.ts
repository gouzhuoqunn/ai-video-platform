export const LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR = 5;

export function isManualCandidateDisplayPriceAllowed(effectiveUsdPerHour: number) {
  return Number.isFinite(effectiveUsdPerHour)
    && effectiveUsdPerHour >= 0
    && effectiveUsdPerHour <= LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR;
}

export function manualCandidateBasePriceCeiling(renterFeeRate: number) {
  if (!Number.isFinite(renterFeeRate) || renterFeeRate < 0) {
    throw new Error("Invalid renter fee rate.");
  }
  return LOCAL_LAB_GPU_PRICE_FILTER_MAX_USD_PER_HOUR / (1 + renterFeeRate);
}
