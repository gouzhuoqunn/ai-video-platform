import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FIRST_IMAGE_STAGES = ["candidate_selected", "order_created", "ssh_ready", "hardware_verified", "runtime_ready", "models_restored", "prompt_submitted", "image_generated", "result_synced", "session_stopped", "order_cancelled"] as const;
export type FirstImageStage = (typeof FIRST_IMAGE_STAGES)[number];
export type FirstImageState = { schema_version: 1; provider: "clore" | "manual_ssh"; completed: FirstImageStage[]; updated_at: string; session_id: string; details: Record<string, unknown> };
function statePath() {
  return path.join(process.cwd(), ".secrets", "first-image-state.json");
}

export function readFirstImageState(): FirstImageState | null {
  const filePath = statePath();
  return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) as FirstImageState : null;
}

export function writeFirstImageState(state: FirstImageState) {
  const filePath = statePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const partial = `${filePath}.part`;
  writeFileSync(partial, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(partial, filePath);
}

export function beginFirstImageState(provider: FirstImageState["provider"], sessionId: string) {
  const current = readFirstImageState();
  if (current && current.provider === provider && current.session_id === sessionId) return current;
  const state: FirstImageState = { schema_version: 1, provider, session_id: sessionId, completed: [], updated_at: new Date().toISOString(), details: {} };
  writeFirstImageState(state);
  return state;
}

export function completeFirstImageStage(state: FirstImageState, stage: FirstImageStage, details: Record<string, unknown> = {}) {
  const index = FIRST_IMAGE_STAGES.indexOf(stage);
  if (index > 0 && !state.completed.includes(FIRST_IMAGE_STAGES[index - 1])) throw new Error(`Cannot complete ${stage} before ${FIRST_IMAGE_STAGES[index - 1]}.`);
  const next: FirstImageState = { ...state, completed: state.completed.includes(stage) ? state.completed : [...state.completed, stage], updated_at: new Date().toISOString(), details: { ...state.details, [stage]: details } };
  writeFirstImageState(next);
  return next;
}

export function nextFirstImageStage(state: FirstImageState) {
  return FIRST_IMAGE_STAGES.find((stage) => !state.completed.includes(stage)) ?? null;
}
