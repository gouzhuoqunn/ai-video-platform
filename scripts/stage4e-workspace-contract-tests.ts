import assert from "node:assert/strict";
import { buildDetachedLaunchCommand, remoteJobDir } from "./clore/detached-remote-job";
import {
  REMOTE_WORKSPACE_DIRS,
  buildWorkspacePreparationCommand,
  prepareWorkspaceWithIo,
  uploadExecutableWithRepair,
  type RemoteCommandResult,
  type WorkspaceIo,
} from "./clore/remote-workspace";

class SimulatedSshFilesystem implements WorkspaceIo {
  readonly directories = new Set<string>();
  readonly files = new Map<string, { bytes: number; executable: boolean }>();
  readonly operations: string[] = [];
  failFirstUpload = false;

  run(command: string): RemoteCommandResult {
    this.operations.push(`run:${command}`);
    if (command.includes("install -d -m 0750")) {
      for (const directory of REMOTE_WORKSPACE_DIRS) this.directories.add(directory);
      return { status: 0, stdout: JSON.stringify({
        workspace_contract_ready: true,
        root: "/workspace",
        directories: [...REMOTE_WORKSPACE_DIRS],
        directory_count: REMOTE_WORKSPACE_DIRS.length,
        total_bytes: 900_000_000_000,
        free_bytes: 800_000_000_000,
        permissions: "0750",
        unsafe_symlinks: false,
        writable: true,
      }) };
    }
    if (command.includes("test -s") && command.includes("chmod 0700")) {
      const destination = "/workspace/tools/detached-job-worker.py";
      const file = this.files.get(destination);
      if (!file?.bytes) return { status: 1, stderr: "empty" };
      file.executable = true;
      return { status: 0 };
    }
    return { status: 0 };
  }

  upload(_source: string, destination: string): RemoteCommandResult {
    this.operations.push(`upload:${destination}`);
    if (this.failFirstUpload) {
      this.failFirstUpload = false;
      this.directories.delete("/workspace/tools");
      return { status: 1, stderr: "simulated missing tools" };
    }
    if (!this.directories.has("/workspace/tools")) return { status: 1, stderr: "missing tools" };
    this.files.set(destination, { bytes: 4096, executable: false });
    return { status: 0 };
  }
}

async function main() {
  const command = buildWorkspacePreparationCommand();
  for (const directory of REMOTE_WORKSPACE_DIRS) {
    assert.match(command, new RegExp(`'${directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
  }
  assert.match(command, /install -d -m 0750/);
  assert.match(command, /test ! -L/);
  const verifier = Buffer.from(command.match(/b64decode\('([^']+)'\)/)?.[1] ?? "", "base64").toString("utf8");
  assert.match(verifier, /workspace-contract\.json/);
  assert.doesNotMatch(command, /token|secret|password|authorization|api[_-]?key/i);

  const io = new SimulatedSshFilesystem();
  const first = await prepareWorkspaceWithIo(io);
  const second = await prepareWorkspaceWithIo(io);
  assert.equal(first.workspace_contract_ready, true);
  assert.equal(second.workspace_contract_ready, true);
  assert.deepEqual([...io.directories], [...REMOTE_WORKSPACE_DIRS]);

  io.failFirstUpload = true;
  const uploaded = await uploadExecutableWithRepair(io, "detached-job-worker.py", "/workspace/tools/detached-job-worker.py", 2);
  assert.equal(uploaded.attempts, 2);
  assert.equal(uploaded.non_empty, true);
  assert.equal(uploaded.executable, true);
  assert.ok(io.files.get(uploaded.destination)?.executable);
  const firstUpload = io.operations.findIndex((value) => value.startsWith("upload:"));
  assert.ok(firstUpload > 0);
  assert.match(io.operations[firstUpload - 1], /^run:/);
  assert.ok(io.operations.slice(firstUpload + 1).some((value) => value.startsWith("run:") && value.includes("install -d")));

  const jobId = "stage4e-contract-job";
  const jobDirectory = remoteJobDir(jobId);
  const launch = buildDetachedLaunchCommand({ jobId, mode: "canary" });
  for (const name of ["state.json", "stdout.log", "stderr.log"]) assert.ok(launch.includes(`${jobDirectory}/${name}`));
  for (const name of ["worker.pid", "heartbeat.json", "result.json"]) assert.ok(`/workspace/jobs/${jobId}/${name}`.startsWith(`${jobDirectory}/`));
  assert.doesNotMatch(launch, /token|secret|password|authorization|api[_-]?key/i);
  assert.match(launch, /<\/dev\/null/);

  console.log("Stage 4E workspace ordering, repair, idempotency, upload, executable, quoting, job-path, and secret-boundary tests passed.");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
