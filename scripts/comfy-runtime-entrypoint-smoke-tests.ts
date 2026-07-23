import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = process.cwd();

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function pollJson(url: string, predicate: (payload: Record<string, unknown>) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const payload = (await response.json()) as Record<string, unknown>;
      last = { status: response.status, payload };
      if (response.status === 200 && predicate(payload)) return payload;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${url}: ${JSON.stringify(last)}`);
}

function stop(process: ChildProcessWithoutNullStreams) {
  if (process.exitCode === null && !process.killed) process.kill();
}

async function controllerHealthContract() {
  const temp = mkdtempSync(path.join(os.tmpdir(), "controller-health-"));
  const port = await freePort();
  const statePath = path.join(temp, "runtime-state.json");
  const logDir = path.join(temp, "logs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, "comfyui.log"), "[comfyui] startup pending\n", "utf8");
  writeFileSync(statePath, JSON.stringify({ stage: "starting_comfyui", ready: false, error: null, node_profile: "image-flux", updated_at: Date.now() / 1000 }), "utf8");
  const child = spawn("python", ["comfy-runtime/controller.py", "--host", "127.0.0.1", "--port", String(port), "--state-path", statePath, "--log-dir", logDir], {
    cwd: root,
    env: { ...process.env, COMFY_RUNTIME_DIR: path.join(root, "comfy-runtime"), COMFY_WORKSPACE: temp },
    stdio: "pipe",
  });
  try {
    const starting = await pollJson(`http://127.0.0.1:${port}/healthz`, (payload) => payload.controller === "alive" && payload.ready === false);
    assert.equal(starting.stage, "starting_comfyui", "controller health separates alive from runtime readiness");

    writeFileSync(statePath, JSON.stringify({ stage: "runtime_ready", ready: true, error: null, node_profile: "image-flux", updated_at: Date.now() / 1000 }), "utf8");
    const ready = await pollJson(`http://127.0.0.1:${port}/healthz`, (payload) => payload.ready === true);
    assert.equal(ready.stage, "runtime_ready", "ready=true is exposed only when runtime is ready");

    writeFileSync(statePath, JSON.stringify({ stage: "runtime_failed", ready: false, error: "simulated comfy failure", comfyui_exit_code: 77, node_profile: "image-flux", updated_at: Date.now() / 1000 }), "utf8");
    const failed = await pollJson(`http://127.0.0.1:${port}/healthz`, (payload) => payload.stage === "runtime_failed");
    assert.equal(failed.error, "simulated comfy failure", "failed-ComfyUI health returns runtime_failed JSON");
  } finally {
    stop(child);
    rmSync(temp, { recursive: true, force: true });
  }
}

async function entrypointKeepsControllerAliveWhenComfyFails() {
  const temp = mkdtempSync(path.join(os.tmpdir(), "entrypoint-smoke-"));
  const port = await freePort();
  const comfyPort = await freePort();
  const emptyComfy = path.join(temp, "empty-comfy");
  mkdirSync(emptyComfy, { recursive: true });
  const child = spawn("python", ["comfy-runtime/supervisor.py"], {
    cwd: root,
    env: {
      ...process.env,
      COMFY_WORKSPACE: temp,
      COMFY_LOG_DIR: path.join(temp, "logs"),
      COMFY_RUNTIME_STATE_PATH: path.join(temp, "logs", "runtime-state.json"),
      COMFY_RUNTIME_DIR: path.join(root, "comfy-runtime"),
      COMFY_PYTHON: "python",
      COMFYUI_DIR: emptyComfy,
      COMFY_RUNTIME_MODE: "smoke_cpu",
      COMFY_NODE_PROFILE: "image-flux",
      COMFY_CONTROLLER_HOST: "127.0.0.1",
      COMFY_CONTROLLER_PORT: String(port),
      COMFYUI_PORT: String(comfyPort),
      START_GPU_WORKER: "false",
    },
    stdio: "pipe",
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  try {
    const failed = await pollJson(`http://127.0.0.1:${port}/healthz`, (payload) => payload.controller === "alive" && payload.stage === "runtime_failed", 30_000);
    assert.equal(failed.ready, false, "failed ComfyUI is not considered ready");
    assert.match(String(failed.error), /comfyui_unhealthy|No such file|FileNotFound|main\.py|supervisor_process_failure/, "first internal ComfyUI failure is surfaced");
    assert.equal(child.exitCode, null, "container supervisor remains alive after ComfyUI failure");
  } finally {
    stop(child);
    rmSync(temp, { recursive: true, force: true });
    if (!/supervisor_process_failure|FileNotFound|comfyui_unhealthy|database_preflight_failed/.test(output)) {
      throw new Error(`expected supervised failure logs, got: ${output.slice(-2000)}`);
    }
  }
}

async function main() {
  const dockerfile = readFileSync("comfy-runtime/Dockerfile", "utf8");
  const supervisor = readFileSync("comfy-runtime/supervisor.py", "utf8");
  const controller = readFileSync("comfy-runtime/controller.py", "utf8");
  const entrypoint = readFileSync("comfy-runtime/entrypoint.sh", "utf8");
  const workflow = readFileSync(".github/workflows/comfy-runtime-image.yml", "utf8");

  assert.match(dockerfile, /EXPOSE 8080/, "Dockerfile exposes controller port 8080");
  assert.ok(!entrypoint.includes("\r\n"), "entrypoint.sh has LF line endings");
  assert.match(execFileSync("git", ["ls-files", "--stage", "comfy-runtime/entrypoint.sh"], { cwd: root, encoding: "utf8" }), /^100755\s/, "entrypoint.sh is executable");
  assert.ok(supervisor.indexOf('start_controller()') < supervisor.indexOf('start_process("comfyui"'), "controller starts before ComfyUI");
  assert.match(controller, /ThreadingHTTPServer\(\(args\.host, args\.port\)/, "controller binds requested host and port");
  assert.match(controller, /"controller": "alive"/, "health reports controller alive");
  assert.match(controller, /"ready": ready/, "health separates readiness");
  assert.doesNotMatch(supervisor + controller + entrypoint, /Wan|LTX|wan_runner|\/app\/worker\.py/, "image startup has no Wan/LTX dependency");
  assert.match(workflow, /runtime-entrypoint-smoke/, "GitHub Actions includes focused entrypoint smoke");

  execFileSync("python", ["-m", "py_compile", "comfy-runtime/supervisor.py", "comfy-runtime/controller.py", "comfy-runtime/healthcheck.py"], { cwd: root, stdio: "pipe" });
  await controllerHealthContract();
  await entrypointKeepsControllerAliveWhenComfyFails();
  console.log("comfy runtime entrypoint smoke tests: ok");
}

void main();
