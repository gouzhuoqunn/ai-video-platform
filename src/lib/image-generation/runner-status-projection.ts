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

function rentedCandidateCode6(message: string) {
  return /(?:["']code["']\s*:\s*6|clore\s*code\s*6|code\s*=\s*6)/i.test(message) && /server[-_\s]*already[-_\s]*rented/i.test(message);
}

function agentStageAcceptanceFailure(message: string) {
  return /^agent_stage_acceptance_invalid:[a-z_]+$/i.test(message);
}

function safeCurrentMessage(message: string) {
  return providerPayload(message) ? "启动请求遇到服务端错误，请先停止并检查运行状态。" : message;
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
    const displayMessage = rentedCandidateCode6(runner.error.message) ? HISTORICAL_RENTED_CANDIDATE_MESSAGE : agentStageAcceptanceFailure(runner.error.message) ? HISTORICAL_AGENT_STAGE_MESSAGE : HISTORICAL_RUNNER_GENERIC_MESSAGE;
    return {
      error: { stage: runner.error.stage, at: runner.error.at, displayMessage, isBlocking: false, historical: true, classification: rentedCandidateCode6(runner.error.message) ? "candidate_already_rented" : undefined },
      blocker: null,
    };
  }
  const displayMessage = safeCurrentMessage(runner.error.message);
  return {
    error: { stage: runner.error.stage, at: runner.error.at, displayMessage, isBlocking: true, historical: false, classification: runner.error.classification },
    blocker: runner.blocker && providerPayload(runner.blocker) ? displayMessage : runner.blocker ?? displayMessage,
  };
}
