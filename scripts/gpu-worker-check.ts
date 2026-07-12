import { spawnSync } from "node:child_process";

function run(command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
  });
}

function findPython() {
  const candidates: Array<[string, string[]]> = [
    ["python", ["--version"]],
    ["py", ["-3", "--version"]],
    ["python3", ["--version"]],
  ];

  for (const [command, args] of candidates) {
    const result = run(command, args);
    if (result.status === 0) {
      return command === "py" ? { command, prefix: ["-3"] } : { command, prefix: [] };
    }
  }

  throw new Error("未找到可用 Python，无法运行 gpu-worker 本地测试。");
}

function runChecked(command: string, args: string[]) {
  const result = run(command, args);
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

function main() {
  const python = findPython();
  runChecked(python.command, [...python.prefix, "-m", "compileall", "-q", "gpu-worker"]);
  runChecked(python.command, [...python.prefix, "-m", "unittest", "discover", "-s", "gpu-worker/tests"]);
  console.log("GPU Worker Python检查通过。");
}

void main();
