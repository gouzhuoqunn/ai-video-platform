import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CLORE_SESSION_STATE_PATH = path.join(process.cwd(), ".secrets", "clore-session-state.json");

export type CloreSessionStatus =
  | "idle"
  | "planning"
  | "order_pending"
  | "booting"
  | "restoring_model"
  | "starting_worker"
  | "ready"
  | "processing"
  | "draining"
  | "uploading"
  | "cleaning"
  | "canceling"
  | "stopped"
  | "failed";

export type CloreSessionState = {
  status: CloreSessionStatus;
  dryRun: true;
  projectTag: "ai-video-platform-wan22";
  orderId: string | null;
  serverId: string | null;
  startedAt: string | null;
  lastUpdatedAt: string;
  estimatedUsdPerHour: number | null;
  drainAtMinutes: number;
  cleanupAtMinutes: number;
  processingJobs: number;
  notes: string[];
};

export function createInitialSessionState(status: CloreSessionStatus = "idle"): CloreSessionState {
  const now = new Date().toISOString();
  return {
    status,
    dryRun: true,
    projectTag: "ai-video-platform-wan22",
    orderId: null,
    serverId: null,
    startedAt: null,
    lastUpdatedAt: now,
    estimatedUsdPerHour: null,
    drainAtMinutes: 330,
    cleanupAtMinutes: 380,
    processingJobs: 0,
    notes: ["State contains no secrets, tokens, passwords, SSH keys, prompts, or signed URLs."],
  };
}

export function readSessionState(): CloreSessionState {
  if (!existsSync(CLORE_SESSION_STATE_PATH)) {
    return createInitialSessionState();
  }
  return JSON.parse(readFileSync(CLORE_SESSION_STATE_PATH, "utf8")) as CloreSessionState;
}

export function writeSessionState(state: CloreSessionState) {
  mkdirSync(path.dirname(CLORE_SESSION_STATE_PATH), { recursive: true });
  writeFileSync(CLORE_SESSION_STATE_PATH, `${JSON.stringify({ ...state, lastUpdatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

export function assertSafeToStart(state: CloreSessionState) {
  if (!["idle", "stopped", "failed"].includes(state.status)) {
    throw new Error(`Refusing to start another Clore session while current state is ${state.status}.`);
  }
  if (state.orderId) {
    throw new Error("Refusing to start because a previous order id is still recorded.");
  }
}

export function assertSafeToStop(state: CloreSessionState) {
  if (state.processingJobs > 0 || state.status === "processing") {
    throw new Error("Refusing to cancel while processing jobs are recorded; drain first.");
  }
}
