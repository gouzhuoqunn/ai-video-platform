import assert from "node:assert/strict";
import { watchdogTerminationReason, type RunPodWatchdogState } from "./runpod-watchdog";

const now = Date.parse("2026-07-16T00:00:00.000Z");
const state: RunPodWatchdogState = { schema_version: 1, armed: true, session_id: "test", pod_id: "pod", parent_pid: 1, started_at: new Date(now).toISOString(), heartbeat_at: new Date(now).toISOString(), max_session_minutes: 150, max_session_usd: 2.5, hourly_usd: 0.7 };
assert.equal(watchdogTerminationReason(state, now, true), null);
assert.equal(watchdogTerminationReason(state, now, false), "parent_process_exited");
assert.equal(watchdogTerminationReason(state, now + 150 * 60_000, true), "session_time_limit");
assert.equal(watchdogTerminationReason({ ...state, max_session_minutes: 150, hourly_usd: 2 }, now + 76 * 60_000, true), "session_budget_limit");
assert.equal(watchdogTerminationReason({ ...state, armed: false }, now + 999 * 60_000, false), null);
console.log("RunPod Watchdog process-exit, time, and budget tests passed.");
