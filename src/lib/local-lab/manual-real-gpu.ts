/** Server-only gate for the user's local, explicit paid action. Never expose it to the browser. */
export function manualRealGpuRentalEnabled() {
  return process.env.LOCAL_LAB_ENABLED === "true"
    && process.env.NEXT_PUBLIC_APP_MODE === "local_lab"
    && process.env.LOCAL_REAL_GPU_RENTAL_ENABLED === "true";
}
