import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STAGE3O_CHECKPOINTS = ["preflight_validated", "watchdog_armed", "order_created", "ssh_ready", "hardware_inspected", "flux_restored", "image_generated", "image_synced", "flux_unloaded", "wan_restored", "video_generated", "outputs_synced", "runtime_stopped", "order_cancelled", "cleanup_verified"] as const;
export type Stage3OCheckpoint = (typeof STAGE3O_CHECKPOINTS)[number];
export type Stage3OLiveState = {
  schemaVersion: 1;
  batchId: "stage3o";
  provider: "clore";
  completed: Stage3OCheckpoint[];
  attemptCount: number;
  failedDeploymentSpendUsd: number;
  orderId: string | null;
  serverId: string | null;
  startedAt: string;
  updatedAt: string;
  details: Partial<Record<Stage3OCheckpoint, Record<string, unknown>>>;
  lastError: string | null;
};

export const STAGE3O_LIVE_STATE_PATH = path.join(process.cwd(), ".secrets", "stage3o-live-session.json");

export function initialStage3OState(): Stage3OLiveState {
  const now = new Date().toISOString();
  return { schemaVersion: 1, batchId: "stage3o", provider: "clore", completed: [], attemptCount: 0, failedDeploymentSpendUsd: 0, orderId: null, serverId: null, startedAt: now, updatedAt: now, details: {}, lastError: null };
}

export function readStage3OState(filePath = STAGE3O_LIVE_STATE_PATH) {
  if (!existsSync(filePath)) return initialStage3OState();
  const state = JSON.parse(readFileSync(filePath, "utf8")) as Stage3OLiveState;
  if (state.schemaVersion !== 1 || state.batchId !== "stage3o" || !Array.isArray(state.completed)) throw new Error("Stage 3O checkpoint state is invalid.");
  return state;
}

export function writeStage3OState(state: Stage3OLiveState, filePath = STAGE3O_LIVE_STATE_PATH) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  const partial = `${filePath}.${process.pid}.part`;
  writeFileSync(partial, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(partial, filePath);
  return next;
}

export function completeStage3OCheckpoint(state: Stage3OLiveState, checkpoint: Stage3OCheckpoint, details: Record<string, unknown> = {}, filePath = STAGE3O_LIVE_STATE_PATH) {
  const index = STAGE3O_CHECKPOINTS.indexOf(checkpoint);
  if (index > 0 && !state.completed.includes(STAGE3O_CHECKPOINTS[index - 1])) throw new Error(`Cannot complete ${checkpoint} before ${STAGE3O_CHECKPOINTS[index - 1]}.`);
  return writeStage3OState({ ...state, completed: state.completed.includes(checkpoint) ? state.completed : [...state.completed, checkpoint], details: { ...state.details, [checkpoint]: details }, lastError: null }, filePath);
}

export function nextStage3OCheckpoint(state: Stage3OLiveState) {
  return STAGE3O_CHECKPOINTS.find((checkpoint) => !state.completed.includes(checkpoint)) ?? null;
}
