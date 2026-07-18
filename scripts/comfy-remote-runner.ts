import crypto, { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scpFile, scpFromRemote, sshCommand } from "./gpu-providers/common";
import type { GpuTarget } from "./gpu-providers/types";

export type RemoteRunnerResult = {
  ok: true;
  mode: "probe" | "workflow";
  prompt_id?: string;
  elapsed_ms?: number;
  system_stats?: unknown;
  required_nodes?: string[];
  required_nodes_verified?: boolean;
  websocket_remote_local: { attempted: boolean; connected: boolean; status_line?: string; error?: string };
  websocket_optional: true;
  history_verified?: boolean;
  queue_json_verified?: boolean;
  staged_path?: string;
  output_size_bytes?: number;
  output_sha256?: string;
  output?: Record<string, string>;
  [key: string]: unknown;
};

const REMOTE_RUNNER = "/workspace/runtime-tools/comfy_remote_runner.py";
const STARTED_SENTINEL = "__REMOTE_JOB_STARTED__";
const RESUMED_SENTINEL = "__REMOTE_JOB_RESUMED__";
const RUNNING_SENTINEL = "__REMOTE_JOB_RUNNING__";
const COMPLETE_SENTINEL = "__REMOTE_JOB_COMPLETE__";
const LOST_SENTINEL = "__REMOTE_JOB_LOST__";

type CommandResult = ReturnType<typeof sshCommand>;
export type DetachedRemoteWorkflowCommands = ReturnType<typeof buildDetachedRemoteWorkflowCommands>;
export type DetachedRemoteWorkflowOperations = {
  execute(command: string, timeoutMs: number): CommandResult;
  now?: () => number;
  wait?: (ms: number) => void;
};

function requireSuccess(result: ReturnType<typeof sshCommand>, classification: string) {
  if (result.status !== 0) throw new Error(`${classification}:${String(result.error?.message || result.stderr || result.stdout || `exit_${result.status}`).trim().slice(-2000)}`);
  return String(result.stdout ?? "");
}

