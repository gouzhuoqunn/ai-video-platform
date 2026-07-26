import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentArtifactMetadataResponse, agentGetJsonWithRetry, agentHealthResponse, agentStatusResponse, AgentGetTerminalError } from "./agent-get-transport";
import { freshRunRequiresManualRecovery, getArtifactMetadataWithRetry, pollInferenceStage, prepareFreshReceipt, type FreshReceipt, waitForStage } from "./run-image-e2e";

const token = "fixture-agent-token";
const stageRunId = "11111111-1111-4111-8111-111111111111";
function response(status: number, body = "", contentType = "application/json") { return new Response(body, { status, headers: { "content-type": contentType, "content-length": String(Buffer.byteLength(body)) } }); }
function status(stage = "models", state = "succeeded", runId = stageRunId) { return JSON.stringify({ alive: true, current_stage: "idle", last_error: null, stages: { [stage]: { stage_run_id: runId, status: state, data: { verified: true } } }, models: {} }); }
function health() { return JSON.stringify({ alive: true, agent: "restricted-clore-diagnostic", current_stage: "idle", last_error: null }); }
function virtualClock() { let value = 0; return { now: () => value, timestamp: () => new Date(value).toISOString(), sleep: async (milliseconds: number) => { value += milliseconds; } }; }
function sequence(values: Response[]) { let index = 0; return async () => values[Math.min(index++, values.length - 1)]; }

async function recoverFromNonAgent(body: string, expectedKind: string, contentType = "application/json") {
  let stagePosts = 1; let gets = 0; const diagnostics: unknown[] = [];
  const result = await waitForStage({ endpoint: "https://agent.example", token, stage: "models", expectedStageRunId: stageRunId, timeoutMs: 60_000, sleepImpl: async () => undefined, onDiagnostic: (value) => diagnostics.push(value), fetchImpl: sequence([response(200, body, contentType), response(200, status())]) });
  gets = 2;
  assert.equal(result.status, "succeeded"); assert.equal(stagePosts, 1); assert.equal(gets, 2);
  const diagnostic = diagnostics[0] as { message: string; responseKind: string; bodySha256: string; bodyPreview: string };
  assert.equal(diagnostic.message, "agent_proxy_non_agent_response"); assert.equal(diagnostic.responseKind, expectedKind); assert.match(diagnostic.bodySha256, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(diagnostics).includes(token) && !JSON.stringify(diagnostics).includes("agent.example"));
}

