import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIRST_IMAGE_STAGES, completeFirstImageStage, nextFirstImageStage, type FirstImageState } from "./first-image-state";

const root = process.cwd();
const temp = mkdtempSync(path.join(os.tmpdir(), "first-image-state-"));
try {
  process.chdir(temp);
  const state: FirstImageState = { schema_version: 1, provider: "manual_ssh", session_id: "test-session", completed: [], updated_at: "2026-07-15T00:00:00.000Z", details: {} };
  assert.equal(nextFirstImageStage(state), FIRST_IMAGE_STAGES[0]);
  const candidate = completeFirstImageStage(state, "candidate_selected");
  assert.equal(nextFirstImageStage(candidate), "order_created");
  assert.throws(() => completeFirstImageStage(state, "runtime_ready"), /before/);
  assert.deepEqual(FIRST_IMAGE_STAGES, ["candidate_selected", "order_created", "ssh_ready", "hardware_verified", "runtime_ready", "models_restored", "prompt_submitted", "image_generated", "result_synced", "session_stopped", "order_cancelled"]);
  console.log("First-image recovery state machine tests passed.");
} finally {
  process.chdir(root);
  rmSync(temp, { recursive: true, force: true });
}
