import assert from "node:assert/strict";
import { CloreApiError, CloreRateLimitError, classifyCloreFailure } from "./client";
import { MAX_CANDIDATE_CREATE_ATTEMPTS, NO_COMPLIANT_RTX4090_CANDIDATE_MESSAGE, isCandidateAlreadyRented } from "./image-live-runtime";
import { resilientCreateOrder } from "./resilient-create";

const rented = () => new CloreApiError({ httpStatus: 200, code: 6, error: "server-already-rented", message: "server-already-rented", details: null, field: null, requestId: "fixture", classification: "candidate_already_rented" });

async function main() {
  assert.equal(classifyCloreFailure({ httpStatus: 200, code: 6, error: "server-already-rented" }), "candidate_already_rented");
  assert.equal(isCandidateAlreadyRented(rented()), true);
  assert.doesNotMatch(JSON.stringify(rented().failure), /unknown_code6/);

  let clock = 0; let inFlight = 0; let maximumInFlight = 0; let reconciles = 0;
  const logicalAttemptId = "one-durable-attempt"; const selected: string[] = []; const creates: string[] = [];
  const result = await resilientCreateOrder<{ id: string }, { logicalAttemptId: string }>({
    maximumCreateRequests: MAX_CANDIDATE_CREATE_ATTEMPTS,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    activeOrderCount: async () => 0,
    selectFreshCandidate: async (attempted) => {
      const candidate = ["candidate-a", "candidate-b"].find((id) => !attempted.has(id)) ?? null;
      if (candidate) selected.push(candidate);
      return candidate ? { id: candidate } : null;
    },
    create: async (candidate) => {
      creates.push(candidate.id); inFlight += 1; maximumInFlight = Math.max(maximumInFlight, inFlight);
      try { if (candidate.id === "candidate-a") throw rented(); return { orderId: "2002", value: { logicalAttemptId } }; }
      finally { inFlight -= 1; }
    },
    reconcile: async () => { reconciles += 1; return null; },
    shouldRetryOnNextCandidate: isCandidateAlreadyRented,
  });
  assert.deepEqual(selected, ["candidate-a", "candidate-b"]); assert.deepEqual(creates, selected); assert.equal(new Set(creates).size, creates.length);
  assert.equal(result.order.value.logicalAttemptId, logicalAttemptId); assert.equal(maximumInFlight, 1); assert.equal(reconciles, 1);

  let exhausted: unknown = null; let exhaustedClock = 0;
  try {
    await resilientCreateOrder<{ id: string }, null>({
      maximumCreateRequests: MAX_CANDIDATE_CREATE_ATTEMPTS, now: () => exhaustedClock, sleep: async (ms) => { exhaustedClock += ms; }, activeOrderCount: async () => 0,
      selectFreshCandidate: async (attempted) => { const id = Array.from({ length: MAX_CANDIDATE_CREATE_ATTEMPTS }, (_, index) => `candidate-${index + 1}`).find((id) => !attempted.has(id)); return id ? { id } : null; },
      create: async () => { throw rented(); }, reconcile: async () => null, shouldRetryOnNextCandidate: isCandidateAlreadyRented,
    });
  } catch (error) { exhausted = error; }
  assert.equal((exhausted as { resilientAttempts?: unknown[] }).resilientAttempts?.length, MAX_CANDIDATE_CREATE_ATTEMPTS);

  await assert.rejects(() => resilientCreateOrder<{ id: string }, null>({ maximumCreateRequests: MAX_CANDIDATE_CREATE_ATTEMPTS, activeOrderCount: async () => 0, selectFreshCandidate: async () => null, create: async () => ({ orderId: "never", value: null }), reconcile: async () => null, noFreshCandidateError: () => new Error(NO_COMPLIANT_RTX4090_CANDIDATE_MESSAGE) }), new RegExp(NO_COMPLIANT_RTX4090_CANDIDATE_MESSAGE));

  let rateLimitCreates = 0; let rateLimitReconciles = 0;
  await assert.rejects(() => resilientCreateOrder<{ id: string }, null>({ maximumCreateRequests: MAX_CANDIDATE_CREATE_ATTEMPTS, activeOrderCount: async () => 0, selectFreshCandidate: async () => ({ id: "candidate-a" }), create: async () => { rateLimitCreates += 1; throw new CloreRateLimitError({ httpStatus: 429, code: 5, message: null, retryAfterMs: null, attempt: 1 }); }, reconcile: async () => { rateLimitReconciles += 1; return null; }, shouldRetryOnNextCandidate: isCandidateAlreadyRented }), /clore_rate_limit/);
  assert.equal(rateLimitCreates, 1); assert.equal(rateLimitReconciles, 1);
  console.log(JSON.stringify({ ok: true, code6CandidateRace: true, sameLogicalAttempt: true, maxUniqueCandidates: MAX_CANDIDATE_CREATE_ATTEMPTS, noConcurrentCreate: true, rateLimitDidNotSwitchCandidate: true, providerMutationCount: 0 }));
}

void main();