export function parseRunnerJson(output: string, classification: string) {
  const line = output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  try {
    const parsed = JSON.parse(line) as RemoteRunnerResult | { ok: false; error?: string; detail?: unknown };
    if (!parsed.ok) throw new Error(`${classification}:${parsed.error ?? "remote_runner_failed"}:${JSON.stringify(parsed.detail).slice(0, 1500)}`);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${classification}:`)) throw error;
    throw new Error(`${classification}:invalid_runner_json:${line.slice(-1500)}`);
  }
}

export function buildDetachedRemoteWorkflowCommands(input: {
  nonce: string;
  remoteWorkflow: string;
  clientId: string;
  kind: "image" | "video";
  timeoutSeconds: number;
}) {
  if (!/^[a-f0-9-]{36}$/i.test(input.nonce)) throw new Error("remote_runner_nonce_invalid");
  if (!/^\/workspace\/runtime-tools\/workflow-[a-f0-9-]{36}\.json$/i.test(input.remoteWorkflow)) throw new Error("remote_runner_workflow_path_invalid");
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(input.clientId)) throw new Error("remote_runner_client_id_invalid");
  if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1) throw new Error("remote_runner_timeout_invalid");
  const jobDir = `/workspace/runtime-tools/workflow-jobs/${input.nonce}`;
  const resultPath = `${jobDir}/result.json`;
  const resultPartPath = `${resultPath}.part`;
  const stderrPath = `${jobDir}/stderr.log`;
  const exitCodePath = `${jobDir}/exit-code`;
  const exitCodePartPath = `${exitCodePath}.part`;
  const pidPath = `${jobDir}/pid`;
  const pidPartPath = `${pidPath}.part`;
  const heartbeatPath = `${jobDir}/heartbeat`;
  const terminalPath = `${jobDir}/terminal`;
  const terminalPartPath = `${terminalPath}.part`;
  const runner = `python3 ${REMOTE_RUNNER} --workflow ${input.remoteWorkflow} --client-id ${input.clientId} --kind ${input.kind} --timeout-seconds ${input.timeoutSeconds} --poll-seconds 2`;
  const worker = `printf "%s\\n" "started" > ${heartbeatPath}; ${runner} > ${resultPartPath} 2> ${stderrPath}; code=$?; if [ -s ${resultPartPath} ]; then mv -f ${resultPartPath} ${resultPath}; fi; printf "%s\\n" "$code" > ${exitCodePartPath}; mv -f ${exitCodePartPath} ${exitCodePath}; printf "%s\\n" "complete" > ${terminalPartPath}; mv -f ${terminalPartPath} ${terminalPath}`;
  const clearStale = `rm -f ${resultPath} ${resultPartPath} ${stderrPath} ${exitCodePath} ${exitCodePartPath} ${pidPath} ${pidPartPath} ${heartbeatPath} ${terminalPath} ${terminalPartPath}`;
  const start = `${clearStale}; setsid sh -c '${worker}' </dev/null >/dev/null 2>&1 & pid=$!; printf "%s\\n" "$pid" > ${pidPartPath}; mv -f ${pidPartPath} ${pidPath}; printf "${STARTED_SENTINEL}:${input.nonce}:%s\\n" "$pid"`;
  return {
    nonce: input.nonce,
    jobDir,
    resultPath,
    launch: `mkdir -p ${jobDir}; if [ -f ${terminalPath} ] && [ -f ${exitCodePath} ]; then pid=$(cat ${pidPath} 2>/dev/null || printf "0"); printf "${RESUMED_SENTINEL}:${input.nonce}:%s\\n" "$pid"; elif [ -f ${pidPath} ] && pid=$(cat ${pidPath}) && kill -0 "$pid" 2>/dev/null; then printf "${RESUMED_SENTINEL}:${input.nonce}:%s\\n" "$pid"; else ${start}; fi`,
    poll: `if [ -f ${terminalPath} ] && [ -f ${exitCodePath} ]; then code=$(cat ${exitCodePath}); printf "${COMPLETE_SENTINEL}:${input.nonce}:%s\\n" "$code"; exit "$code"; elif [ -f ${pidPath} ] && pid=$(cat ${pidPath}) && kill -0 "$pid" 2>/dev/null; then date +%s > ${heartbeatPath}; printf "${RUNNING_SENTINEL}:${input.nonce}:%s\\n" "$pid"; else printf "${LOST_SENTINEL}:${input.nonce}\\n"; exit 125; fi`,
    fetchResult: `test -s ${resultPath} && cat ${resultPath}`,
    fetchStderr: `if [ -f ${stderrPath} ]; then tail -c 4000 ${stderrPath}; fi`,
    stop: `if [ -f ${pidPath} ]; then pid=$(cat ${pidPath}); kill -TERM -- -"$pid" 2>/dev/null || true; sleep 2; kill -KILL -- -"$pid" 2>/dev/null || true; fi`,
    cleanup: `rm -f ${input.remoteWorkflow}; rm -rf ${jobDir}`,
  };
}

function waitWithoutEventLoop(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseLaunchSentinel(output: string, nonce: string) {
  const matches = [...output.matchAll(new RegExp(`(?:${STARTED_SENTINEL}|${RESUMED_SENTINEL}):${nonce}:(\\d+)`, "g"))];
  if (matches.length !== 1) throw new Error(`remote_workflow_launch_sentinel_invalid:count_${matches.length}`);
  return {
    pid: Number(matches[0][1]),
    resumed: matches[0][0].startsWith(RESUMED_SENTINEL),
  };
}

function parsePollSentinel(output: string, nonce: string) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  const terminal = lines.filter((line) => line.startsWith(`${COMPLETE_SENTINEL}:${nonce}:`));
  if (terminal.length > 1) throw new Error("remote_workflow_completion_sentinel_duplicate");
  if (terminal.length === 1) {
    const code = Number(terminal[0].slice(`${COMPLETE_SENTINEL}:${nonce}:`.length));
    if (!Number.isInteger(code) || code < 0 || code > 255) throw new Error("remote_workflow_exit_code_invalid");
    return { state: "complete" as const, exitCode: code };
  }
  if (lines.some((line) => line.startsWith(`${RUNNING_SENTINEL}:${nonce}:`))) return { state: "running" as const };
  if (lines.some((line) => line === `${LOST_SENTINEL}:${nonce}`)) return { state: "lost" as const };
  if (!lines.length) return { state: "empty" as const };
  return { state: "invalid" as const };
}

export function executeDetachedRemoteWorkflowContract(input: {
  commands: DetachedRemoteWorkflowCommands;
  kind: "image" | "video";
  timeoutSeconds: number;
  operations: DetachedRemoteWorkflowOperations;
}) {
  const now = input.operations.now ?? Date.now;
  const wait = input.operations.wait ?? waitWithoutEventLoop;
  const launch = input.operations.execute(input.commands.launch, 30_000);
  requireSuccess(launch, "remote_workflow_launch_failed");
  const launched = parseLaunchSentinel(String(launch.stdout ?? ""), input.commands.nonce);
  const deadline = now() + (input.timeoutSeconds + 60) * 1000;
  let terminalSentinelCount = 0;
  while (now() < deadline) {
    const polled = input.operations.execute(input.commands.poll, 30_000);
    const state = parsePollSentinel(String(polled.stdout ?? ""), input.commands.nonce);
    if (state.state === "complete") {
      terminalSentinelCount += 1;
      if (terminalSentinelCount !== 1) throw new Error("remote_workflow_completion_sentinel_duplicate");
      if (state.exitCode !== 0) {
        const stderr = input.operations.execute(input.commands.fetchStderr, 30_000);
        throw new Error(`${input.kind}_remote_runner_failed:exit_${state.exitCode}:${String(stderr.stdout ?? "").trim().slice(-1500)}`);
      }
      let lastFetchStatus = 0;
      for (let fetchAttempt = 1; fetchAttempt <= 3; fetchAttempt += 1) {
        const fetched = input.operations.execute(input.commands.fetchResult, 30_000);
        lastFetchStatus = fetched.status ?? 1;
        const output = String(fetched.stdout ?? "");
        if (fetched.status === 0 && output.trim()) {
          return {
            result: parseRunnerJson(output, `${input.kind}_remote_runner_failed`),
            pid: launched.pid,
            resumed: launched.resumed,
            terminalSentinelCount,
          };
        }
        if (fetchAttempt < 3) wait(1_000);
      }
      if (lastFetchStatus !== 0) throw new Error(`${input.kind}_remote_runner_result_fetch_failed:exit_${lastFetchStatus}`);
      throw new Error(`${input.kind}_remote_runner_result_empty_after_completion`);
    }
    if (state.state === "lost") throw new Error(`${input.kind}_remote_runner_failed:detached_process_lost`);
    if (state.state === "empty") throw new Error(`${input.kind}_remote_runner_failed:empty_status_response`);
    if (state.state === "invalid") throw new Error(`${input.kind}_remote_runner_failed:invalid_status_response`);
    if (polled.status !== 0) throw new Error(`${input.kind}_remote_runner_failed:status_exit_${polled.status}`);
    wait(5_000);
  }
  throw new Error(`${input.kind}_remote_runner_failed:detached_result_timeout`);
}

export function installRemoteComfyRunner(target: GpuTarget) {
  const localRunner = path.join(process.cwd(), "scripts", "comfy-remote-runner.py");
  requireSuccess(sshCommand(target, "mkdir -p /workspace/runtime-tools/results /workspace/runtime-tools/workflow-jobs", 30_000), "remote_runner_directory_failed");
  requireSuccess(scpFile(target, localRunner, REMOTE_RUNNER, 2 * 60_000), "remote_runner_upload_failed");
  requireSuccess(sshCommand(target, `sed -i 's/\\r$//' ${REMOTE_RUNNER}; chmod 700 ${REMOTE_RUNNER}`, 30_000), "remote_runner_prepare_failed");
  return REMOTE_RUNNER;
}

export function runRemoteComfyProbe(target: GpuTarget) {
  const result = sshCommand(target, `python3 ${REMOTE_RUNNER} --probe`, 90_000);
  const output = String(result.stdout ?? "");
  if (result.status !== 0) return parseRunnerJson(output, "remote_runner_probe_failed");
  return parseRunnerJson(output, "remote_runner_probe_failed");
}

export function runRemoteComfyWorkflow(input: {
  target: GpuTarget;
  workflow: Record<string, unknown>;
  clientId: string;
  kind: "image" | "video";
  timeoutSeconds: number;
  executionId?: string;
}) {
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(input.clientId)) throw new Error("remote_runner_client_id_invalid");
  const nonce = input.executionId ?? crypto.randomUUID();
  if (!/^[a-f0-9-]{36}$/i.test(nonce)) throw new Error("remote_runner_execution_id_invalid");
  const localWorkflow = path.join(os.tmpdir(), `stage3v-${nonce}.json`);
  const remoteWorkflow = `/workspace/runtime-tools/workflow-${nonce}.json`;
  const commands = buildDetachedRemoteWorkflowCommands({ nonce, remoteWorkflow, clientId: input.clientId, kind: input.kind, timeoutSeconds: input.timeoutSeconds });
  writeFileSync(localWorkflow, `${JSON.stringify(input.workflow)}\n`, { encoding: "utf8", mode: 0o600 });
  let launched = false;
  let completedSuccessfully = false;
  let preserveForRecovery = false;
  try {
    requireSuccess(scpFile(input.target, localWorkflow, remoteWorkflow, 2 * 60_000), "remote_workflow_upload_failed");
    launched = true;
    const collected = executeDetachedRemoteWorkflowContract({
      commands,
      kind: input.kind,
      timeoutSeconds: input.timeoutSeconds,
      operations: { execute: (command, timeoutMs) => sshCommand(input.target, command, timeoutMs) },
    });
    completedSuccessfully = true;
    return collected.result;
  } catch (error) {
    if (/result_(?:fetch_failed|empty_after_completion)|invalid_runner_json/.test(error instanceof Error ? error.message : String(error))) preserveForRecovery = true;
    throw error;
  } finally {
    rmSync(localWorkflow, { force: true });
    if (launched && completedSuccessfully) sshCommand(input.target, commands.cleanup, 30_000);
    else if (launched && !preserveForRecovery) {
      sshCommand(input.target, commands.stop, 30_000);
      sshCommand(input.target, commands.cleanup, 30_000);
    } else if (!launched) sshCommand(input.target, `rm -f ${remoteWorkflow}`, 30_000);
  }
}

export function downloadRemoteRunnerOutput(target: GpuTarget, result: RemoteRunnerResult, extension: string) {
  const remotePath = result.staged_path;
  if (typeof remotePath !== "string" || !/^\/workspace\/runtime-tools\/results\/[a-f0-9-]+\.[a-z0-9]+$/i.test(remotePath)) {
    throw new Error("remote_runner_staged_path_invalid");
  }
  const localPath = path.join(os.tmpdir(), `stage3v-${crypto.randomUUID()}${extension}`);
  mkdirSync(path.dirname(localPath), { recursive: true });
  try {
    requireSuccess(scpFromRemote(target, remotePath, localPath, 30 * 60_000), "remote_output_download_failed");
    return localPath;
  } finally {
    sshCommand(target, `rm -f ${remotePath}`, 30_000);
  }
}

function validatedRemotePath(result: RemoteRunnerResult) {
  const remotePath = result.staged_path;
  if (typeof remotePath !== "string" || !/^\/workspace\/runtime-tools\/results\/[a-f0-9-]+\.[a-z0-9]+$/i.test(remotePath)) throw new Error("remote_runner_staged_path_invalid");
  return remotePath;
}

export function downloadRemoteRunnerOutputPersistent(target: GpuTarget, result: RemoteRunnerResult, jobDir: string) {
  const remotePath = validatedRemotePath(result);
  mkdirSync(jobDir, { recursive: true });
  const sourcePath = path.join(jobDir, "source.webm"); const partialPath = `${sourcePath}.part`;
  if (existsSync(sourcePath)) {
    const bytes = readFileSync(sourcePath); const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length === result.output_size_bytes && sha256 === result.output_sha256) return { sourcePath, reused: true, sizeBytes: bytes.length, sha256, remotePath };
    throw new Error("persistent_source_conflicts_with_remote_output");
  }
  rmSync(partialPath, { force: true });
  requireSuccess(scpFromRemote(target, remotePath, partialPath, 30 * 60_000), "remote_output_download_failed");
  const sizeBytes = statSync(partialPath).size; const sha256 = createHash("sha256").update(readFileSync(partialPath)).digest("hex");
  if (sizeBytes < 1024 || sizeBytes !== result.output_size_bytes || sha256 !== result.output_sha256) throw new Error("remote_output_download_verification_failed");
  renameSync(partialPath, sourcePath);
  return { sourcePath, reused: false, sizeBytes, sha256, remotePath };
}

export function removeRemoteRunnerOutput(target: GpuTarget, result: RemoteRunnerResult) {
  return sshCommand(target, `rm -f ${validatedRemotePath(result)}`, 30_000);
}

export function websocketCapabilityEvidence(remoteLocal: unknown, tunneled: unknown) {
  return { websocket_remote_local: remoteLocal, websocket_tunneled: tunneled, websocket_optional: true as const };
}
