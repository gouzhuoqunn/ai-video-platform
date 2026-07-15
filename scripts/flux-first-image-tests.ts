import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FLUX_MODEL_FILES, FLUX_FIRST_IMAGE_PROMPT, buildFluxFirstImageWorkflow, validateFluxFirstImageWorkflow } from "./flux-first-image";

const root = process.cwd();
const workflow = buildFluxFirstImageWorkflow();
assert.deepEqual(validateFluxFirstImageWorkflow(workflow), []);
assert.equal(workflow["3"].inputs.text, FLUX_FIRST_IMAGE_PROMPT);
assert.equal(workflow["5"].inputs.width, 1024);
assert.equal(workflow["5"].inputs.height, 1024);
assert.equal(workflow["6"].inputs.seed, 20260715);
assert.equal(workflow["6"].inputs.steps, 4);
assert.equal(workflow["9"].class_type, "SaveImage");
assert.equal(workflow["2"].class_type, "CLIPLoader");
assert.equal(workflow["2"].inputs.type, "flux2");
assert.equal(FLUX_MODEL_FILES.length, 3);
for (const file of FLUX_MODEL_FILES) {
  assert.match(file.revision, /^[a-f0-9]{40}$/);
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.ok(file.size > 1024 * 1024);
}

const audit = JSON.parse(readFileSync(path.join(root, "comfy-runtime", "comfyui-source-audit.json"), "utf8")) as { coreNodeClasses: string[] };
for (const classType of new Set(Object.values(workflow).map((node) => node.class_type))) {
  assert.ok(audit.coreNodeClasses.includes(classType), `${classType} is not in the fixed ComfyUI source audit`);
}

const downloader = readFileSync(path.join(root, "scripts", "clore", "download-flux-klein-4b.py"), "utf8");
assert.match(downloader, /\.part/);
assert.match(downloader, /os\.replace/);
assert.match(downloader, /sha256/);
assert.match(downloader, /range/i);
const executor = readFileSync(path.join(root, "scripts", "flux-first-image-executor.ts"), "utf8");
for (const endpoint of ["/system_stats", "/object_info", "/prompt", "/history/", "/view?"]) {
  assert.ok(executor.includes(endpoint), `executor is missing ${endpoint}`);
}
assert.match(executor, /WebSocket/);
assert.match(executor, /archiveFluxFirstImage/);
console.log("FLUX first-image workflow and downloader tests passed.");
