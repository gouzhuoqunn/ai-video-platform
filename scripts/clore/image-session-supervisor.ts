import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import {
  assertRtx4090GoldenDeploymentProfile,
  rtx4090GoldenDeploymentFingerprint,
  verifyRtx4090GoldenPublishedSources,
} from "../image-executor/rtx4090-golden-deployment-profile";
import { archiveSafePrior, atomic, clean, readReceipt, readWorker, root, terminalizeDeadWorker, workerPath, type WorkerState } from "./image-session-supervision";
const arg=(n:string)=>{const i=process.argv.indexOf(n);return i<0?undefined:process.argv[i+1]};
const alive=(pid:number|null)=>{try{if(!pid)return false;process.kill(pid,0);return true}catch{return false}};
async function start() {
  const id = arg("--session-id") ?? "";
  const ids = (arg("--task-ids") ?? "").split(",").filter(Boolean);
  const fingerprint = arg("--deployment-profile-fingerprint") ?? "";
  const commit = arg("--immutable-commit") ?? "";
  const agentSourceSha256 = arg("--agent-source-sha256") ?? "";
  const agentSha256 = arg("--agent-sha256") ?? "";
  const controllerSha256 = arg("--controller-sha256") ?? "";
  const workflowSha256 = arg("--workflow-sha256") ?? "";
  if (
    !id ||
    ids.length < 1 ||
    ids.length > 8 ||
    new Set(ids).size !== ids.length ||
    !fingerprint ||
    !commit ||
    !agentSourceSha256 ||
    !agentSha256 ||
    !controllerSha256 ||
    !workflowSha256 ||
    !process.argv.includes("--execute")
  ) {
    throw new Error("image_session_supervisor_arguments_invalid");
  }
  const profile = assertRtx4090GoldenDeploymentProfile();
  if (
    fingerprint !== rtx4090GoldenDeploymentFingerprint(profile) ||
    commit !== profile.immutable.commit ||
    agentSourceSha256 !== profile.immutable.agentSourceSha256 ||
    agentSha256 !== profile.immutable.agentSha256 ||
    controllerSha256 !== profile.immutable.controllerSha256 ||
    workflowSha256 !== profile.immutable.workflowSha256
  ) {
    throw new Error("image_session_supervisor_immutable_profile_mismatch");
  }
  const prior = readWorker(id);
  if (prior && alive(prior.pid)) throw new Error("image_session_worker_already_alive");
  if (prior && ["succeeded", "failed", "ambiguous"].includes(prior.state)) {
    renameSync(workerPath(id), path.join(root(id), `worker-state.${Date.now()}.json`));
  }
  const archived = await archiveSafePrior(ids, {
    allowedRunnerAttemptId: id,
    allowedRunnerPid: process.pid,
    immutableSourcePreflight: () => verifyRtx4090GoldenPublishedSources(),
  });
  mkdirSync(root(id), { recursive: true });
  const logPath = path.join(root(id), "worker.log");
  const fd = openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(process.cwd(), "scripts", "clore", "image-session-worker.ts"),
      "--execute",
      "--session-id",
      id,
      "--task-ids",
      ids.join(","),
      "--deployment-profile-fingerprint",
      fingerprint,
      "--immutable-commit",
      commit,
      "--agent-source-sha256",
      agentSourceSha256,
      "--agent-sha256",
      agentSha256,
      "--controller-sha256",
      controllerSha256,
      "--workflow-sha256",
      workflowSha256,
    ],
    { detached: true, windowsHide: true, stdio: ["ignore", fd, fd] },
  );
  child.unref();
  const state: WorkerState = {
    schemaVersion: 1,
    sessionId: id,
    pid: child.pid ?? null,
    state: "starting",
    taskIds: ids,
    deploymentProfileFingerprint: fingerprint,
    immutableCommit: commit,
    agentSourceSha256,
    agentSha256,
    controllerSha256,
    workflowSha256,
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
    sanitizedError: null,
    sessionReceiptPath: path.join(process.cwd(), ".secrets", "clore-image-session-receipt.json"),
    logPath,
  };
  atomic(workerPath(id), state);
  appendFileSync(path.join(root(id), "supervisor.log"), `${new Date().toISOString()} ${id} start\n`);
  console.log(JSON.stringify({ sessionId: id, pid: child.pid, state: "starting", archivedPriorReceipt: Boolean(archived) }));
}
async function status(){const id=arg("--session-id")??"";let w=readWorker(id);if(!w)throw new Error("image_session_worker_state_missing");if(!alive(w.pid)&&!["succeeded","failed","ambiguous"].includes(w.state))w=terminalizeDeadWorker(id)??w;const r=readReceipt();const tail=existsSync(w.logPath)?readFileSync(w.logPath,"utf8").split(/\r?\n/).slice(-30).map(clean):[];console.log(JSON.stringify({sessionId:id,workerPid:w.pid,workerState:w.state,pidAlive:alive(w.pid),heartbeatAgeSeconds:Math.floor((Date.now()-Date.parse(w.lastHeartbeatAt))/1000),currentSessionState:r?.sessionState??null,currentRemoteStage:r?.currentRemoteStage??null,currentStageRunId:r?.currentStageRunId??null,modelStage:r?.modelStage??null,currentTask:r?.currentTaskId??null,tasks:r?.tasks??{},cancellationState:r?.cancellationState??null,lastError:w.sanitizedError??r?.firstError??null,logTail:tail}));}
async function wait(){for(;;){await status();const w=readWorker(arg("--session-id")??"");if(w&&["succeeded","failed","ambiguous"].includes(w.state))return;await new Promise(r=>setTimeout(r,20000))}}
const cmd=process.argv[2];void(cmd==="start"?start():cmd==="status"?Promise.resolve(status()):cmd==="wait"?wait():Promise.reject(new Error("image_session_supervisor_command_invalid"))).catch(e=>{console.error(clean(e));process.exitCode=1});
