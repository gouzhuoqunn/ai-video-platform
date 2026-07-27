import assert from "node:assert/strict";
import { AgentStageAcceptanceError, agentPostJson, sanitizeAgentStageAcceptanceEvidence } from "./run-image-e2e";

const runId = "11111111-1111-4111-8111-111111111111";
const response = (status: number, body: string, contentType = "application/json") => new Response(body, { status, headers: { "content-type": contentType } });

async function rejects(input: Response, expected: "html" | "wrong_schema" | "invalid_json") {
  await assert.rejects(() => agentPostJson("https://agent.invalid", "token", "/stage/environment", undefined, { stageRunId: runId, fetchImpl: async () => input }), (error: unknown) => error instanceof AgentStageAcceptanceError && error.evidence.responseKind === expected);
}

async function main() {
  let requested = "";
  const accepted = await agentPostJson("https://agent.invalid", "token", "/stage/environment", undefined, { stageRunId: runId, onRequested: (value) => { requested = value; }, fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.stage_run_id, runId);
    return response(202, JSON.stringify({ accepted: true, state: "accepted", status: "running", stage: "environment", stage_run_id: runId }));
  } });
  assert.equal(requested, runId); assert.equal(accepted.stageRunId, runId);
  await rejects(response(202, JSON.stringify({ accepted: true, state: "accepted", stage: "environment" })), "wrong_schema");
  await rejects(response(202, JSON.stringify({ accepted: true, state: "accepted", status: "running", stage: "environment", stage_run_id: "22222222-2222-4222-8222-222222222222" })), "wrong_schema");
  await rejects(response(200, "<html>proxy</html>", "text/html"), "html");
  await rejects(response(202, "not-json"), "invalid_json");
  await assert.rejects(() => agentPostJson("https://agent.invalid", "token", "/stage/environment", undefined, { stageRunId: runId, fetchImpl: async () => response(202, JSON.stringify({ accepted: true, stage: "environment", stage_run_id: runId, secret: "must-not-persist" })) }), (error: unknown) => {
    const evidence = sanitizeAgentStageAcceptanceEvidence(error);
    return evidence?.responseKind === "wrong_schema" && JSON.stringify(evidence).includes("must-not-persist") === false;
  });
  console.log(JSON.stringify({ ok: true, callerOwnedStageRunId: true, matchingIdRequired: true, htmlProxyRejected: true, providerMutationCount: 0 }));
}
void main();
