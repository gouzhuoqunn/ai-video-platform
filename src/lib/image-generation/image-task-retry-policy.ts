const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const AMBIGUOUS_INFERENCE_RETRY_CLASSIFICATION = "inference_acceptance_ambiguous";
export const AMBIGUOUS_INFERENCE_RETRY_MESSAGE = "图片生成请求可能已被接受，但结果尚未确认。为避免重复生成，已禁止自动重试。";

export type InferenceRetryBlock = {
  schemaVersion: 1;
  reason: "inference_submission_may_have_been_accepted";
  sessionId: string;
  stageRunId: string | null;
  inferenceState: "submitting" | "accepted" | "ambiguous";
  recordedAt: string;
};

type RetryPolicyTask = {
  status?: unknown;
  result?: unknown;
  inferenceRetryBlock?: unknown;
  error?: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseInferenceRetryBlock(value: unknown): InferenceRetryBlock | null {
  const block = record(value);
  if (
    block?.schemaVersion !== 1
    || block.reason !== "inference_submission_may_have_been_accepted"
    || typeof block.sessionId !== "string"
    || !UUID.test(block.sessionId)
    || !(block.stageRunId === null || (typeof block.stageRunId === "string" && UUID.test(block.stageRunId)))
    || !["submitting", "accepted", "ambiguous"].includes(String(block.inferenceState))
    || typeof block.recordedAt !== "string"
    || !Number.isFinite(Date.parse(block.recordedAt))
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    reason: "inference_submission_may_have_been_accepted",
    sessionId: block.sessionId.toLowerCase(),
    stageRunId: typeof block.stageRunId === "string" ? block.stageRunId.toLowerCase() : null,
    inferenceState: block.inferenceState as InferenceRetryBlock["inferenceState"],
    recordedAt: block.recordedAt,
  };
}

/**
 * A malformed retry block also fails closed. Completed tasks remain completed,
 * but any later accidental status downgrade will make their accepted inference
 * tombstone authoritative again.
 */
export function requiresManualInferenceRecovery(task: RetryPolicyTask) {
  if (task.status === "completed" && task.result) return false;
  if (task.inferenceRetryBlock !== undefined && task.inferenceRetryBlock !== null) return true;
  const error = record(task.error);
  return error?.retryable === false;
}

export function inferenceRetryBlockMatches(
  task: RetryPolicyTask,
  evidence: Pick<InferenceRetryBlock, "sessionId" | "stageRunId">,
) {
  const block = parseInferenceRetryBlock(task.inferenceRetryBlock);
  if (!block || block.sessionId !== evidence.sessionId.toLowerCase()) return false;
  if (evidence.stageRunId === null) return true;
  return block.stageRunId === evidence.stageRunId.toLowerCase();
}