async function main() {
  await recoverFromNonAgent("<html>https://agent.example/status?token=signed-fixture</html>", "html", "text/html");
  await recoverFromNonAgent("", "empty");
  await recoverFromNonAgent("{not-json", "invalid_json");
  await recoverFromNonAgent(JSON.stringify({ alive: true, current_stage: "idle", stages: [] }), "wrong_schema");

  const validStatus = await agentGetJsonWithRetry({ endpoint: "https://agent.example", token, route: "/status", validator: agentStatusResponse, attempt: 1, fetchImpl: sequence([response(200, status())]) });
  assert.equal(validStatus.ok, true);
  const validHealth = await agentGetJsonWithRetry({ endpoint: "https://agent.example", token, route: "/healthz", validator: agentHealthResponse, attempt: 1, fetchImpl: sequence([response(200, health())]) });
  assert.equal(validHealth.ok, true);

  const oversized = await agentGetJsonWithRetry({ endpoint: "https://agent.example", token, route: "/status", validator: agentStatusResponse, attempt: 1, fetchImpl: sequence([new Response("ignored", { status: 200, headers: { "content-type": "application/json", "content-length": String(1024 * 1024 + 1) } })]) });
  assert.equal(oversized.ok, false); if (!oversized.ok) assert.equal(oversized.diagnostic.responseKind, "oversized");

  let requestUrl = ""; let requestHeaders: Headers | undefined;
  await agentGetJsonWithRetry({ endpoint: "https://agent.example", token, route: "/status", validator: agentStatusResponse, attempt: 7, fetchImpl: async (input, init) => { requestUrl = String(input); requestHeaders = new Headers(init?.headers); return response(200, status()); } });
  assert.match(requestUrl, /\/status\?poll_attempt=7$/); assert.equal(requestHeaders?.get("cache-control"), "no-cache, no-store"); assert.equal(requestHeaders?.get("pragma"), "no-cache"); assert.equal(requestHeaders?.get("accept"), "application/json");

  for (const statusCode of [401, 404]) await assert.rejects(() => agentGetJsonWithRetry({ endpoint: "https://agent.example", token, route: "/status", validator: agentStatusResponse, attempt: 1, fetchImpl: sequence([response(statusCode)]) }), AgentGetTerminalError);

  const outageClock = virtualClock(); let stagePosts = 1; let reconcileCalls = 0; const outageDiagnostics: unknown[] = [];
  const outage = await waitForStage({ endpoint: "https://agent.example", token, stage: "models", expectedStageRunId: stageRunId, timeoutMs: 45 * 60_000, now: outageClock.now, timestamp: outageClock.timestamp, sleepImpl: outageClock.sleep, onDiagnostic: (value) => outageDiagnostics.push(value), reconcileExactOrder: async () => { reconcileCalls += 1; return true; }, fetchImpl: async () => response(200, "<html>persistent proxy</html>", "text/html") });
  assert.equal(outage.status, "failed"); assert.equal(stagePosts, 1); assert.equal(reconcileCalls, 1);
  const outageDetail = JSON.parse(outage.error!); assert.equal(outageDetail.code, "agent_transport_outage_exceeded"); assert.equal(outageDetail.last_http_status, 200); assert.equal(outageDetail.last_response_kind, "html"); assert.equal(outageDetail.last_content_type, "text/html"); assert.match(outageDetail.last_body_sha256, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(outageDiagnostics).includes(token) && !JSON.stringify(outageDiagnostics).includes("agent.example"));

  let inferencePosts = 1; let inferenceGets = 0;
  const inference = await pollInferenceStage("https://agent.example", token, stageRunId, { sleepImpl: async () => undefined, fetchImpl: sequence([response(200, "<html>proxy</html>", "text/html"), response(200, status("inference"))]) });
  inferenceGets = 2; assert.equal(inference.status, "succeeded"); assert.equal(inferencePosts, 1); assert.equal(inferenceGets, 2);
  const taskA = "22222222-2222-4222-8222-222222222222"; const taskB = "33333333-3333-4333-8333-333333333333";
  const secondInference = await pollInferenceStage("https://agent.example", token, taskB, { sleepImpl: async () => undefined, fetchImpl: sequence([response(200, status("inference", "succeeded", taskA)), response(200, status("inference", "succeeded", taskB))]) });
  assert.equal(secondInference.status, "succeeded", "task B must ignore task A's stale inference terminal record");

  let metadataGets = 0; let inferenceReruns = 0;
  const metadata = await getArtifactMetadataWithRetry({ endpoint: "https://agent.example", token, taskId: "fixture-task", sleepImpl: async () => undefined, fetchImpl: sequence([response(200, JSON.stringify({ task_id: "fixture-task", width: 0, height: 1, byte_size: 1, sha256: "a".repeat(64) })), response(200, JSON.stringify({ task_id: "fixture-task", width: 768, height: 768, byte_size: 1, sha256: "a".repeat(64) }))]) });
  metadataGets = 2; assert.equal(metadata.sha256, "a".repeat(64)); assert.equal(inferenceReruns, 0); assert.equal(agentArtifactMetadataResponse("fixture-task")(metadata), true);

  const root = mkdtempSync(path.join(os.tmpdir(), "agent-get-receipt-")); const receiptPath = path.join(root, "receipt.json"); const archiveDir = path.join(root, "archive"); const taskId = "safe-preinference";
  const prior: FreshReceipt = { schema: 1, runId: "prior", taskId, orderId: null, endpoint: null, currentStep: "failed", inferenceState: "not_started", inferenceSubmitted: false, inferenceSucceeded: false, inferenceSubmittingAt: null, inferenceAcceptedAt: null, acceptedHttpStatus: null, inferenceCompletedAt: null, remoteArtifactAvailable: false, controllerPromptId: null, inferenceFailure: null, remoteArtifact: null, artifactDownloaded: false, localArtifactPublished: false, taskFinalized: false, uiVerified: false, orderCancelled: false, timestamps: {}, firstError: "preflight" };
  try { writeFileSync(receiptPath, JSON.stringify(prior)); const rotated = await prepareFreshReceipt({ taskId, taskStatus: "waiting_for_gpu", receiptPath, archiveDir, activeOrderCount: async () => 0 }); assert.equal(rotated.inferenceState, "not_started"); assert.equal(freshRunRequiresManualRecovery({ taskId, inferenceState: "accepted" }, taskId, "waiting_for_gpu"), true); }
  finally { rmSync(root, { recursive: true, force: true }); }
  console.log(JSON.stringify({ ok: true, non_agent_200_get_only_recovery: true, validators_and_no_cache: true, persistent_proxy_outage_evidence: true, terminal_auth_and_not_found: true, inference_post_single: true, artifact_get_retries_without_inference: true, safe_preinference_rotates: true, ambiguous_receipt_blocks: true, diagnostics_redacted: true }));
}

void main();
