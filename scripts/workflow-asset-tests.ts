import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_TEMPLATES, injectWorkflowParameters, validateWorkflowTemplate } from "../src/lib/generation/workflow-registry";

type WorkflowManifest = {
  schemaVersion: 1;
  comfyuiCommit: string;
  workflows: Array<{
    key: string;
    candidateKey: string;
    uiFile: string;
    apiFile: string;
    status: string;
    uiSha256: string;
    apiSha256: string;
    requiredNodeClasses: string[];
    requiredModelFiles: string[];
  }>;
};

const root = join("comfy-runtime", "workflows", "official");

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function main() {
  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WorkflowManifest;
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.comfyuiCommit, "da2608926eaf68fd532bba4e1ace3402c5d21399");
  assert.deepEqual(
    manifest.workflows.map((workflow) => workflow.key).sort(),
    ["flux2-klein-4b-distilled", "wan22-i2v-a14b", "wan22-ti2v-5b"],
  );

  for (const workflow of manifest.workflows) {
    const uiPath = join(root, workflow.uiFile);
    const apiPath = join(root, workflow.apiFile);
    assert.ok(existsSync(uiPath), `${workflow.uiFile} must exist`);
    assert.ok(existsSync(apiPath), `${workflow.apiFile} must exist`);
    assert.equal(sha256(uiPath), workflow.uiSha256);
    assert.equal(sha256(apiPath), workflow.apiSha256);
    assert.ok(workflow.requiredNodeClasses.length > 0);
    assert.ok(workflow.requiredModelFiles.length > 0);
    const api = readJson(apiPath);
    assert.ok(Object.values(api).every((node) => typeof node === "object" && node !== null && "class_type" in node && "inputs" in node));
  }

  assert.equal(WORKFLOW_TEMPLATES.image_t2i.execution_status, "subgraph_registration_required");
  assert.equal(WORKFLOW_TEMPLATES.video_ti2v.execution_status, "api_executable_when_models_present");
  assert.equal(WORKFLOW_TEMPLATES.video_i2v.execution_status, "api_executable_when_models_present");
  for (const workflow of Object.values(WORKFLOW_TEMPLATES)) {
    assert.deepEqual(validateWorkflowTemplate(workflow), [], `${workflow.key} must validate`);
  }

  const imagePrompt = injectWorkflowParameters(WORKFLOW_TEMPLATES.image_t2i, { prompt: "synthetic product smoke" }) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(imagePrompt["92"].inputs.text, "synthetic product smoke");
  const videoPrompt = injectWorkflowParameters(WORKFLOW_TEMPLATES.video_ti2v, { prompt: "synthetic video smoke", width: 854, height: 480, frames: 49 }) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(videoPrompt["6"].inputs.text, "synthetic video smoke");
  assert.equal(videoPrompt["55"].inputs.width, 854);
  assert.equal(videoPrompt["55"].inputs.length, 49);

  console.log("workflow asset tests passed");
}

main();
