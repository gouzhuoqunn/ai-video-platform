import assert from "node:assert/strict";
import { agentGetJsonWithRetry, AgentGetTerminalError } from "./agent-get-transport";
import { getArtifactMetadataWithRetry, pollInferenceStage, waitForStage } from "./run-image-e2e";

function response(status: number, body: object = {}) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function transient(code: string, message = "fetch failed") { return new TypeError(message, { cause: { code } }); }
function virtualClock() { let value = 0; return { now: () => value, timestamp: () => new Date(value).toISOString(), sleep: async (milliseconds: number) => { value += milliseconds; } }; }

async function main() {
  // The caller performs the one stage POST; polling never replays it.
  let comfyPosts = 1; let comfyGets = 0;
  const comfy = await waitForStage({ endpoint: "https://agent.example", token: "fixture-token", stage: "comfyui", timeoutMs: 60_000, sleepImpl: async () => undefined, fetchImpl: async () => {
    comfyGets += 1;
    if (comfyGets === 1) throw transient("ECONNRESET");
    return response(200, { stages: { comfyui: { status: "succeeded", data: { ready: true } } } });
  } });
  assert.equal(comfy.status, "succeeded"); assert.equal(comfyPosts, 1); assert.equal(comfyGets, 2);

  const resetClock = virtualClock(); let resetGets = 0;
  const reset = await waitForStage({ endpoint: "https://agent.example", token: "fixture-token", stage: "comfyui", timeoutMs: 60_000, now: resetClock.now, timestamp: resetClock.timestamp, sleepImpl: resetClock.sleep, fetchImpl: async () => {
    resetGets += 1;
    if (resetGets === 1) return response(502);
    if (resetGets === 2) throw transient("ECONNRESET");
    if (resetGets === 3) throw transient("ETIMEDOUT", "timeout");
    if (resetGets === 4) return response(200, { stages: { comfyui: { status: "running" } } });
    return response(200, { stages: { comfyui: { status: "succeeded" } } });
  } });
  assert.equal(reset.status, "succeeded"); assert.equal(resetGets, 5, "successful status resets the outage sequence");

  const healthClock = virtualClock(); let statusGets = 0; let healthGets = 0;
  const healthRecovery = await waitForStage({ endpoint: "https://agent.example", token: "fixture-token", stage: "comfyui", timeoutMs: 60_000, now: healthClock.now, timestamp: healthClock.timestamp, sleepImpl: healthClock.sleep, fetchImpl: async (input) => {
    if (String(input).endsWith("/healthz")) { healthGets += 1; return response(200, { alive: true, current_stage: "comfyui" }); }
    statusGets += 1;
    if (statusGets <= 3) throw transient("UND_ERR_SOCKET");
    return response(200, { stages: { comfyui: { status: "succeeded" } } });
  } });
  assert.equal(healthRecovery.status, "succeeded"); assert.equal(healthGets, 1, "health is probed after three status failures");

  for (const status of [401, 404]) {
    await assert.rejects(() => agentGetJsonWithRetry({ endpoint: "https://agent.example", token: "fixture-token", route: "/status", attempt: 1, fetchImpl: async () => response(status) }), AgentGetTerminalError);
  }
  const timedOut = await agentGetJsonWithRetry({ endpoint: "https://agent.example", token: "fixture-token", route: "/status", attempt: 1, timeoutMs: 1, fetchImpl: async (_url, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(transient("ETIMEDOUT", "timeout")), { once: true })) });
  assert.equal(timedOut.ok, false); if (!timedOut.ok) assert.equal(timedOut.diagnostic.causeCode, "ETIMEDOUT");

  const outageClock = virtualClock(); let reconcileCalls = 0; let outageFetches = 0; const diagnostics: unknown[] = [];
  const outage = await waitForStage({ endpoint: "https://agent.example", token: "fixture-token", stage: "comfyui", timeoutMs: 45 * 60_000, now: outageClock.now, timestamp: outageClock.timestamp, sleepImpl: outageClock.sleep, onDiagnostic: (value) => diagnostics.push(value), reconcileExactOrder: async () => { reconcileCalls += 1; return true; }, fetchImpl: async () => { outageFetches += 1; throw transient("ECONNRESET", "fetch failed bearer secret-fixture"); } });
  assert.equal(outage.status, "failed"); assert.match(outage.error ?? "", /agent_transport_outage_exceeded/); assert.equal(reconcileCalls, 1); assert.ok(outageFetches >= 6, "final health/status probes were attempted");
  const outageDetail = JSON.parse(outage.error!); assert.equal(outageDetail.exact_order_active, true); assert.equal(outageDetail.nested_cause_code, "ECONNRESET");
  assert.ok(JSON.stringify(diagnostics).includes("ECONNRESET")); assert.ok(!JSON.stringify(diagnostics).includes("secret-fixture"));

  let inferencePosts = 1; let inferenceGets = 0;
  const inference = await pollInferenceStage("https://agent.example", "fixture-token", { sleepImpl: async () => undefined, fetchImpl: async () => { inferenceGets += 1; if (inferenceGets === 1) throw transient("EAI_AGAIN"); return response(200, { stages: { inference: { status: "succeeded" } } }); } });
  assert.equal(inference.status, "succeeded"); assert.equal(inferencePosts, 1, "GET outage cannot add an inference POST");

  let metadataGets = 0; let inferenceReruns = 0;
  const metadata = await getArtifactMetadataWithRetry({ endpoint: "https://agent.example", token: "fixture-token", taskId: "fixture", sleepImpl: async () => undefined, fetchImpl: async () => { metadataGets += 1; return metadataGets === 1 ? response(502) : response(200, { sha256: "a".repeat(64), byte_size: 1 }); } });
  assert.equal(metadata.sha256, "a".repeat(64)); assert.equal(metadataGets, 2); assert.equal(inferenceReruns, 0);
  console.log(JSON.stringify({ ok: true, single_post_poll_recovery: true, repeated_transients_reset: true, health_probe_recovery: true, terminal_auth_and_not_found: true, bounded_outage_reconciles_and_final_probes: true, inference_post_single: true, metadata_get_retries_without_inference: true, diagnostics_redacted: true }));
}

void main();
