import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const dockerfile = readFileSync("comfy-runtime/Dockerfile", "utf8");
const supervisor = readFileSync("comfy-runtime/supervisor.py", "utf8");
const entrypoint = readFileSync("comfy-runtime/entrypoint.sh", "utf8");
const controller = readFileSync("comfy-runtime/controller.py", "utf8");
const launcher = readFileSync("comfy-runtime/launch_comfy.py", "utf8");
const workflow = readFileSync(".github/workflows/comfy-runtime-image.yml", "utf8");
const inventory = path.join(root, "scripts", "legacy-worker-inventory.py");

assert.match(dockerfile, /rm -f \/app\/worker\.py/);
assert.match(dockerfile, /test ! -e \/app\/worker\.py/);
assert.doesNotMatch(dockerfile, /rm -rf \/app(?:\s|$|\/\*)/);
assert.match(supervisor, /COMFY_USER_DIR = WORKSPACE \/ "comfy-user"/);
assert.match(supervisor, /--user-directory[\s\S]*str\(COMFY_USER_DIR\)/);
assert.match(supervisor, /--database-url[\s\S]*database_url\(\)/);
assert.ok(supervisor.includes('return f"sqlite:///{COMFY_DATABASE_PATH}"'));
assert.match(supervisor, /database_preflight_failed/);
assert.match(supervisor, /os\.fsync/);
assert.match(supervisor, /sqlite3\.connect\(COMFY_DATABASE_PATH\)/);
assert.doesNotMatch(supervisor, /sqlite:\/\/:memory:/);
assert.ok(
  supervisor.indexOf("ensure_database_preflight()") < supervisor.indexOf('start_process("comfyui"'),
  "database preflight must run before ComfyUI starts",
);
for (const source of [entrypoint, supervisor, controller, launcher]) {
  assert.ok(!source.includes("/app/worker.py"), "current Runtime must not reference legacy worker");
}
assert.ok(existsSync(inventory));
assert.match(workflow, /test ! -e \/app\/worker\.py/);
assert.match(workflow, /runtime-hygiene-gate/);
assert.match(workflow, /build-runtime-hygiene/);
assert.match(workflow, /verify-runtime-hygiene/);
assert.match(workflow, /v0\.1\.4-runtime-hygiene-/);
assert.match(workflow, /CPU_NO_MODEL_SMOKE_COMPLETE=true/);
assert.match(workflow, /GPU_FAIL_CLOSED_COMPLETE=true/);

const temp = mkdtempSync(path.join(os.tmpdir(), "comfy-runtime-hygiene-"));
try {
  const preflightProbe = `
import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location("supervisor", "comfy-runtime/supervisor.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
blocked = pathlib.Path(sys.argv[1]) / "blocked-user-directory"
blocked.write_text("not a directory", encoding="utf-8")
module.COMFY_USER_DIR = blocked
module.COMFY_DATABASE_PATH = blocked / "comfyui.db"
try:
    module.ensure_database_preflight()
except SystemExit as error:
    assert error.code == 43
else:
    raise AssertionError("database preflight unexpectedly continued")
`;
  execFileSync("python", ["-c", preflightProbe, temp], { cwd: root, stdio: "pipe" });

  mkdirSync(path.join(temp, "app"), { recursive: true });
  mkdirSync(path.join(temp, "opt", "comfy-runtime"), { recursive: true });
  writeFileSync(path.join(temp, "app", "worker.py"), "retired worker\n");
  for (const file of ["entrypoint.sh", "supervisor.py", "controller.py", "launch_comfy.py", "healthcheck.py"]) {
    writeFileSync(path.join(temp, "opt", "comfy-runtime", file), "# current runtime\n");
  }
  const presentOutput = path.join(temp, "present.json");
  execFileSync(
    "python",
    [inventory, "--root", temp, "--output", presentOutput, "--entrypoint", "[\"/opt/comfy-runtime/entrypoint.sh\"]"],
    { cwd: root, stdio: "pipe" },
  );
  const present = JSON.parse(readFileSync(presentOutput, "utf8"));
  assert.equal(present.legacyWorkerPathPresent, true);
  assert.deepEqual(present.approvedRemovalPaths, ["/app/worker.py"]);
  assert.throws(() => assert.equal(present.legacyWorkerPathPresent, false));

  rmSync(path.join(temp, "app", "worker.py"));
  const absentOutput = path.join(temp, "absent.json");
  execFileSync("python", [inventory, "--root", temp, "--output", absentOutput], { cwd: root, stdio: "pipe" });
  const absent = JSON.parse(readFileSync(absentOutput, "utf8"));
  assert.equal(absent.legacyWorkerPathPresent, false);
  assert.deepEqual(absent.approvedRemovalPaths, []);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("Comfy runtime hygiene tests passed");
