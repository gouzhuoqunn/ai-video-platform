import { CloreApiError, isRetryableCloreCreateError, type SanitizedCloreFailure } from "./client";

export type ResilientCreateCandidate = { id: string };
export type ResilientCreatedOrder = { orderId: string; value: unknown; reconciled: boolean };
export type ResilientCreateAttempt = {
  requestNumber: number;
  candidateId: string;
  startedAt: string;
  completedAt: string;
  result: "failed_request" | "successful_order" | "reconciled_order";
  failure: SanitizedCloreFailure | { message: string; classification: "non_provider_error" } | null;
};

export type ResilientCreateResult = {
  order: ResilientCreatedOrder;
  createRequestCount: number;
  successfulOrderCount: 1;
  activeOrderCount: 1;
  attemptedCandidateIds: string[];
  attempts: ResilientCreateAttempt[];
};

export type ResilientCreateOptions<Candidate extends ResilientCreateCandidate, Value> = {
  maximumCreateRequests: number;
  minimumCreateSpacingMs?: number;
  backoffMs?: readonly [number, number];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  selectFreshCandidate(attemptedCandidateIds: ReadonlySet<string>): Promise<Candidate | null>;
  create(candidate: Candidate): Promise<{ orderId: string | null; value: Value }>;
  reconcile(candidate: Candidate, requestStartedAt: Date): Promise<{ orderId: string; value: Value } | null>;
  activeOrderCount(): Promise<number>;
  /** Only deterministic candidate conflicts may advance to a different host. */
  shouldRetryOnNextCandidate?(error: unknown): boolean;
  noFreshCandidateError?(): Error;
  onAttempt?(attempt: ResilientCreateAttempt): Promise<void> | void;
};

function safeFailure(error: unknown): ResilientCreateAttempt["failure"] {
  if (error instanceof CloreApiError) return error.failure;
  return {
    message: String(error instanceof Error ? error.message : error).replace(/ssh-(?:ed25519|rsa)\s+\S+/g, "<redacted-ssh-key>").slice(0, 4000),
    classification: "non_provider_error",
  };
}

export async function resilientCreateOrder<Candidate extends ResilientCreateCandidate, Value>(
  options: ResilientCreateOptions<Candidate, Value>,
): Promise<ResilientCreateResult> {
  if (!Number.isInteger(options.maximumCreateRequests) || options.maximumCreateRequests < 1 || options.maximumCreateRequests > 5) {
    throw new Error("resilient_create_request_limit_invalid");
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const spacing = options.minimumCreateSpacingMs ?? 6000;
  const backoffs = options.backoffMs ?? [8000, 15000] as const;
  const attempted = new Set<string>();
  const attempts: ResilientCreateAttempt[] = [];
  let lastRequestAt = Number.NEGATIVE_INFINITY;

  for (let requestNumber = 1; requestNumber <= options.maximumCreateRequests; requestNumber += 1) {
    if (await options.activeOrderCount() > 0) throw new Error("resilient_create_active_order_exists");
    const candidate = await options.selectFreshCandidate(attempted);
    if (!candidate) throw options.noFreshCandidateError?.() ?? new Error("resilient_create_no_fresh_candidate");
    if (attempted.has(candidate.id)) throw new Error("resilient_create_candidate_reused");
    attempted.add(candidate.id);
    const spacingWait = Math.max(0, lastRequestAt + spacing - now());
    if (spacingWait > 0) await sleep(spacingWait);
    const requestStartedMs = now();
    const requestStartedAt = new Date(requestStartedMs);
    lastRequestAt = requestStartedMs;
    try {
      const created = await options.create(candidate);
      const reconciled = created.orderId ? null : await options.reconcile(candidate, requestStartedAt);
      const resolved = created.orderId ? { orderId: created.orderId, value: created.value } : reconciled;
      if (!resolved?.orderId) throw new Error("resilient_create_order_id_missing");
      const attempt: ResilientCreateAttempt = {
        requestNumber, candidateId: candidate.id, startedAt: requestStartedAt.toISOString(),
        completedAt: new Date(now()).toISOString(), result: created.orderId ? "successful_order" : "reconciled_order", failure: null,
      };
      attempts.push(attempt); await options.onAttempt?.(attempt);
      return {
        order: { ...resolved, reconciled: !created.orderId },
        createRequestCount: requestNumber,
        successfulOrderCount: 1,
        activeOrderCount: 1,
        attemptedCandidateIds: [...attempted],
        attempts,
      };
    } catch (error) {
      const reconciled = await options.reconcile(candidate, requestStartedAt);
      if (reconciled?.orderId) {
        const attempt: ResilientCreateAttempt = {
          requestNumber, candidateId: candidate.id, startedAt: requestStartedAt.toISOString(),
          completedAt: new Date(now()).toISOString(), result: "reconciled_order", failure: safeFailure(error),
        };
        attempts.push(attempt); await options.onAttempt?.(attempt);
        return {
          order: { ...reconciled, reconciled: true },
          createRequestCount: requestNumber,
          successfulOrderCount: 1,
          activeOrderCount: 1,
          attemptedCandidateIds: [...attempted],
          attempts,
        };
      }
      const attempt: ResilientCreateAttempt = {
        requestNumber, candidateId: candidate.id, startedAt: requestStartedAt.toISOString(),
        completedAt: new Date(now()).toISOString(), result: "failed_request", failure: safeFailure(error),
      };
      attempts.push(attempt); await options.onAttempt?.(attempt);
      const shouldRetry = options.shouldRetryOnNextCandidate?.(error) ?? isRetryableCloreCreateError(error);
      if (!shouldRetry || requestNumber >= options.maximumCreateRequests) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { resilientAttempts: attempts });
      await sleep(backoffs[requestNumber - 1] ?? backoffs.at(-1)!);
    }
  }
  throw new Error("resilient_create_request_limit_exhausted");
}
