import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GpuTarget } from "../gpu-providers/types";
import { scpFile, sshCommand } from "../gpu-providers/common";

export const REMOTE_WORKSPACE_DIRS = [
  "/workspace",
  "/workspace/tools",
  "/workspace/jobs",
  "/workspace/logs",
  "/workspace/runtime",
  "/workspace/runtime-tools",
  "/workspace/models",
  "/workspace/models/checkpoints",
  "/workspace/models/diffusion_models",
  "/workspace/models/text_encoders",
  "/workspace/models/vae",
  "/workspace/input",
  "/workspace/output",
  "/workspace/temp",
] as const;

export const WORKSPACE_MIN_TOTAL_BYTES = 200_000_000_000;
export const WORKSPACE_MIN_FREE_BYTES = 80_000_000_000;

export type RemoteCommandResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

export type WorkspaceIo = {
  run(command: string, timeoutMs: number): RemoteCommandResult;
  upload(source: string, destination: string, timeoutMs: number): RemoteCommandResult;
};

export type WorkspaceContract = {
  workspace_contract_ready: true;
  root: "/workspace";
  directories: string[];
  directory_count: number;
  total_bytes: number;
  free_bytes: number;
  permissions: "0750";
  unsafe_symlinks: false;
  writable: true;
};

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function buildWorkspacePreparationCommand() {
  const directories = REMOTE_WORKSPACE_DIRS.map(quote).join(" ");
  const verifier = Buffer.from(`
import json,os,pathlib
paths=${JSON.stringify([...REMOTE_WORKSPACE_DIRS])}
bad=[]
for value in paths:
 p=pathlib.Path(value)
 if p.is_symlink() or not p.is_dir() or not os.access(p,os.W_OK|os.X_OK): bad.append(value)
st=os.statvfs("/workspace")
total=st.f_frsize*st.f_blocks
free=st.f_frsize*st.f_bavail
if bad: raise SystemExit("workspace_contract_invalid:"+",".join(bad))
if total<${WORKSPACE_MIN_TOTAL_BYTES}: raise SystemExit("workspace_total_disk_insufficient")
if free<${WORKSPACE_MIN_FREE_BYTES}: raise SystemExit("workspace_free_disk_insufficient")
value={"workspace_contract_ready":True,"root":"/workspace","directories":paths,"directory_count":len(paths),"total_bytes":total,"free_bytes":free,"permissions":"0750","unsafe_symlinks":False,"writable":True}
target=pathlib.Path("/workspace/logs/workspace-contract.json")
temporary=target.with_suffix(".json.part")
temporary.write_text(json.dumps(value,separators=(",",":"))+"\\n",encoding="utf-8")
os.replace(temporary,target)
print(json.dumps(value,separators=(",",":")))
`.trim()).toString("base64");
  return `set -euo pipefail; for p in ${directories}; do if [ -L "$p" ]; then echo "workspace_unsafe_symlink:$p" >&2; exit 41; fi; done; ` +
    `install -d -m 0750 -- ${directories}; ` +
    `for p in ${directories}; do test -d "$p" && test -w "$p" && test -x "$p" && test ! -L "$p"; done; ` +
    `python3 -c "import base64;exec(base64.b64decode('${verifier}'))"`;
}

function parseContract(result: RemoteCommandResult) {
  if (result.status !== 0) throw new Error(`workspace_contract_prepare_failed:${String(result.stderr ?? result.error?.message ?? result.stdout).slice(-2000)}`);
  try {
    const value = JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1) ?? "") as WorkspaceContract;
    if (!value.workspace_contract_ready || value.directory_count !== REMOTE_WORKSPACE_DIRS.length || value.unsafe_symlinks || !value.writable) throw new Error("invalid");
    return value;
  } catch {
    throw new Error("workspace_contract_result_invalid");
  }
}

export async function prepareWorkspaceWithIo(io: WorkspaceIo, attempts = 3) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return parseContract(io.run(buildWorkspacePreparationCommand(), 30_000)); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

