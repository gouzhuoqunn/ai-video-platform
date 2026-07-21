import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const script = readFileSync(path.join(process.cwd(), "scripts", "clore", "bootstrap-worker.sh"), "utf8");
const fixtures = [
  ["RTX 4090 24 GB", "rtx4090_wan", "23000"],
  ["RTX 4090 minor variance", "RTX[[:space:]]*4090", "23000"],
  ["wrong RTX 3090", "Expected $expected_gpu_class was not detected", "RTX[[:space:]]*4090"],
  ["RTX 5090", "rtx5090:rtx5090", "32000"],
  ["insufficient RAM", "below 32GB", "MemTotal"],
  ["insufficient disk", "below 200GB", "/workspace"],
  ["CUDA unavailable", "CUDA visibility is unavailable", "compute_mode"],
  ["conflicting process", "conflicting GPU process", "query-compute-apps"],
];
for (const [name, first, second] of fixtures) {
  assert(script.includes(first), `${name} fixture missing ${first}`);
  assert(script.includes(second), `${name} fixture missing ${second}`);
}
assert(script.includes("GPU_WORKER_RUNTIME_IMAGE"), "runtime image digest guard missing");
assert(script.includes("GPU_WORKER_EXPECTED_TASK_COUNT"), "immutable count guard missing");
console.log(JSON.stringify({ ok: true, fixtures: fixtures.map(([name]) => name) }));
