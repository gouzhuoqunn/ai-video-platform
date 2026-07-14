import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const verifier = path.join(root, "scripts", "verify-comfy-object-info.py");
const profilePath = path.join(root, "comfy-runtime", "node-profiles", "production-minimal.json");
const workflowPath = path.join(root, ".github", "workflows", "comfy-runtime-image.yml");
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as { requiredNodeClasses: string[] };

function runVerifier(input: string, profile = profilePath): { ok: boolean; output: string } {
  try {
    return {
      ok: true,
      output: execFileSync("python", [verifier, "--input", input, "--profile", profile], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }
}

function expectFailure(input: string) {
  const result = runVerifier(input);
  assert.equal(result.ok, false, `expected validation to fail for ${input}`);
  assert.match(result.output, /object_info_validation_error|missing_node_count=/);
}

const tempDir = mkdtempSync(path.join(os.tmpdir(), "comfy-d4-acceptance-"));
try {
  const complete = path.join(tempDir, "object-info.json");
  writeFileSync(complete, JSON.stringify(Object.fromEntries(profile.requiredNodeClasses.map((node) => [node, {}]))));
  const completeResult = runVerifier(complete);
  assert.equal(completeResult.ok, true);
  assert.match(completeResult.output, /required_node_count=17/);
  assert.match(completeResult.output, /missing_node_count=0/);

  const empty = path.join(tempDir, "empty.json");
  writeFileSync(empty, "");
  expectFailure(empty);

  const invalid = path.join(tempDir, "invalid.json");
  writeFileSync(invalid, "{");
  expectFailure(invalid);

  const array = path.join(tempDir, "array.json");
  writeFileSync(array, "[]");
  expectFailure(array);

  const missing = path.join(tempDir, "missing.json");
  writeFileSync(missing, JSON.stringify({ [profile.requiredNodeClasses[0]]: {} }));
  expectFailure(missing);

  expectFailure(path.join(tempDir, "does-not-exist.json"));

  const oversized = path.join(tempDir, "oversized.json");
  const descriptor = openSync(oversized, "w");
  ftruncateSync(descriptor, 128 * 1024 * 1024 + 1);
  closeSync(descriptor);
  expectFailure(oversized);

  const workflow = readFileSync(workflowPath, "utf8");
  const d4Start = workflow.indexOf("D4 Production minimal node profile smoke on fixed digest");
  const d4End = workflow.indexOf("  build-node-profile-runtime:", d4Start);
  assert.notEqual(d4Start, -1);
  assert.notEqual(d4End, -1);
  const d4 = workflow.slice(d4Start, d4End);
  assert.ok(!workflow.includes("/tmp/d4-object-info.json"));
  assert.ok(!workflow.includes("/tmp/object-info.json"));
  assert.ok(!workflow.includes('with open("/tmp/object-info.json"'));
  assert.doesNotMatch(
    workflow,
    /docker exec "\$\{container\}" curl -fsS http:\/\/127\.0\.0\.1:8188\/(object_info|system_stats|queue|history)[^\n]*>\/tmp\//,
  );
  assert.match(d4, /HOST_D4_OBJECT_INFO="\$\{RUNNER_TEMP\}\/d4-object-info-\$\{GITHUB_RUN_ID\}\.json"/);
  assert.match(d4, /docker exec "\$\{container\}" curl -fsS http:\/\/127\.0\.0\.1:8188\/object_info >"\$\{HOST_D4_OBJECT_INFO_TMP\}"/);
  assert.match(d4, /python3 scripts\/verify-comfy-object-info\.py --input "\$\{HOST_D4_OBJECT_INFO\}" --profile comfy-runtime\/node-profiles\/production-minimal\.json/);
  assert.ok(!d4.includes('docker exec -i "${container}" python3.11'));
  assert.match(d4, /set -euo pipefail/);
  assert.match(d4, /CONTAINER_D4_PROFILE_LOG="\/workspace\/logs\/d4-profile-\$\{GITHUB_RUN_ID\}\.log"/);
  assert.match(d4, /namespace_conflicts=0/);
  const verifierSource = readFileSync(verifier, "utf8");
  assert.ok(!verifierSource.includes("/tmp/"));
  assert.ok(!/import\s+(torch|ComfyUI|docker)/.test(verifierSource));
  assert.ok(existsSync(verifier));
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("Comfy D4 acceptance tests passed");