export function targetWorkspaceIo(target: GpuTarget): WorkspaceIo {
  return {
    run: (command, timeoutMs) => sshCommand(target, command, timeoutMs),
    upload: (source, destination, timeoutMs) => scpFile(target, source, destination, timeoutMs),
  };
}

export function prepareRemoteWorkspace(target: GpuTarget, attempts = 3) {
  return prepareWorkspaceWithIo(targetWorkspaceIo(target), attempts);
}

export async function uploadExecutableWithRepair(io: WorkspaceIo, source: string, destination: string, attempts = 2) {
  if (!destination.startsWith("/workspace/tools/") || destination.includes("..")) throw new Error("workspace_upload_destination_invalid");
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await prepareWorkspaceWithIo(io, 1);
      const uploaded = io.upload(source, destination, 120_000);
      if (uploaded.status !== 0) throw new Error(`workspace_upload_failed:${String(uploaded.stderr ?? uploaded.error?.message).slice(-1000)}`);
      const verified = io.run(`set -e; test ! -L ${quote(destination)}; test -s ${quote(destination)}; chmod 0700 -- ${quote(destination)}; test -x ${quote(destination)}`, 30_000);
      if (verified.status !== 0) throw new Error(`workspace_upload_verify_failed:${String(verified.stderr ?? verified.error?.message).slice(-1000)}`);
      return { destination, attempts: attempt, non_empty: true, executable: true };
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

export async function verifyWorkspaceRoundtrip(target: GpuTarget) {
  const io = targetWorkspaceIo(target);
  const root = path.join(os.tmpdir(), `stage4e-workspace-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const text = `stage4e-upload-probe-${randomUUID()}`;
  const data = path.join(root, "probe.txt");
  const script = path.join(root, "probe.sh");
  writeFileSync(data, `${text}\n`, { encoding: "utf8", mode: 0o600 });
  writeFileSync(script, "#!/usr/bin/env sh\nprintf 'stage4e-remote-exec-ready\\n'\n", { encoding: "utf8", mode: 0o700 });
  try {
    await prepareWorkspaceWithIo(io, 1);
    const dataUpload = io.upload(data, "/workspace/tools/stage4e-probe.txt", 30_000);
    if (dataUpload.status !== 0) throw new Error("workspace_probe_upload_failed");
    const scriptUpload = io.upload(script, "/workspace/tools/stage4e-probe.sh", 30_000);
    if (scriptUpload.status !== 0) throw new Error("workspace_script_upload_failed");
    const check = io.run(`set -e; test ! -L /workspace/tools/stage4e-probe.txt; test ! -L /workspace/tools/stage4e-probe.sh; ` +
      `test -s /workspace/tools/stage4e-probe.txt; test -s /workspace/tools/stage4e-probe.sh; ` +
      `test "$(cat /workspace/tools/stage4e-probe.txt)" = ${quote(text)}; chmod 0700 /workspace/tools/stage4e-probe.sh; ` +
      `test -x /workspace/tools/stage4e-probe.sh; test "$(/workspace/tools/stage4e-probe.sh)" = stage4e-remote-exec-ready; ` +
      `rm -f /workspace/tools/stage4e-probe.txt /workspace/tools/stage4e-probe.sh; ` +
      `test $(df -PB1 /workspace | awk 'NR==2{print $4}') -ge ${WORKSPACE_MIN_FREE_BYTES}; ` +
      `printf '{"upload_roundtrip_ready":true,"remote_exec_ready":true}\\n'`, 30_000);
    if (check.status !== 0) throw new Error(`workspace_probe_verify_failed:${String(check.stderr ?? check.error?.message).slice(-1000)}`);
    const value = JSON.parse(String(check.stdout).trim().split(/\r?\n/).at(-1) ?? "") as { upload_roundtrip_ready: boolean; remote_exec_ready: boolean };
    if (!value.upload_roundtrip_ready || !value.remote_exec_ready) throw new Error("workspace_probe_result_invalid");
    return value;
  } finally {
    rmSync(root, { recursive: true, force: true });
    io.run("rm -f /workspace/tools/stage4e-probe.txt /workspace/tools/stage4e-probe.sh", 30_000);
  }
}
