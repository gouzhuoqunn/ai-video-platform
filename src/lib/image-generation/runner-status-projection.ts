export const HISTORICAL_RENTED_CANDIDATE_MESSAGE = "候选显卡已被其他用户租用，上次启动已结束，可以重新尝试。";
export const HISTORICAL_RUNNER_GENERIC_MESSAGE = "上次启动未完成，当前没有活动订单，可以重新尝试。";
export const HISTORICAL_AGENT_STAGE_MESSAGE = "运行环境控制服务响应不兼容，尚未进入模型加载或图片生成，订单已安全退租。";

type RunnerError = { stage: string; message: string; at: string; classification?: string };
type RunnerLike = { state: string; pid?: number | null; host?: { orderId?: string | null } | null; blocker?: string | null; error?: RunnerError | null };

export type RunnerStatusProjection = {
  error: { stage: string; at: string; displayMessage: string; isBlocking: boolean; historical: boolean; classification?: string } | null;
  blocker: string | null;
};

function providerPayload(message: string) {
  return /(?:clore api failed:\s*\{|unknown_code6|server[-_\s]*already[-_\s]*rented)/i.test(message);
}

function rentedCandidateCode6(message: string, classification?: string) {
  if (/unknown_code6|candidate_already_rented|server[-_\s]*already[-_\s]*rented/i.test(classification ?? "")) return true;
  return /(?:["']code["']\s*:\s*6|clore\s*code\s*6|code\s*=\s*6)/i.test(message) && /server[-_\s]*already[-_\s]*rented/i.test(message);
}

function agentStageAcceptanceFailure(message: string) {
  return /^agent_stage_acceptance_invalid:[a-z_]+$/i.test(message);
}

function historicalMarketMessage(classification?: string) {
  if (classification === "rate_limited") return "上次市场读取受到限流，当前没有活动订单，可以重新尝试。";
  if (classification === "authentication_failed") return "上次市场认证失败，当前没有活动订单，请检查本地凭据后重试。";
  if (classification === "transport_failed") return "上次无法连接显卡市场，当前没有活动订单，可以重新尝试。";
  if (classification === "invalid_json") return "上次市场响应无效，当前没有活动订单，可以重新尝试。";
  if (classification === "schema_incompatible") return "上次市场响应结构不兼容，当前没有活动订单，可以重新尝试。";
  return null;
}

function safeCurrentMessage(message: string) {
  return providerPayload(message) ? "启动请求遇到服务端错误，请先停止并检查运行状态。" : message;
}

function safeClassification(message: string, classification?: string) {
  if (rentedCandidateCode6(message, classification)) return "candidate_already_rented";
  if (["rate_limited", "authentication_failed", "transport_failed", "invalid_json", "schema_incompatible", "provider_error"].includes(classification ?? "")) return classification;
  return undefined;
}

/**
 * This is a response-only projection. It deliberately never mutates the
 * persisted runner receipt or log evidence.
 */
export function projectRunnerStatus(runner: RunnerLike, state: { pidAlive: boolean; activeOrder: boolean; createLock: boolean }): RunnerStatusProjection {
  if (!runner.error) return { error: null, blocker: runner.blocker ?? null };
  // A terminal record can retain its old host/order identifiers as evidence.
  // Only live PID, reconciled active-order state, or a create lock makes it current.
  const historical = ["idle", "failed", "completed"].includes(runner.state) && !state.pidAlive && !state.activeOrder && !state.createLock;
  if (historical) {
    const rented = rentedCandidateCode6(runner.error.message, runner.error.classification);
    const marketMessage = historicalMarketMessage(runner.error.classification);
    const displayMessage = rented ? HISTORICAL_RENTED_CANDIDATE_MESSAGE : marketMessage ?? (agentStageAcceptanceFailure(runner.error.message) ? HISTORICAL_AGENT_STAGE_MESSAGE : HISTORICAL_RUNNER_GENERIC_MESSAGE);
    return {
      error: { stage: runner.error.stage, at: runner.error.at, displayMessage, isBlocking: false, historical: true, classification: rented ? "candidate_already_rented" : marketMessage ? runner.error.classification : undefined },
      blocker: null,
    };
  }
  const displayMessage = safeCurrentMessage(runner.error.message);
  return {
    error: { stage: runner.error.stage, at: runner.error.at, displayMessage, isBlocking: true, historical: false, classification: safeClassification(runner.error.message, runner.error.classification) },
    blocker: runner.blocker && providerPayload(runner.blocker) ? displayMessage : runner.blocker ?? displayMessage,
  };
}
