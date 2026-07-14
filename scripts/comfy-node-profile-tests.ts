import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

type WorkflowManifest = {
  workflows: Array<{
    requiredNodeClasses: string[];
  }>;
};

type SourceAudit = {
  commit: string;
  coreNodeClasses: string[];
  sourceFiles: Record<string, string[]>;
};

type NodeProfile = {
  profile: string;
  comfyuiCommit: string;
  workflowManifestSha256: string;
  sourceAuditSha256: string;
  disableCustomNodes: boolean;
  baseNodeClasses: string[];
  generatorVersion: string;
  builtinExtraFiles: string[];
  excludedBuiltinExtraFiles: string[];
  requiredNodeClasses: string[];
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const manifest = readJson<WorkflowManifest>("comfy-runtime/workflows/official/manifest.json");
const audit = readJson<SourceAudit>("comfy-runtime/comfyui-source-audit.json");
const profile = readJson<NodeProfile>("comfy-runtime/node-profiles/production-minimal.json");
const fullManual = readJson<{ useComfyDefaultBuiltinExtras: boolean }>(
  "comfy-runtime/node-profiles/full-manual.json",
);
const launchComfy = readFileSync("comfy-runtime/launch_comfy.py", "utf8");
const supervisor = readFileSync("comfy-runtime/supervisor.py", "utf8");
const dockerfile = readFileSync("comfy-runtime/Dockerfile", "utf8");
const workflow = readFileSync(".github/workflows/comfy-runtime-image.yml", "utf8");

const manifestRequired = new Set(manifest.workflows.flatMap((workflowItem) => workflowItem.requiredNodeClasses));
const profileRequired = new Set(profile.requiredNodeClasses);
assert.equal(profile.profile, "production_minimal");
assert.equal(profile.disableCustomNodes, true);
assert.equal(profile.generatorVersion, "stage-two-eight-b-static-1");
assert.equal(profile.comfyuiCommit, audit.commit);
assert.equal(profile.workflowManifestSha256, "acb0a624f433a174366bc2820ab835c34273f0c102acc0651b09f75e800ca5d5");
assert.equal(profile.sourceAuditSha256, "93a5eb8ae8af7001bd98080e15ce332c78f5c827e74f595597441574679db3e2");
assert.equal(fullManual.useComfyDefaultBuiltinExtras, true);

for (const requiredNodeClass of manifestRequired) {
  assert.ok(profileRequired.has(requiredNodeClass), `profile missing workflow node ${requiredNodeClass}`);
}

for (const requiredNodeClass of profile.requiredNodeClasses) {
  assert.ok(audit.coreNodeClasses.includes(requiredNodeClass), `profile node not in Comfy source audit: ${requiredNodeClass}`);
}

assert.deepEqual(new Set(profile.baseNodeClasses), new Set(audit.sourceFiles["nodes.py"]));

for (const builtinExtra of profile.builtinExtraFiles) {
  assert.ok(audit.sourceFiles[builtinExtra]?.length, `profile builtin extra not audited: ${builtinExtra}`);
}

assert.ok(profile.excludedBuiltinExtraFiles.includes("comfy_extras/nodes_post_processing.py"));
assert.ok(profile.excludedBuiltinExtraFiles.includes("comfy_extras/nodes_latent.py"));
assert.ok(profile.builtinExtraFiles.every((file) => !profile.excludedBuiltinExtraFiles.includes(file)));
assert.ok(existsSync("comfy-runtime/smoke_import_blocker/triton/__init__.py"));
assert.match(launchComfy, /nodes\.init_builtin_extra_nodes = init_profile_builtin_extra_nodes/);
assert.match(launchComfy, /PROFILE_REQUIRED_NODE_CLASSES_OK/);
assert.match(launchComfy, /workflow_manifest_sha256/);
assert.match(supervisor, /COMFY_NODE_PROFILE/);
assert.match(supervisor, /COMFY_GPU_PROFILE/);
assert.match(supervisor, /SMOKE_IMPORT_BLOCKER/);
assert.match(supervisor, /gpu_preflight_failed: smoke import blocker present in PYTHONPATH/);
assert.match(dockerfile, /COPY node-profiles\//);
assert.match(dockerfile, /COPY smoke_import_blocker\//);
assert.match(dockerfile, /ARG KORNIA_VERSION/);
assert.match(dockerfile, /kornia==\$\{KORNIA_VERSION\}/);
assert.match(workflow, /diagnose-node-profile-fixed-digest/);
assert.match(workflow, /build-node-profile-runtime/);
assert.match(workflow, /COMFY_RUNTIME_MODE=smoke_cpu/);
assert.match(workflow, /COMFY_NODE_PROFILE=production_minimal/);
assert.match(workflow, /COMFY_GPU_PROFILE=rtx4090/);

console.log("Comfy node profile tests passed");
