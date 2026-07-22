import { existsSync } from "node:fs";
import path from "node:path";

/** Server-only gate for the user's local, explicit paid action. Never expose it to the browser. */
export function manualRealGpuRentalEnabled() {
  return process.env.LOCAL_LAB_ENABLED === "true"
    && process.env.NEXT_PUBLIC_APP_MODE === "local_lab"
    && process.env.LOCAL_REAL_GPU_RENTAL_ENABLED === "true";
}

export type ManualRealGpuReadiness = { ready: boolean; code: string | null; message: string | null };

/**
 * Deliberately fail closed. Deployment tooling sets the two verification flags
 * only after the remote migration/RPC probe succeeds; a browser can never set
 * them, and a running dev server cannot silently opt into paid execution.
 */
export function manualRealGpuReadiness(): ManualRealGpuReadiness {
  if (!manualRealGpuRentalEnabled()) return { ready: false, code: "local_mode_disabled", message: "本地真实 GPU 租用尚未启用。" };
  if (process.env.LOCAL_GPU_BATCH_RPC_VERIFIED !== "true") return { ready: false, code: "batch_rpc_unverified", message: "数据库批次领取接口尚未部署或验证。" };
  if (process.env.GPU_WORKER_IMMUTABLE_BATCH_ENABLED !== "true") return { ready: false, code: "worker_transport_disabled", message: "GPU Worker 批次凭据配置缺失。" };
  if (!existsSync(path.join(process.cwd(), ".secrets", "gpu-session-runner", "runner.pid"))) return { ready: false, code: "runner_not_running", message: "本地显卡会话服务未运行。" };
  if (process.env.CLORE_ORDER_EXECUTION_ENABLED !== "true") return { ready: false, code: "clore_mutation_disabled", message: "Clore 下单配置缺失。" };
  return { ready: true, code: null, message: null };
}
