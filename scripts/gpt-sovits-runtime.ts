import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureLocalAudioDirectories } from "../src/lib/local-data/path-registry";

type RuntimeManifest = {
  runtime: string;
  releaseTag: string;
  sourceCommit: string;
  python: string;
  device: string;
  pyopenjtalk?: { version: string; officialSourceSha256: string; wheelStatus: string };
};

function manifest() {
  return JSON.parse(readFileSync(path.join(process.cwd(), "config", "gpt-sovits-runtime-manifest.json"), "utf8")) as RuntimeManifest;
}

function pythonImport(pythonPath: string, module: string) {
  if (!existsSync(pythonPath)) return { installed: false, detail: "isolated_python_missing" };
  const result = spawnSync(pythonPath, ["-c", `import ${module}; print(getattr(${module}, '__version__', 'installed'))`], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  return result.status === 0 ? { installed: true, detail: String(result.stdout).trim() } : { installed: false, detail: "module_not_installed" };
}

function snapshot(action: string) {
  const { paths, directories } = ensureLocalAudioDirectories();
  const current = manifest();
  const pyopenjtalk = pythonImport(path.join(paths.voiceRuntimeEnvRoot, "python.exe"), "pyopenjtalk");
  const sourcePresent = existsSync(path.join(paths.voiceRuntimeSourceRoot, ".git"));
  const status = {
    action,
    at: new Date().toISOString(),
    runtime: current.runtime,
    releaseTag: current.releaseTag,
    sourceCommit: current.sourceCommit,
    cpuOnly: current.device === "cpu",
    directories,
    sourcePresent,
    pyopenjtalk,
    ready: sourcePresent && pyopenjtalk.installed,
    blocker: pyopenjtalk.installed ? null : "blocked_pyopenjtalk_artifact_download",
  };
  writeFileSync(path.join(paths.workerStateRoot, "gpt-sovits-setup-journal.json"), `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return status;
}

const command = process.argv[2] ?? "status";
if (!["setup", "status", "verify", "repair", "uninstall-runtime"].includes(command)) throw new Error("gpt_sovits_runtime_command_invalid");
if (command === "uninstall-runtime") {
  if (!process.argv.includes("--execute")) throw new Error("uninstall_requires_execute");
  const { paths } = ensureLocalAudioDirectories();
  // Deliberately narrow: reusable packs, inference revisions and media are never targets.
  for (const target of [paths.voiceRuntimeSourceRoot, paths.voiceRuntimeEnvRoot, paths.gptSoVitsModelRoot]) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ok: true, action: command, preserved: [paths.voicePackRoot, paths.voiceInferenceRoot] }));
} else {
  const status = snapshot(command);
  if (command === "verify" && !status.ready) process.exitCode = 2;
  console.log(JSON.stringify(status));
}
