import { existsSync, readFileSync } from "node:fs";
import { buildCloreSessionPlan } from "./session-plan";
import { assertSafeToStart, assertSafeToStop, createInitialSessionState, CLORE_SESSION_STATE_PATH } from "./session-state";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertThrows(fn: () => void, message: string) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

function main() {
  const plan = buildCloreSessionPlan();
  assert(plan.dry_run === true, "session orchestrator must be dry-run by default.");
  assert(plan.explicit_user_start_required === true, "a single queued job must not auto-create an order.");
  assert(plan.creates_order_from_single_queued_job === false, "queued jobs must not trigger automatic Clore orders.");
  assert(plan.timers.drain_at_minutes === 330, "drain timer must be 5h30m.");
  assert(plan.timers.cleanup_plan_at_minutes === 380, "cleanup plan must be around 6h20m.");
  assert(plan.forbidden_gpu_env.includes("CLORE_API_KEY"), "Clore API key must stay off the GPU.");
  assert(plan.forbidden_gpu_env.includes("SUPABASE_SECRET_KEY"), "Supabase Secret key must stay off the GPU.");

  assertSafeToStart(createInitialSessionState("idle"));
  assertThrows(() => assertSafeToStart({ ...createInitialSessionState("processing"), orderId: "order-1" }), "duplicate active sessions must be blocked.");
  assertThrows(() => assertSafeToStop({ ...createInitialSessionState("processing"), processingJobs: 1 }), "cancel must be blocked while jobs are processing.");

  const gitignore = readFileSync(".gitignore", "utf8");
  assert(gitignore.includes(".secrets/clore-session-state.json"), "session state file must be git ignored.");
  assert(!existsSync(CLORE_SESSION_STATE_PATH) || !readFileSync(CLORE_SESSION_STATE_PATH, "utf8").match(/key|token|password|signedUrl/i), "session state must not contain secret-like fields.");
  console.log("Clore session tests passed.");
}

void main();
