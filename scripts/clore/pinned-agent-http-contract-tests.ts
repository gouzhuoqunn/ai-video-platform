import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { AgentStageAcceptanceError, agentPostJson, waitForStage } from "./run-image-e2e";
import { assertRtx4090GoldenDeploymentProfile, buildRtx4090GoldenBootstrap, RTX4090_GOLDEN_CONTROLLER_SOURCE_PATCHES, RTX4090_GOLDEN_WORKFLOW_SOURCE_PATCHES } from "../image-executor/rtx4090-golden-deployment-profile";

const token = "local-pinned-agent-contract-token";
const tokenSha256 = createHash("sha256").update(token).digest("hex");
const agentPath = path.join(process.cwd(), "scripts", "clore", "diagnostic-agent.py");

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function start(root: string, port: number, immutable: ReturnType<typeof assertRtx4090GoldenDeploymentProfile>["immutable"]) {
  const controllerPatch = deflateRawSync(Buffer.from(JSON.stringify(RTX4090_GOLDEN_CONTROLLER_SOURCE_PATCHES), "utf8")).toString("base64");
  const workflowPatch = deflateRawSync(Buffer.from(JSON.stringify(RTX4090_GOLDEN_WORKFLOW_SOURCE_PATCHES), "utf8")).toString("base64");
  const agentArgs = [
    agentPath,
    "--token-sha256", tokenSha256,
    "--immutable", `${immutable.commit}:${immutable.controllerSha256}:${immutable.workflowSha256}`,
    "--controller-source-sha256", immutable.controllerSourceSha256,
    "--controller-patch", controllerPatch,
    "--workflow-source-sha256", immutable.workflowSourceSha256,
    "--workflow-patch", workflowPatch,
    "--port", String(port),
  ];
  const executable = process.platform === "win32" ? (process.env.ComSpec ?? process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe") : "python3";
  const args = process.platform === "win32" ? ["/d", "/c", "py", "-3", ...agentArgs] : agentArgs;
  const child = spawn(executable, args, { cwd: process.cwd(), env: { ...process.env, DIAG_ROOT: root, DIAG_TEST_STAGE_DELAY_SECONDS: "5" }, stdio: "ignore", windowsHide: true });
  let spawnError: Error | null = null; child.once("error", (error) => { spawnError = error; });
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    if (spawnError) { await stop(child); throw spawnError; }
    const health = await fetch(`${endpoint}/healthz`).catch(() => null);
    if (health?.ok) return { child, endpoint };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stop(child); throw new Error("pinned_agent_local_start_timeout");
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill();
  await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  const profile = assertRtx4090GoldenDeploymentProfile();
  assert.equal(createHash("sha256").update(readFileSync(agentPath)).digest("hex"), profile.immutable.agentSha256);
  assert.equal(profile.agentContract, "stage-acceptance-v2");
  assert.equal(createHash("sha256").update(buildRtx4090GoldenBootstrap("0".repeat(64))).digest("hex"), profile.bootstrapTemplateSha256);
  const root = mkdtempSync(path.join(process.cwd(), ".pinned-agent-contract-"));
  try {
    const receiptPath = path.join(root, "caller-receipt.json"); const runId = randomUUID(); const port = await freePort(); const local = await start(root, port, profile.immutable);
    try {
      const evidence: unknown[] = [];
      const accepted = await agentPostJson(local.endpoint, token, "/stage/environment", undefined, { stageRunId: runId, onRequested: (requested) => writeFileSync(receiptPath, JSON.stringify({ requestedStageRunId: requested }), "utf8"), onEvidence: (value) => evidence.push(value) });
      assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).requestedStageRunId, runId);
      assert.equal(accepted.stage, "environment"); assert.equal(accepted.stageRunId, runId);
      const responseEvidence = evidence.at(-1) as { httpStatus: number; contentType: string | null; acceptanceClassification: string; returnedStage: string | null; returnedStageRunId: string | null; body: unknown };
      assert.equal(responseEvidence.httpStatus, 202); assert.match(String(responseEvidence.contentType), /application\/json/i); assert.equal(responseEvidence.acceptanceClassification, "accepted"); assert.equal(responseEvidence.returnedStage, "environment"); assert.equal(responseEvidence.returnedStageRunId, runId);
      let correlated = false;
      await assert.rejects(() => waitForStage({ endpoint: local.endpoint, token, stage: "environment", expectedStageRunId: runId, timeoutMs: 30_000, fetchImpl: async (input, init) => { const response = await fetch(input, init); if (String(input).includes("/status")) { const status = await response.clone().json() as { stages?: Record<string, { stage_run_id?: string }> }; correlated = status.stages?.environment?.stage_run_id === runId; } return response; }, sleepImpl: async () => { throw new Error("local_test_status_captured"); } }), /local_test_status_captured/);
      assert.equal(correlated, true);
    } finally { await stop(local.child); }

    const mismatchRoot = path.join(root, "mismatch"); const mismatchId = randomUUID(); const wireId = randomUUID(); const mismatch = await start(mismatchRoot, await freePort(), profile.immutable);
    try {
      await assert.rejects(() => agentPostJson(mismatch.endpoint, token, "/stage/environment", undefined, { stageRunId: mismatchId, fetchImpl: async (input, init) => { const payload = JSON.parse(String(init?.body)) as { stage_run_id: string }; payload.stage_run_id = wireId; return await fetch(String(input), { ...init, body: JSON.stringify(payload) }); } }), (error: unknown) => error instanceof AgentStageAcceptanceError && error.evidence.returnedStageRunId === wireId && error.evidence.requestedStageRunId === mismatchId && error.evidence.acceptanceClassification === "wrong_schema");
    } finally { await stop(mismatch.child); }
    console.log(JSON.stringify({ ok: true, agentSha256: profile.immutable.agentSha256, bootstrapTemplateSha256: profile.bootstrapTemplateSha256, postStatus: 202, returnedStage: "environment", statusPollCorrelated: true, mismatchedStageRunIdRejected: true, providerMutationCount: 0 }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
void main();
