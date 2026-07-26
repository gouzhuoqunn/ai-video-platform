import assert from "node:assert/strict";
import { classifyCloreFailure, CloreApiError, CloreRequestScheduler, isRetryableCloreCreateError, type CloreFailureClassification } from "./client";
import { resilientCreateOrder } from "./resilient-create";
import type { CloreConfig } from "./types";

type Candidate = { id: string };

function providerError(classification: CloreFailureClassification, input: { status?: number; code?: number; error?: unknown; message?: string } = {}) {
  return new CloreApiError({
    httpStatus: input.status ?? 500,
    code: input.code ?? 6,
    error: input.error ?? classification,
    message: input.message ?? classification,
    details: null,
    field: null,
    requestId: "fixture-request",
    classification,
  });
}

async function scenario(input: {
  failures: CloreApiError[];
  reconcileAt?: number;
  activeInitially?: number;
  maximum?: 3;
}) {
  let clock = 0;
  let createCalls = 0;
  let active = input.activeInitially ?? 0;
  const starts: number[] = [];
  const selected: string[] = [];
  const candidates = [{ id: "101" }, { id: "102" }, { id: "103" }];
  const result = await resilientCreateOrder<Candidate, { candidateId: string }>({
    maximumCreateRequests: input.maximum ?? 3,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    activeOrderCount: async () => active,
    selectFreshCandidate: async (attempted) => {
      const candidate = candidates.find((item) => !attempted.has(item.id)) ?? null;
      if (candidate) selected.push(candidate.id);
      return candidate;
    },
    create: async (candidate) => {
      starts.push(clock);
      createCalls += 1;
      const failure = input.failures[createCalls - 1];
      if (failure) throw failure;
      active = 1;
      return { orderId: `9${createCalls}`, value: { candidateId: candidate.id } };
    },
    reconcile: async (candidate) => {
      if (input.reconcileAt === createCalls) {
        active = 1;
        return { orderId: "988", value: { candidateId: candidate.id } };
      }
      return null;
    },
  });
  return { result, createCalls, starts, selected };
}

async function main() {
const code6NoOrder = await scenario({ failures: [providerError("candidate_already_rented")] });
assert.equal(code6NoOrder.createCalls, 2);
assert.deepEqual(code6NoOrder.selected, ["101", "102"]);
assert.equal(code6NoOrder.result.createRequestCount, 2);
assert.equal(code6NoOrder.result.successfulOrderCount, 1);

const code6Reconciled = await scenario({ failures: [providerError("candidate_already_rented")], reconcileAt: 1 });
assert.equal(code6Reconciled.createCalls, 1);
assert.equal(code6Reconciled.result.order.reconciled, true);
assert.equal(code6Reconciled.result.successfulOrderCount, 1);

const unavailable = await scenario({ failures: [providerError("candidate_unavailable")] });
assert.equal(unavailable.createCalls, 2);
assert.deepEqual(unavailable.selected, ["101", "102"]);

const priceChanged = await scenario({ failures: [providerError("required_price_changed")] });
assert.equal(priceChanged.createCalls, 2);

let invalidCalls = 0;
await assert.rejects(() => resilientCreateOrder<Candidate, unknown>({
  maximumCreateRequests: 3,
  activeOrderCount: async () => 0,
  selectFreshCandidate: async () => ({ id: String(++invalidCalls) }),
  create: async () => { throw providerError("invalid_field", { status: 400 }); },
  reconcile: async () => null,
}), /Clore API failed/);
assert.equal(invalidCalls, 1);

let exhausted: unknown = null;
try {
  await scenario({ failures: [providerError("provider_internal_error"), providerError("provider_application_error"), providerError("candidate_already_rented")] });
} catch (error) {
  exhausted = error;
}
assert.ok(exhausted instanceof Error);
assert.equal(((exhausted as Error & { resilientAttempts?: unknown[] }).resilientAttempts ?? []).length, 3);

const immediate = await scenario({ failures: [] });
assert.equal(immediate.createCalls, 1);
assert.equal(immediate.result.activeOrderCount, 1);
assert.equal(immediate.result.successfulOrderCount, 1);

await assert.rejects(() => resilientCreateOrder<Candidate, unknown>({
  maximumCreateRequests: 3,
  activeOrderCount: async () => 1,
  selectFreshCandidate: async () => ({ id: "never" }),
  create: async () => ({ orderId: "never", value: null }),
  reconcile: async () => null,
}), /active_order_exists/);

assert.ok(code6NoOrder.starts[1] - code6NoOrder.starts[0] >= 6000);
assert.equal(new Set(code6NoOrder.selected).size, code6NoOrder.selected.length);

const logs: Record<string, unknown>[] = [];
const scheduler = new CloreRequestScheduler({
  fetch: async () => new Response(JSON.stringify({
    code: 6,
    error: "candidate 110929 is unavailable; application could not create order",
    message: "complete fixture error",
    details: { field: "required_price", password: "must-not-appear", note: "price changed" },
    request_id: "provider-request-123",
  }), { status: 500, headers: { "content-type": "application/json", "x-request-id": "header-request-456" } }),
  sleep: async () => undefined,
  jitter: () => 0,
  log: (event) => logs.push(event),
});
const config = { apiKey: "fixture-api-token", apiBaseUrl: "https://fixture.invalid" } as CloreConfig;
let captured: CloreApiError | null = null;
try { await scheduler.request(config, "/create_order", { method: "POST" }); } catch (error) { captured = error as CloreApiError; }
assert.ok(captured instanceof CloreApiError);
assert.equal(captured.failure.httpStatus, 500);
assert.equal(captured.failure.code, 6);
assert.equal(captured.failure.error, "candidate 110929 is unavailable; application could not create order");
assert.equal(captured.failure.message, "complete fixture error");
assert.equal(captured.failure.requestId, "header-request-456");
assert.equal(captured.failure.classification, "candidate_unavailable");
assert.equal((captured.failure.details as { password: string }).password, "<redacted>");
const serialized = JSON.stringify({ error: captured.message, logs });
assert.doesNotMatch(serialized, /must-not-appear|fixture-api-token/);
assert.match(serialized, /candidate 110929 is unavailable/);

const currencyRejected = providerError("invalid_field", {
  status: 500, code: 6, error: "currency-not-allowed", message: "currency-not-allowed",
});
assert.equal(classifyCloreFailure({ httpStatus: 500, code: 6, error: "currency-not-allowed" }), "invalid_field");
assert.equal(currencyRejected.failure.classification, "invalid_field");
assert.equal(isRetryableCloreCreateError(currencyRejected), false);

console.log(JSON.stringify({
  resilient_create_tests_passed: true,
  code6_without_order_retried: true,
  code6_with_reconciled_order_stopped: true,
  candidate_unavailable_retried: true,
  required_price_changed_retried: true,
  invalid_field_stopped: true,
  requested_three_attempt_cap_enforced: true,
  successful_order_cap: 1,
  active_order_cap: 1,
  minimum_create_spacing_ms: 6000,
  attempted_candidates_excluded: true,
  full_sanitized_error_preserved: true,
  currency_not_allowed_stops_immediately: true,
  secrets_redacted: true,
}));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
