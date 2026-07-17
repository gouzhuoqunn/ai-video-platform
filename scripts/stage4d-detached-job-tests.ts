import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { buildDetachedLaunchCommand, classifyDetached, type DetachedState } from "./clore/detached-remote-job";

const detachedSource = readFileSync(path.join(process.cwd(), "scripts", "clore", "detached-remote-job.ts"), "utf8");
assert.match(detachedSource, /mkdir -p \/workspace\/tools[\s\S]*scpFile\(target, source, "\/workspace\/tools\/detached-job-worker\.py"/);
const sessionSource = readFileSync(path.join(process.cwd(), "scripts", "stage4c-production-session.ts"), "utf8");
assert.match(sessionSource, /for \(let attempt = 1; attempt <= 2; attempt \+= 1\)[\s\S]*try \{[\s\S]*await installDetachedWorker\(target\);[\s\S]*await launchDetachedJob/);
assert.match(sessionSource, /canary_in_place_repair/);
for (const marker of ["manual-restore.ps1", "manual-restore-remote.sh", "manual-status.txt", "MANUAL_HANDOFF_REQUIRED", "restore_launcher_in_place_repair"]) assert.ok(sessionSource.includes(marker), marker);

const command = buildDetachedLaunchCommand({ jobId: "stage4d-test-job", mode: "restore" });
for (const marker of ["setsid -f", "nohup", "</dev/null", "stdout.log", "stderr.log", "state.json", "--bundle"]) assert.match(command, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(command, /-t\b|password|token|secret/i);

const now = Date.now() / 1000;
const running: DetachedState = { job_id: "stage4d-test-job", pid: 42, phase: "running", current_object: "a", completed_bytes: 10, total_bytes: 100, last_heartbeat_at: now, started_at: now - 10, completed_at: null, exit_code: null, sanitized_error: null };
assert.equal(classifyDetached({ reachable: true, state: running, heartbeat: {}, pid: 42, alive: true, observed_at: now, stdout_tail: "", stderr_tail: "", result: null }), "remote_job_running");
assert.equal(classifyDetached({ reachable: true, state: { ...running, phase: "completed" }, heartbeat: {}, pid: 42, alive: false, observed_at: now, stdout_tail: "", stderr_tail: "", result: {} }), "remote_job_complete");
assert.equal(classifyDetached({ reachable: true, state: { ...running, phase: "failed", sanitized_error: "safe" }, heartbeat: {}, pid: 42, alive: false, observed_at: now, stdout_tail: "", stderr_tail: "", result: {} }), "remote_job_failed");
assert.equal(classifyDetached({ reachable: true, state: { ...running, last_heartbeat_at: now - 301 }, heartbeat: {}, pid: 42, alive: false, observed_at: now, stdout_tail: "", stderr_tail: "", result: null }, 10), "remote_job_stalled");
assert.equal(classifyDetached({ reachable: false, error: "timeout" }), "ssh_temporarily_unreachable");
assert.equal(classifyDetached({ reachable: true, state: null, heartbeat: null, pid: null, alive: false, observed_at: now, stdout_tail: "", stderr_tail: "", result: null }), "remote_job_not_created");

async function main() {
  const root = path.join(os.tmpdir(), `stage4d-detached-${process.pid}`);
  rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
  const worker = path.join(process.cwd(), "scripts", "clore", "detached-job-worker.py");
  const child = spawn("python", [worker, "--job-dir", root, "--job-id", "stage4d-local-canary", "--mode", "canary"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  const started = Date.now(); let firstHeartbeat = 0; let sawRunning = false; let heartbeatAdvanced = false;
  while (Date.now() - started < 110_000) {
    if (existsSync(path.join(root, "state.json"))) {
      const state = JSON.parse(readFileSync(path.join(root, "state.json"), "utf8")) as DetachedState;
      if (state.phase === "running") {
        sawRunning = true;
        if (!firstHeartbeat) firstHeartbeat = state.last_heartbeat_at;
        else if (state.last_heartbeat_at > firstHeartbeat) heartbeatAdvanced = true;
      }
      if (state.phase === "completed") break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const final = JSON.parse(readFileSync(path.join(root, "state.json"), "utf8")) as DetachedState;
  const result = JSON.parse(readFileSync(path.join(root, "result.json"), "utf8")) as { ok: boolean };
  assert.equal(sawRunning, true); assert.equal(heartbeatAdvanced, true); assert.equal(final.phase, "completed"); assert.equal(result.ok, true);
  assert.ok(Number(readFileSync(path.join(root, "worker.pid"), "utf8").trim()) > 0);
  rmSync(root, { recursive: true, force: true });
  console.log("Stage 4D detached launcher, survival, PID/state/heartbeat, timeout reclassification, reconnect, stall, and completion tests passed.");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
