import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { GpuTarget } from "../gpu-providers/types";
import { scpFile, sleep, sshCommand } from "../gpu-providers/common";

export type DetachedState = {
  job_id: string; pid: number | null; phase: "launching" | "running" | "completed" | "failed" | "canceled";
  current_object: string | null; completed_bytes: number; total_bytes: number;
  last_heartbeat_at: number; started_at: number; completed_at: number | null;
  exit_code: number | null; sanitized_error: string | null;
};
export type DetachedClassification = "launch_transport_timeout" | "remote_job_not_created" | "remote_job_running" |
  "remote_job_complete" | "remote_job_failed" | "remote_job_stalled" | "ssh_temporarily_unreachable";

function safeId(value: string) { if (!/^[a-z0-9-]{6,100}$/.test(value)) throw new Error("detached_job_id_invalid"); return value; }
export function remoteJobDir(jobId: string) { return `/workspace/jobs/${safeId(jobId)}`; }
function sshArgs(target: GpuTarget, command: string) {
  return ["-i", target.sshKeyPath, "-o", "StrictHostKeyChecking=accept-new", "-o", "PasswordAuthentication=no",
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-T", "-p", String(target.port),
    `${target.username}@${target.host}`, command];
}
export async function installDetachedWorker(target: GpuTarget) {
  const source = path.join(process.cwd(), "scripts", "clore", "detached-job-worker.py");
  const directory = sshCommand(target, "mkdir -p /workspace/tools", 30_000);
  if (directory.status !== 0) throw new Error(`detached_worker_directory_failed:${String(directory.stderr ?? directory.error?.message).slice(-1000)}`);
  const result = scpFile(target, source, "/workspace/tools/detached-job-worker.py", 120_000);
  if (result.status !== 0) throw new Error(`detached_worker_upload_failed:${String(result.stderr ?? result.error?.message).slice(-1000)}`);
  const prepared = sshCommand(target, "chmod 700 /workspace/tools/detached-job-worker.py", 30_000);
  if (prepared.status !== 0) throw new Error("detached_worker_prepare_failed");
}
export function buildDetachedLaunchCommand(input: { jobId: string; mode: "canary" | "restore"; bundlePath?: string }) {
  const job = safeId(input.jobId); const dir = remoteJobDir(job);
  const initial = Buffer.from(JSON.stringify({ job_id: job, pid: null, phase: "launching", current_object: null,
    completed_bytes: 0, total_bytes: input.mode === "canary" ? 90 : 0, last_heartbeat_at: Date.now() / 1000,
    started_at: Date.now() / 1000, completed_at: null, exit_code: null, sanitized_error: null })).toString("base64");
  const bundle = input.mode === "restore" ? ` --bundle ${input.bundlePath ?? `${dir}/bundle.json`}` : "";
  return `set -e; mkdir -p ${dir}; echo ${initial} | base64 -d >${dir}/state.json.part; mv ${dir}/state.json.part ${dir}/state.json; ` +
    `nohup setsid -f python3 /workspace/tools/detached-job-worker.py --job-dir ${dir} --job-id ${job} --mode ${input.mode}${bundle} ` +
    `</dev/null >${dir}/stdout.log 2>${dir}/stderr.log; printf '{"launched":true,"job_id":"${job}"}\\n'`;
}
export async function launchDetachedJob(target: GpuTarget, input: { jobId: string; mode: "canary" | "restore"; bundlePath?: string }, timeoutMs = 15_000) {
  const command = buildDetachedLaunchCommand(input); const started = Date.now();
  return await new Promise<{ returnedMs: number; transportTimedOut: boolean; stdout: string }>((resolve, reject) => {
    const child = spawn("ssh", sshArgs(target, command), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", settled = false;
    child.stdout.on("data", (chunk) => stdout += String(chunk)); child.stderr.on("data", (chunk) => stderr += String(chunk));
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); resolve({ returnedMs: Date.now() - started, transportTimedOut: true, stdout }); } }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => { if (settled) return; settled = true; clearTimeout(timer); if (code !== 0) reject(new Error(`detached_launch_ssh_${code}:${stderr.slice(-1000)}`)); else resolve({ returnedMs: Date.now() - started, transportTimedOut: false, stdout }); });
  });
}
const INSPECT = String.raw`
import json,os,pathlib,time
root=pathlib.Path("__DIR__")
def load(name):
 p=root/name
 try:return json.loads(p.read_text())
 except:return None
state=load("state.json"); heartbeat=load("heartbeat.json")
pid=None
try:pid=int((root/"worker.pid").read_text().strip())
except:pass
alive=False
if pid:
 try:os.kill(pid,0);alive=True
 except:pass
def tail(name):
 try:return "\n".join((root/name).read_text(errors="replace").splitlines()[-20:])[-2000:]
 except:return ""
print(json.dumps({"state":state,"heartbeat":heartbeat,"pid":pid,"alive":alive,"observed_at":time.time(),"stdout_tail":tail("stdout.log"),"stderr_tail":tail("stderr.log"),"result":load("result.json")}))
`;
export function inspectRemoteJob(target: GpuTarget, jobId: string) {
  const script = Buffer.from(INSPECT.replace("__DIR__", remoteJobDir(jobId))).toString("base64");
  const result = sshCommand(target, `python3 -c "import base64;exec(base64.b64decode('${script}'))"`, 30_000);
  if (result.status !== 0) return { reachable: false as const, error: String(result.stderr ?? result.error?.message).slice(-1000) };
  try { return { reachable: true as const, ...JSON.parse(String(result.stdout)) as { state: DetachedState | null; heartbeat: unknown; pid: number | null; alive: boolean; observed_at: number; stdout_tail: string; stderr_tail: string; result: unknown } }; }
  catch { return { reachable: false as const, error: "detached_status_json_invalid" }; }
}
export function classifyDetached(observation: ReturnType<typeof inspectRemoteJob>, previousBytes?: number): DetachedClassification {
  if (!observation.reachable) return "ssh_temporarily_unreachable";
  if (!observation.state) return "remote_job_not_created";
  if (observation.state.phase === "completed") return "remote_job_complete";
  if (["failed", "canceled"].includes(observation.state.phase)) return "remote_job_failed";
  const age = observation.observed_at - Number(observation.state.last_heartbeat_at || 0);
  if (age > 300 && observation.state.completed_bytes === previousBytes && !observation.alive) return "remote_job_stalled";
  return "remote_job_running";
}
export async function waitForDetachedJob(target: GpuTarget, jobId: string, timeoutMs: number, onPoll?: (value: ReturnType<typeof inspectRemoteJob>, classification: DetachedClassification) => void) {
  const deadline = Date.now() + timeoutMs; let previousBytes: number | undefined; let disconnects = 0;
  while (Date.now() < deadline) {
    const value = inspectRemoteJob(target, jobId); const classification = classifyDetached(value, previousBytes); onPoll?.(value, classification);
    if (classification === "remote_job_complete") return value;
    if (["remote_job_failed", "remote_job_stalled", "remote_job_not_created"].includes(classification)) throw new Error(`${classification}:${value.reachable ? value.state?.sanitized_error ?? value.stderr_tail : value.error}`);
    if (value.reachable && value.state) { previousBytes = value.state.completed_bytes; disconnects = 0; } else disconnects += 1;
    await sleep(Math.min(30_000, 20_000 * Math.max(1, disconnects)));
  }
  throw new Error("detached_job_wait_timeout");
}
export function stopDetachedJob(target: GpuTarget, jobId: string) {
  const dir = remoteJobDir(jobId); return sshCommand(target, `test -s ${dir}/worker.pid && kill -TERM $(cat ${dir}/worker.pid) 2>/dev/null || true`, 30_000);
}
