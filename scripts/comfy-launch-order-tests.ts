import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

function assertComfyArgsBeforeNodes(source: string) {
  const parseIndex = source.indexOf("enable_args_parsing");
  const nodesIndex = source.indexOf("import nodes");
  assert.notEqual(parseIndex, -1, "launcher must call enable_args_parsing");
  assert.notEqual(nodesIndex, -1, "launcher must import nodes");
  assert.ok(parseIndex < nodesIndex, "ComfyUI args must be parsed before importing nodes");
}

function canonicalProfileSha(profile: Record<string, unknown>) {
  const clone = { ...profile };
  delete clone.profileSha256;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sortJson(clone)))
    .digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

const launcher = readFileSync("comfy-runtime/launch_comfy.py", "utf8");
assertComfyArgsBeforeNodes(launcher);
assert.match(launcher, /ComfyUI args\.cpu was not true before importing nodes/);
assert.match(launcher, /model_management\.CPUState\.CPU/);
assert.match(launcher, /node profile is unverified and cannot be used/);
assert.match(launcher, /async def init_profile_builtin_extra_nodes/);
assert.match(launcher, /await load_profile_builtin_extra_nodes/);
assert.match(launcher, /await nodes_module\.load_custom_node/);
assert.doesNotMatch(launcher, /asyncio\.gather|create_task|asyncio\.run|run_until_complete/);
assert.match(
  launcher,
  /async def init_profile_builtin_extra_nodes[\s\S]*await load_profile_builtin_extra_nodes[\s\S]*verify_required_nodes\(nodes, required_nodes\)/,
);

assert.throws(() => {
  assertComfyArgsBeforeNodes(`
import nodes
import comfy.options
comfy.options.enable_args_parsing()
`);
}, /before importing nodes/);

const profile = JSON.parse(readFileSync("comfy-runtime/node-profiles/production-minimal.json", "utf8")) as Record<
  string,
  unknown
>;
assert.equal(profile.profileSha256, canonicalProfileSha(profile));

console.log("Comfy launch order tests passed");
