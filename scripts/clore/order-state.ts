import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_TAG } from "./config";
import type { GpuProfile } from "../gpu-providers/types";

export const ACTIVE_ORDER_PATH = path.join(process.cwd(), ".secrets", "clore-active-order.json");
export const ORDER_CREATE_LOCK_PATH = path.join(process.cwd(), ".secrets", "clore-order-create.lock");
export const LEGACY_ORDER_CREATE_LOCK_PATH = path.join(process.cwd(), ".secrets", "clore-create.lock");
const LOCK_TTL_MS = 20 * 60 * 1000;

export type ActiveCloreOrder = {
  order_id: string;
  server_id: string;
  project_tag: typeof PROJECT_TAG;
  created_at: string;
  status: "order_pending" | "booting" | "ready" | "canceling" | "stopped" | "failed";
  usd_per_hour: number;
  max_price_usd_per_hour: number;
  order_type: "on-demand";
  open_ports: ["ssh/tcp"] | ["controller/http:8080"] | ["ssh/tcp", "controller/http:8080"];
  gpu_type?: string;
  gpu_profile?: GpuProfile;
  bootstrap_image?: string;
  deployment_profile_fingerprint?: string;
  create_attempt_id?: string;
};

export function readActiveOrder() {
  if (!existsSync(ACTIVE_ORDER_PATH)) {
    return null;
  }
  return JSON.parse(readFileSync(ACTIVE_ORDER_PATH, "utf8")) as ActiveCloreOrder;
}

export function writeActiveOrder(order: ActiveCloreOrder) {
  mkdirSync(path.dirname(ACTIVE_ORDER_PATH), { recursive: true });
  writeFileSync(ACTIVE_ORDER_PATH, `${JSON.stringify(order, null, 2)}\n`, "utf8");
}

export function clearActiveOrder(orderId: string) {
  const active = readActiveOrder();
  if (!active || active.order_id !== orderId || active.project_tag !== PROJECT_TAG) {
    throw new Error("Refusing to clear an order that does not belong to this project.");
  }
  rmSync(ACTIVE_ORDER_PATH, { force: true });
}

export function clearLocalActiveOrderState() {
  rmSync(ACTIVE_ORDER_PATH, { force: true });
}

export function clearOrderCreateLocks() {
  rmSync(ORDER_CREATE_LOCK_PATH, { force: true });
  rmSync(LEGACY_ORDER_CREATE_LOCK_PATH, { force: true });
}

function lockIsStale() {
  if (!existsSync(ORDER_CREATE_LOCK_PATH)) {
    return false;
  }

  try {
    const lock = JSON.parse(readFileSync(ORDER_CREATE_LOCK_PATH, "utf8")) as { acquired_at?: string };
    return !lock.acquired_at || Date.now() - new Date(lock.acquired_at).getTime() > LOCK_TTL_MS;
  } catch {
    return true;
  }
}

export function acquireOrderCreateLock(requestId: string) {
  mkdirSync(path.dirname(ORDER_CREATE_LOCK_PATH), { recursive: true });
  if (lockIsStale()) {
    rmSync(ORDER_CREATE_LOCK_PATH, { force: true });
  }

  let fd: number | null = null;
  try {
    fd = openSync(ORDER_CREATE_LOCK_PATH, "wx");
    writeFileSync(
      fd,
      `${JSON.stringify({ request_id: requestId, project_tag: PROJECT_TAG, acquired_at: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    return {
      requestId,
      release() {
        if (fd !== null) {
          closeSync(fd);
          fd = null;
        }
        const active = existsSync(ORDER_CREATE_LOCK_PATH)
          ? (JSON.parse(readFileSync(ORDER_CREATE_LOCK_PATH, "utf8")) as { request_id?: string })
          : null;
        if (active?.request_id === requestId) {
          rmSync(ORDER_CREATE_LOCK_PATH, { force: true });
        }
      },
    };
  } catch {
    if (fd !== null) {
      closeSync(fd);
    }
    throw new Error("Another Clore order create request is already in progress.");
  }
}
