import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { assertRtx4090GoldenDeploymentProfile, buildRtx4090GoldenBootstrap, rtx4090GoldenDeploymentFingerprint } from "./image-executor/rtx4090-golden-deployment-profile";

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
assert.deepEqual(profile.acceptedStageResponseFields, ["accepted", "state", "status", "stage", "stage_run_id"]);
assert.equal(profile.immutable.commit, "5c9364c291ea6a10b36024832a8d1e14200889c2");
assert.equal(profile.immutable.agentSourceSha256, "678083c89a96579f7e1bf9f7b9d2783f950d83aba43a57e42d841be4a333af51");
assert.equal(profile.immutable.agentSha256, "52d94b073ee2212bdcc47c8c71b608523e6aa7278383ac83b45a3a2d7bfe8e2c");
assert.equal(profile.immutable.controllerSourceSha256, baseline.runtime.controllerSha256);
assert.equal(profile.immutable.controllerSha256, "11e1126eed3848f5220da7ad0fd4e14c2e8229a9b7c724a0862f6ddae4a8fc67");
assert.equal(profile.immutable.workflowSourceSha256, baseline.runtime.workflowSha256);
assert.equal(profile.immutable.workflowSha256, "02fdedec5812f82c96f8396f19ed7c0f3600f8ac3c620ff5473d299c3d2c1e80");
const profileFingerprint = rtx4090GoldenDeploymentFingerprint(profile);
assert.match(profileFingerprint, /^[a-f0-9]{64}$/);
assert.notEqual(
  rtx4090GoldenDeploymentFingerprint({ ...profile, bootstrapTemplateSha256: "f".repeat(64) }),
  profileFingerprint,
  "the deployment history scope changes when the executable bootstrap identity changes",
);

const command = buildRtx4090GoldenBootstrap("a".repeat(64));
assert.ok(Buffer.byteLength(command, "utf8") < 16_384);
const encodedBootstrapProgram = /base64\.b64decode\('([^']+)'\)/.exec(command)?.[1];
assert.ok(encodedBootstrapProgram);
const bootstrapProgram = inflateRawSync(Buffer.from(encodedBootstrapProgram, "base64")).toString("utf8");
assert.match(bootstrapProgram, new RegExp(profile.immutable.commit));
assert.match(bootstrapProgram, new RegExp(profile.immutable.agentSourceSha256));
assert.match(bootstrapProgram, new RegExp(profile.immutable.agentSha256));
assert.match(bootstrapProgram, new RegExp(profile.immutable.workflowSourceSha256));
assert.match(bootstrapProgram, new RegExp(profile.immutable.workflowSha256));
assert.match(bootstrapProgram, /cdn\.jsdelivr\.net\/gh\/gouzhuoqunn\/ai-video-platform@/);
assert.match(bootstrapProgram, /raw\.githubusercontent\.com\/gouzhuoqunn\/ai-video-platform\//);
assert.match(bootstrapProgram, /Content-Type/);
assert.match(bootstrapProgram, /application\/x-python/);
assert.match(bootstrapProgram, /<!doctype html/);
assert.match(bootstrapProgram, /immutable_source_hash_mismatch/);
assert.match(bootstrapProgram, /workflow-source-sha256/);
assert.match(bootstrapProgram, /workflow-patch/);
assert.doesNotMatch(command, /5ff0bd50a48434b9ce1557e7712b3c97a9c0b810/);
assert.match(bootstrapProgram, /--immutable/);
assert.equal(createHash("sha256").update(command).digest("hex").length, 64);
assert.throws(() => assertRtx4090GoldenDeploymentProfile({ ...profile, image: "ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime@sha256:c5867e642b503e22533827d59a6128bc84cd97cefdafdf2cac934d4f4ad69830" }), /profile_drift/);

assert.match(runner, /runLiveImageSession/, "manual UI runner delegates to the golden Agent session");
assert.match(runner, /运行环境未启动成功，尚未进入模型加载或图片生成/, "502/startup failure is not described as inference failure");
assert.match(live, /assertRtx4090GoldenDeploymentProfile/, "session runner consumes the shared deployment profile");
assert.match(live, /image: profile\.image/, "order payload uses the proven Jupyter image");
assert.match(live, /runtime_deployment_failed_before_model_or_inference/, "a proxy 502 is classified as runtime deployment failure");
assert.match(runner, /onOrderCreated/, "runner persists the selected profile and order evidence before health polling");
assert.doesNotMatch(bootstrapProgram, /c5867e642b503e22533827d59a6128bc84cd97cefdafdf2cac934d4f4ad69830/);

console.log(JSON.stringify({ rtx4090GoldenDeploymentProfileTestsPassed: true, providerMutationCount: 0 }));
