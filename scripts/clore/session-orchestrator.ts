import { assertNoSecretOutput } from "./client";
import { buildCloreSessionPlan } from "./session-plan";
import {
  assertSafeToStart,
  assertSafeToStop,
  createInitialSessionState,
  readSessionState,
  writeSessionState,
  type CloreSessionState,
} from "./session-state";

function hasExecuteFlag() {
  return process.argv.includes("--execute");
}

function command() {
  return process.argv[2] ?? "plan";
}

function printSafe(payload: unknown) {
  const output = JSON.stringify(payload, null, 2);
  assertNoSecretOutput(output);
  console.log(output);
}

export function planSession() {
  return buildCloreSessionPlan();
}

export function dryStartSession() {
  if (hasExecuteFlag()) {
    throw new Error("Real Clore order execution is intentionally not implemented in this session orchestrator.");
  }
  const current = readSessionState();
  assertSafeToStart(current);
  const next: CloreSessionState = {
    ...createInitialSessionState("planning"),
    notes: [
      "DRY RUN - no Clore create_order call was made.",
      "Explicit user start is required before any future real order.",
      "Worker will poll Supabase, so dynamic Clore IP is acceptable.",
    ],
  };
  writeSessionState(next);
  return next;
}

export function stopSessionDryRun() {
  if (hasExecuteFlag()) {
    throw new Error("Real Clore cancel_order execution is intentionally not implemented in this session orchestrator.");
  }
  const current = readSessionState();
  assertSafeToStop(current);
  const next: CloreSessionState = {
    ...current,
    status: current.orderId ? "canceling" : "stopped",
    notes: [
      "DRY RUN - no Clore cancel_order call was made.",
      "Future real stop must verify no jobs are processing before canceling.",
      "Upload local results and run worker cleanup before canceling.",
    ],
  };
  writeSessionState(next);
  return next;
}

function main() {
  const action = command();
  if (action === "plan") {
    printSafe(planSession());
    return;
  }
  if (action === "dry") {
    printSafe(dryStartSession());
    return;
  }
  if (action === "status") {
    printSafe(readSessionState());
    return;
  }
  if (action === "stop:dry") {
    printSafe(stopSessionDryRun());
    return;
  }
  throw new Error(`Unknown clore session command: ${action}`);
}

if (process.argv[1]?.endsWith("session-orchestrator.ts")) {
  main();
}
