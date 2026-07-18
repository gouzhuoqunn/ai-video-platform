import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildDetachedRemoteWorkflowCommands,
  executeDetachedRemoteWorkflowContract,
  type DetachedRemoteWorkflowOperations,
} from "./comfy-remote-runner";

const nonce = "01234567-89ab-4cde-8f01-23456789abcd";
const commands = buildDetachedRemoteWorkflowCommands({
  nonce,
  remoteWorkflow: `/workspace/runtime-tools/workflow-${nonce}.json`,
  clientId: "stage4j4_fixture",
  kind: "video",
  timeoutSeconds: 30,
});
const validResult = JSON.stringify({
  ok: true,
  mode: "workflow",
  websocket_remote_local: { attempted: true, connected: true },
  websocket_optional: true,
  staged_path: "/workspace/runtime-tools/results/01234567-89ab-4cde-8f01-23456789abcd.webm",
  output_size_bytes: 4096,
  output_sha256: "a".repeat(64),
});

function commandResult(stdout: string, status = 0, stderr = "") {
  return { stdout, stderr, status, error: undefined } as never;
}

assert.match(commands.launch, /setsid sh -c/);
assert.match(commands.launch, /<\/dev\/null >\/dev\/null 2>&1/);
assert.match(commands.launch, /pid=\$!/);
assert.match(commands.launch, /result\.json\.part/);
assert.match(commands.launch, /mv -f .*result\.json\.part .*result\.json/);
assert.match(commands.launch, /exit-code\.part/);
assert.match(commands.launch, /terminal\.part/);
assert.doesNotMatch(commands.poll, /result\.json/);
assert.notEqual(commands.fetchResult, commands.poll);
assert.notEqual(commands.cleanup, commands.poll);

let pollCount = 0;
let fetchCount = 0;
const success = executeDetachedRemoteWorkflowContract({
  commands,
  kind: "video",
  timeoutSeconds: 30,
  operations: {
    execute(command) {
      if (command === commands.launch) return commandResult(`__REMOTE_JOB_STARTED__:${nonce}:4242\n`);
      if (command === commands.poll) {
        pollCount += 1;
        return pollCount === 1
          ? commandResult(`__REMOTE_JOB_RUNNING__:${nonce}:4242\n`)
          : commandResult(`__REMOTE_JOB_COMPLETE__:${nonce}:0\n`);
      }
      if (command === commands.fetchResult) {
        fetchCount += 1;
        return commandResult(validResult);
      }
      throw new Error(`unexpected_fixture_command:${command}`);
    },
    wait() { /* bounded fixture poll */ },
  },
});
assert.equal(success.pid, 4242);
assert.equal(success.resumed, false);
assert.equal(success.terminalSentinelCount, 1);
assert.equal(success.result.output_size_bytes, 4096);
assert.equal(fetchCount, 1, "result JSON is fetched and parsed once");

let stderrFetches = 0;
assert.throws(() => executeDetachedRemoteWorkflowContract({
  commands,
  kind: "video",
  timeoutSeconds: 30,
  operations: {
    execute(command) {
      if (command === commands.launch) return commandResult(`__REMOTE_JOB_STARTED__:${nonce}:4242\n`);
      if (command === commands.poll) return commandResult(`__REMOTE_JOB_COMPLETE__:${nonce}:17\n`, 17);
      if (command === commands.fetchStderr) { stderrFetches += 1; return commandResult("fixture remote failure"); }
      throw new Error("nonzero_fixture_unexpected_command");
    },
  },
}), /exit_17:fixture remote failure/);
assert.equal(stderrFetches, 1);

assert.throws(() => executeDetachedRemoteWorkflowContract({
  commands,
  kind: "video",
  timeoutSeconds: 30,
  operations: {
    execute(command) {
      if (command === commands.launch) return commandResult(`__REMOTE_JOB_STARTED__:${nonce}:4242\n`);
      return commandResult("");
    },
  },
}), /empty_status_response/);

