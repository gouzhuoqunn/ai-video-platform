import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertRtx4090GoldenDeploymentProfile, buildRtx4090GoldenBootstrap } from "./image-executor/rtx4090-golden-deployment-profile";

const baseline = JSON.parse(readFileSync("docs/IMAGE_E2E_GOLDEN_BASELINE.json", "utf8")) as { runtime: { agentSha256: string; controllerSha256: string; workflowSha256: string } };
const runner = readFileSync("scripts/image-4090-runner.ts", "utf8");
const live = readFileSync("scripts/clore/image-live-runtime.ts", "utf8");

const profile = assertRtx4090GoldenDeploymentProfile();
assert.equal(profile.id, "rtx4090-golden-agent-v1");
assert.equal(profile.image, "cloreai/jupyter:ubuntu24.04-v2");
assert.deepEqual(profile.ports, { "8080": "http" });
assert.equal(profile.healthPath, "/healthz");
assert.equal(profile.controllerBind, "0.0.0.0:8080");
assert.equal(profile.agentContract, "stage-acceptance-v2");
assert.equal(profile.immutable.agentSha256, baseline.runtime.agentSha256);
assert.equal(profile.immutable.controllerSha256, baseline.runtime.controllerSha256);
assert.equal(profile.immutable.workflowSha256, baseline.runtime.workflowSha256);

const command = buildRtx4090GoldenBootstrap("a".repeat(64));
assert.ok(Buffer.byteLength(command, "utf8") < 700);
assert.match(command, /--immutable/);
assert.equal(createHash("sha256").update(command).digest("hex").length, 64);
assert.throws(() => assertRtx4090GoldenDeploymentProfile({ ...profile, image: "ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime@sha256:c5867e642b503e22533827d59a6128bc84cd97cefdafdf2cac934d4f4ad69830" }), /profile_drift/);

assert.match(runner, /runLiveImageSession/, "manual UI runner delegates to the golden Agent session");
assert.match(runner, /运行环境未启动成功，尚未进入模型加载或图片生成/, "502/startup failure is not described as inference failure");
assert.match(live, /assertRtx4090GoldenDeploymentProfile/, "session runner consumes the shared deployment profile");
assert.match(live, /image: profile\.image/, "order payload uses the proven Jupyter image");
assert.match(live, /runtime_deployment_failed_before_model_or_inference/, "a proxy 502 is classified as runtime deployment failure");
assert.match(runner, /onOrderCreated/, "runner persists the selected profile and order evidence before health polling");
assert.doesNotMatch(command, /c5867e642b503e22533827d59a6128bc84cd97cefdafdf2cac934d4f4ad69830/);

console.log(JSON.stringify({ rtx4090GoldenDeploymentProfileTestsPassed: true, providerMutationCount: 0 }));
