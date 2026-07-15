import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { loadRunPodConfig, RunPodRestClient } from "./gpu-providers/runpod";
import { sleep } from "./gpu-providers/common";

export type RunPodWatchdogState = {
  schema_version: 1;
  armed: boolean;
  session_id: string;
  pod_id: string | null;
  parent_pid: number;
  started_at: string;
  heartbeat_at: string;
  max_session_minutes: 150;
  max_session_usd: number;
  hourly_usd: number | null;
};

function statePath() { return path.join(process.cwd(), ".secrets", "runpod-watchdog-state.json"); }

export function readRunPodWatchdogState() {
  return existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), "utf8")) as RunPodWatchdogState : null;
}

export function writeRunPodWatchdogState(state: RunPodWatchdogState) {
  const target = statePath();
  mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  writeFileSync(partial, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(partial, target);
}

export function watchdogTerminationReason(state: RunPodWatchdogState, now = Date.now(), parentAlive = true) {
  if (!state.armed) return null;
  if (!parentAlive) return "parent_process_exited";
  const elapsedMs = Math.max(0, now - Date.parse(state.started_at));
  if (elapsedMs >= state.max_session_minutes * 60_000) return "session_time_limit";
  const estimated = state.hourly_usd === null ? 0 : state.hourly_usd * elapsedMs / 3_600_000;
  if (estimated >= state.max_session_usd) return "session_budget_limit";
  return null;
}

function parentAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function armRunPodWatchdog(sessionId: string, maxSessionUsd: number) {
  const state: RunPodWatchdogState = { schema_version: 1, armed: true, session_id: sessionId, pod_id: null, parent_pid: process.pid, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), max_session_minutes: 150, max_session_usd: maxSessionUsd, hourly_usd: null };
  writeRunPodWatchdogState(state);
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "scripts/runpod-watchdog.ts", "monitor"], { cwd: process.cwd(), detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return {
    recordPod(podId: string, hourlyUsd: number | null) { const current = readRunPodWatchdogState(); if (current?.session_id === sessionId) writeRunPodWatchdogState({ ...current, pod_id: podId, hourly_usd: hourlyUsd, heartbeat_at: new Date().toISOString() }); },
    heartbeat() { const current = readRunPodWatchdogState(); if (current?.session_id === sessionId) writeRunPodWatchdogState({ ...current, heartbeat_at: new Date().toISOString() }); },
    disarm() { const current = readRunPodWatchdogState(); if (current?.session_id === sessionId) rmSync(statePath(), { force: true }); },
  };
}

async function monitor() {
  const config = loadRunPodConfig();
  const client = new RunPodRestClient(config);
  while (true) {
    const state = readRunPodWatchdogState();
    if (!state?.armed) return;
    const reason = watchdogTerminationReason(state, Date.now(), parentAlive(state.parent_pid));
    if (reason) {
      let podId = state.pod_id;
      if (!podId) {
        const pods = await client.listPods();
        podId = pods.find((pod) => pod.name === `ai-video-first-image-${state.session_id}` && pod.desiredStatus !== "TERMINATED")?.id ?? null;
      }
      if (podId) {
        console.log(JSON.stringify({ provider: "runpod", watchdog: "terminate", reason, pod_id_recorded: true }));
        await client.deletePod(podId);
      }
      rmSync(statePath(), { force: true });
      return;
    }
    await sleep(60_000);
  }
}

if (process.argv[2] === "monitor") void monitor().catch(() => { process.exitCode = 1; });
