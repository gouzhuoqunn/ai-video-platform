import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const workflowPath = ".github/workflows/comfy-runtime-image.yml";
const parsed = spawnSync(
  "python",
  [
    "-c",
    "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding='utf-8'))))",
    workflowPath,
  ],
  { encoding: "utf8" },
);
assert.equal(parsed.status, 0, parsed.stderr || "workflow YAML must parse");

const workflow = JSON.parse(parsed.stdout) as { jobs: Record<string, Record<string, unknown>> };
const jobs = workflow.jobs;
assert.deepEqual(Object.keys(jobs).sort(), ["build-and-push", "runtime-hygiene-gate", "verify-public-digest"]);

const packageWriters = Object.entries(jobs).filter(([, job]) => {
  const permissions = job.permissions as Record<string, string> | undefined;
  return permissions?.packages === "write";
});
assert.deepEqual(packageWriters.map(([name]) => name), ["build-and-push"]);

const gate = jobs["runtime-hygiene-gate"];
const build = jobs["build-and-push"];
const verify = jobs["verify-public-digest"];
assert.equal((gate.permissions as Record<string, string>).contents, "read");
assert.equal((gate.permissions as Record<string, string>).packages, undefined);
assert.equal(build.needs, "runtime-hygiene-gate");
assert.match(String(build.if), /needs\.runtime-hygiene-gate\.outputs\.gate_passed == 'true'/);
assert.equal(verify.needs, "build-and-push");

const workflowText = readFileSync(workflowPath, "utf8");
assert.equal((workflowText.match(/docker\/build-push-action@v6/g) ?? []).length, 1);
assert.ok(!/build-node-profile-runtime|build-runtime-hygiene|verify-node-profile-runtime|verify-runtime-hygiene/.test(workflowText));
assert.ok(!/docker\/login-action/.test(JSON.stringify(gate)));
assert.ok(!/docker\/build-push-action/.test(JSON.stringify(gate)));

console.log("Comfy Runtime workflow DAG tests passed");