let fixtureNow = 0;
assert.throws(() => executeDetachedRemoteWorkflowContract({
  commands,
  kind: "video",
  timeoutSeconds: 1,
  operations: {
    execute(command) {
      if (command === commands.launch) return commandResult(`__REMOTE_JOB_STARTED__:${nonce}:4242\n`);
      return commandResult(`__REMOTE_JOB_RUNNING__:${nonce}:4242\n`);
    },
    now: () => fixtureNow,
    wait: (ms) => { fixtureNow += ms; },
  },
}), /detached_result_timeout/);

let transientReads = 0;
const transientRecovery = executeDetachedRemoteWorkflowContract({
  commands,
  kind: "video",
  timeoutSeconds: 30,
  operations: {
    execute(command) {
      if (command === commands.launch) return commandResult(`__REMOTE_JOB_STARTED__:${nonce}:4242\n`);
      if (command === commands.poll) return commandResult(`__REMOTE_JOB_COMPLETE__:${nonce}:0\n`);
      if (command === commands.fetchResult) {
        transientReads += 1;
        return transientReads === 1 ? commandResult("", 255, "local channel interrupted") : commandResult(validResult);
      }
      throw new Error("transient_recovery_fixture_unexpected_command");
    },
    wait() { /* bounded result retry */ },
  },
});
assert.equal(transientRecovery.result.output_sha256, "a".repeat(64));
assert.equal(transientReads, 2);

let launches = 0;
let workerSubmissions = 0;
let resultReads = 0;
const interruptedOperations: DetachedRemoteWorkflowOperations = {
  execute(command) {
    if (command === commands.launch) {
      launches += 1;
      if (launches === 1) workerSubmissions += 1;
      return commandResult(launches === 1 ? `__REMOTE_JOB_STARTED__:${nonce}:4242\n` : `__REMOTE_JOB_RESUMED__:${nonce}:4242\n`);
    }
    if (command === commands.poll) return commandResult(`__REMOTE_JOB_COMPLETE__:${nonce}:0\n`);
    if (command === commands.fetchResult) {
      resultReads += 1;
      return resultReads <= 3 ? commandResult("", 255, "local channel interrupted") : commandResult(validResult);
    }
    throw new Error("recovery_fixture_unexpected_command");
  },
  wait() { /* bounded result retry */ },
};
assert.throws(() => executeDetachedRemoteWorkflowContract({ commands, kind: "video", timeoutSeconds: 30, operations: interruptedOperations }), /result_fetch_failed/);
const recovered = executeDetachedRemoteWorkflowContract({ commands, kind: "video", timeoutSeconds: 30, operations: interruptedOperations });
assert.equal(recovered.resumed, true);
assert.equal(recovered.result.output_sha256, "a".repeat(64));
assert.equal(launches, 2);
assert.equal(workerSubmissions, 1, "recovery resumes the durable job instead of submitting inference twice");
assert.equal(resultReads, 4);

const coordinator = readFileSync(path.join(process.cwd(), "src", "lib", "long-video", "execution.ts"), "utf8");
const adapter = readFileSync(path.join(process.cwd(), "src", "lib", "long-video", "clore-adapter.ts"), "utf8");
const sshCommon = readFileSync(path.join(process.cwd(), "scripts", "gpu-providers", "common.ts"), "utf8");
assert.match(coordinator, /recoverableAttempt[\s\S]*candidate\.status === "running"/);
assert.match(coordinator, /recoverableAttempt\?\.id \?\? attempt\.segments\[index\]\.attempts/);
assert.match(coordinator, /if \(segment\.status === "accepted"\) continue/);
assert.match(coordinator, /for \(let index = current\.nextSegmentIndex/);
assert.match(coordinator, /resume_segment_boundary_mismatch/);
assert.match(adapter, /executionId: input\.attemptId/);
assert.match(sshCommon, /IdentitiesOnly=yes/);
assert.match(sshCommon, /UserKnownHostsFile=/);
assert.doesNotMatch(commands.launch, /known_hosts|IdentityAgent|ssh-agent/i);
assert.notEqual(commands.stop, commands.cleanup, "stop and cleanup stay separate bounded SSH commands");

console.log("Stage 4J.4 runner channel and recovery fixture tests passed.");
