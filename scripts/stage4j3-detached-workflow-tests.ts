import assert from "node:assert/strict";
import { buildDetachedRemoteWorkflowCommands } from "./comfy-remote-runner";

const nonce = "01234567-89ab-4cde-8f01-23456789abcd";
const commands = buildDetachedRemoteWorkflowCommands({
  nonce,
  remoteWorkflow: `/workspace/runtime-tools/workflow-${nonce}.json`,
  clientId: "stage4j3_client",
  kind: "video",
  timeoutSeconds: 1800,
});

assert.match(commands.launch, /setsid sh -c/);
assert.match(commands.launch, /<\/dev\/null >\/dev\/null 2>&1 & pid=\$!/);
assert.match(commands.launch, /__REMOTE_JOB_STARTED__/);
assert.match(commands.launch, /__REMOTE_JOB_RESUMED__/);
assert.match(commands.poll, /__REMOTE_JOB_RUNNING__/);
assert.match(commands.poll, /__REMOTE_JOB_COMPLETE__/);
assert.doesNotMatch(commands.poll, /cat .*result\.json/);
assert.match(commands.fetchResult, /cat .*result\.json/);
assert.match(commands.stop, /kill -TERM -- -"\$pid"/);
assert.doesNotMatch(commands.launch, /known_hosts|IdentityAgent|ssh-agent/i);

assert.throws(
  () => buildDetachedRemoteWorkflowCommands({
    nonce: "../../unsafe",
    remoteWorkflow: "/workspace/runtime-tools/workflow-unsafe.json",
    clientId: "stage4j3_client",
    kind: "video",
    timeoutSeconds: 1800,
  }),
  /remote_runner_nonce_invalid/,
);

console.log("Stage 4J.3 detached workflow compatibility tests passed.");
