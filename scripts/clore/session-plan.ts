import { calculateSessionCost, DEFAULT_SESSION_COST_INPUT } from "../cost/session-cost";
import { loadCloreConfig } from "./config";

export function buildCloreSessionPlan() {
  const config = loadCloreConfig();
  const costs = calculateSessionCost({
    ...DEFAULT_SESSION_COST_INPUT,
    gpuPriceUsdPerHour: config.maxGpuPricePerHour,
    maxSessionHours: config.assumedMinimumRentalHours,
  });

  return {
    dry_run: true,
    explicit_user_start_required: true,
    creates_order_from_single_queued_job: false,
    duplicate_order_prevention: ".secrets/clore-session-state.json plus project tag ai-video-platform-wan22",
    dynamic_ip_required: false,
    worker_connection_model: "GPU worker polls Supabase with limited gpu_worker credentials.",
    allowed_gpu_env: [
      "SUPABASE_URL",
      "SUPABASE_PUBLISHABLE_KEY",
      "GPU_WORKER_EMAIL",
      "GPU_WORKER_PASSWORD",
      "MODEL_CACHE_READ_ONLY=true",
      "read-only R2 model cache credentials only if R2 restore is used",
    ],
    forbidden_gpu_env: ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "CLORE_API_KEY", "R2 write credentials", ".env.local"],
    states: [
      "idle",
      "planning",
      "order_pending",
      "booting",
      "restoring_model",
      "starting_worker",
      "ready",
      "processing",
      "draining",
      "uploading",
      "cleaning",
      "canceling",
      "stopped",
      "failed",
    ],
    timers: {
      drain_at_minutes: costs.drainAtMinutes,
      cleanup_plan_at_minutes: costs.cleanupAtMinutes,
      idle_shutdown_threshold_minutes: costs.idleShutdownThresholdMinutes,
    },
    cost_guardrails: costs,
  };
}

function main() {
  console.log(JSON.stringify(buildCloreSessionPlan(), null, 2));
}

if (process.argv[1]?.endsWith("session-plan.ts")) {
  main();
}
