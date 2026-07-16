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

function requireSuccess(result: ReturnType<typeof sshCommand>, classification: string) {
  if (result.status !== 0) throw new Error(`${classification}:${String(result.error?.message || result.stderr || result.stdout || `exit_${result.status}`).trim().slice(-2000)}`);
  return String(result.stdout ?? "");
}

function parseRunnerJson(output: string, classification: string) {
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

export function installRemoteComfyRunner(target: GpuTarget) {
  const localRunner = path.join(process.cwd(), "scripts", "comfy-remote-runner.py");
  requireSuccess(sshCommand(target, "mkdir -p /workspace/runtime-tools/results", 30_000), "remote_runner_directory_failed");
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
}) {
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(input.clientId)) throw new Error("remote_runner_client_id_invalid");
  const nonce = crypto.randomUUID();
  const localWorkflow = path.join(os.tmpdir(), `stage3v-${nonce}.json`);
  const remoteWorkflow = `/workspace/runtime-tools/workflow-${nonce}.json`;
  writeFileSync(localWorkflow, `${JSON.stringify(input.workflow)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    requireSuccess(scpFile(input.target, localWorkflow, remoteWorkflow, 2 * 60_000), "remote_workflow_upload_failed");
    const command = `python3 ${REMOTE_RUNNER} --workflow ${remoteWorkflow} --client-id ${input.clientId} --kind ${input.kind} --timeout-seconds ${input.timeoutSeconds} --poll-seconds 2`;
    const result = sshCommand(input.target, command, (input.timeoutSeconds + 60) * 1000);
    const output = String(result.stdout ?? "");
    return parseRunnerJson(output, `${input.kind}_remote_runner_failed`);
  } finally {
    rmSync(localWorkflow, { force: true });
    sshCommand(input.target, `rm -f ${remoteWorkflow}`, 30_000);
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
