import assert from "node:assert/strict";
import { AgentStageAcceptanceError, agentPostJson, assertCallerAgentStageAcceptanceContract, sanitizeAgentStageAcceptanceEvidence } from "./run-image-e2e";

const runId = "11111111-1111-4111-8111-111111111111";
const response = (status: number, body: string, contentType = "application/json") => new Response(body, { status, headers: { "content-type": contentType } });

async function rejects(input: Response, expected: "html" | "wrong_schema" | "invalid_json") {
  await assert.rejects(() => agentPostJson("https://agent.invalid", "token", "/stage/environment", undefined, { stageRunId: runId, fetchImpl: async () => input }), (error: unknown) => error instanceof AgentStageAcceptanceError && error.evidence.responseKind === expected);
}

async function main() {
  let requested = ""; const evidence = [] as ReturnType<typeof sanitizeAgentStageAcceptanceEvidence>[];
  const accepted = await agentPostJson("https://agent.invalid", "token", "/stage/environment", undefined, { stageRunId: runId, onRequested: (value) => { requested = value; }, onEvidence: (value) => evidence.push(value), fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.stage_run_id, runId);
    return response(202, JSON.stringify({ accepted: true, state: "accepted", status: "running", stage: "environment", stage_run_id: runId }));
  } });
  assert.equal(requested, runId); assert.equal(accepted.stageRunId, runId);
  assert.equal(evidence.length, 2); assert.equal(evidence[0]?.acceptanceClassification, "response_received"); assert.equal(evidence[0]?.body, null);
  const acceptedEvidence = evidence.at(-1);
  assert.equal(acceptedEvidence?.acceptanceClassification, "accepted"); assert.ok((acceptedEvidence?.responseByteLength ?? 0) > 0); assert.match(String(acceptedEvidence?.bodySha256), /^[a-f0-9]{64}$/); assert.equal(acceptedEvidence?.returnedStageRunId, runId);
  await rejects(response(202, JSON.stringify({ accepted: true, state: "accepted", stage: "environment" })), "wrong_schema");
  await rejects(response(202, JSON.stringify({ accepted: true, state: "accepted", status: "running", stage: "environment", stage_run_id: "22222222-2222-4222-8222-222222222222" })), "wrong_schema");
  await rejects(response(200, "<html>proxy</html>", "text/html"), "html");
  await rejects(response(202, "not-json"), "invalid_json");
  await assert.rejects(() => agentPostJson("https://agent.invalid", "token", "/stage/environment", undefined, { stageRunId: runId, fetchImpl: async () => response(202, JSON.stringify({ accepted: true, stage: "environment", stage_run_id: runId, secret: "must-not-persist" })) }), (error: unknown) => {
    const evidence = sanitizeAgentStageAcceptanceEvidence(error);
    return evidence?.responseKind === "wrong_schema" && JSON.stringify(evidence).includes("must-not-persist") === false;
  });
  assert.deepEqual(assertCallerAgentStageAcceptanceContract({ agentContract: "stage-acceptance-v2", acceptedStageResponseFields: ["accepted", "state", "status", "stage", "stage_run_id"] }), { callerContract: "stage-acceptance-v2", requiredResponseFields: ["accepted", "state", "status", "stage", "stage_run_id"] });
  assert.throws(() => assertCallerAgentStageAcceptanceContract({ agentContract: "v1", acceptedStageResponseFields: [] }), /contract_mismatch/);
  console.log(JSON.stringify({ ok: true, callerOwnedStageRunId: true, matchingIdRequired: true, htmlProxyRejected: true, providerMutationCount: 0 }));
}
void main();
