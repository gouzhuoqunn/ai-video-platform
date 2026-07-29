export const HISTORICAL_RENTED_CANDIDATE_MESSAGE = "候选显卡已被其他用户租用，上次启动已结束，可以重新尝试。";
export const HISTORICAL_RUNNER_GENERIC_MESSAGE = "上次启动未完成，当前没有活动订单，可以重新尝试。";
export const HISTORICAL_AGENT_STAGE_MESSAGE = "运行环境控制服务响应不兼容，尚未进入模型加载或图片生成，订单已安全退租。";
export const CURRENT_MODEL_DOWNLOAD_MESSAGE = "模型下载或完整性校验失败，系统正在安全清理订单；请打开“当下日志”查看具体文件原因。";
export const HISTORICAL_MODEL_DOWNLOAD_MESSAGE = "上次模型下载或完整性校验失败，订单已结束；请打开“当下日志”查看具体文件原因后修正来源再重试。";
export const MODEL_DOWNLOAD_FAILURE_CLASSIFICATION = "model_download_or_integrity_failed";
export const CURRENT_CREATE_RATE_LIMIT_MESSAGE = "创建订单请求受到限流，正在核对订单状态，请稍候重试。";
export const HISTORICAL_CREATE_RATE_LIMIT_MESSAGE = "上次创建订单请求受到限流，当前没有活动订单，可以重新尝试。";
export const CREATE_RATE_LIMIT_CLASSIFICATION = "create_rate_limited";
export const PRIOR_SESSION_AUTO_RECOVERY_MESSAGE = "检测到上次有图片生成请求已提交但结果未确认。系统会在再次启动前隔离该任务，避免重复生成；其他任务可以继续。";
export const PRIOR_SESSION_MANUAL_RECOVERY_MESSAGE = "上次有图片生成请求已提交，但本地状态无法安全核对。为避免重复生成，已阻止再次启动；请打开“当下日志”处理。";
export const PRIOR_SESSION_RECOVERY_CLASSIFICATION = "prior_session_recovery_pending";
export const PRIOR_SESSION_MANUAL_RECOVERY_CLASSIFICATION = "inference_recovery_requires_attention";
export const PREORDER_SUPERVISOR_START_FAILURE_CLASSIFICATION = "preorder_supervisor_start_failed";

type RunnerError = { stage: string; message: string; at: string; classification?: string; operation?: string };
type RunnerLike = { state: string; pid?: number | null; host?: { orderId?: string | null } | null; blocker?: string | null; error?: RunnerError | null };

export type RunnerStatusProjection = {
  error: { stage: string; at: string; displayMessage: string; isBlocking: boolean; historical: boolean; classification?: string } | null;
  blocker: string | null;
};

function providerPayload(message: string) {
  return /(?:clore api failed:\s*\{|unknown_code6|server[-_\s]*already[-_\s]*rented|create_order_rate_limit_persisted|(?:http[_\s-]?status|status)\s*["':=]?\s*429)/i.test(message);
}

function rentedCandidateCode6(message: string, classification?: string) {
  if (/unknown_code6|candidate_already_rented|server[-_\s]*already[-_\s]*rented/i.test(classification ?? "")) return true;
  return /(?:["']code["']\s*:\s*6|clore\s*code\s*6|code\s*=\s*6)/i.test(message) && /server[-_\s]*already[-_\s]*rented/i.test(message);
}

function agentStageAcceptanceFailure(message: string) {
  return /^agent_stage_acceptance_invalid:[a-z_]+$/i.test(message);
}

function modelDownloadFailure(message: string, classification?: string) {
  return /(?:model_download_(?:http_error|incomplete_after_retries|exceeds_expected_size|invalid_range)|model_sha256_mismatch|invalid_lora_safetensors|lora_safetensors|model_source_(?:size_mismatch|http)|task_lora_source_identity_mismatch)/i
    .test(`${classification ?? ""} ${message}`);
}

function priorSessionAutoRecovery(message: string) {
  return /prior_session_receipt_unsafe/i.test(message);
}

function priorSessionManualRecovery(message: string) {
  return /prior_session_(?:manual_recovery_required|receipt_unreadable|local_execution_state_present|local_active_order_exists|active_order_exists|target_task_changed|id_invalid|archive_conflict|archive_verification_failed)/i.test(message);
}

function createRateLimitFailure(input: Pick<RunnerError, "stage" | "message" | "classification" | "operation">) {
  const context = `${input.stage} ${input.operation ?? ""} ${input.classification ?? ""} ${input.message}`;
  const createOrderContext = /create[_\s-]?order|creating[_\s-]?order|reconcil(?:e|ing)|clore\.create_order/i.test(context);
  if (/create_order_rate_limit_persisted|create[_\s-]?rate[_\s-]?limit(?:ed)?/i.test(context)) return true;
  if (createOrderContext && /(?:\b429\b|rate[_\s-]?limit|http[_\s-]?status|clore[_\s-]?code)/i.test(context)) return true;
  if (input.classification === "create_rate_limited") return true;
  if (input.classification !== "rate_limited") return false;
  return createOrderContext;
}

function historicalMarketMessage(classification?: string) {
  if (classification === "rate_limited") return "上次市场读取受到限流，当前没有活动订单，可以重新尝试。";
  if (classification === "authentication_failed") return "上次市场认证失败，当前没有活动订单，请检查本地凭据后重试。";
  if (classification === "transport_failed") return "上次无法连接显卡市场，当前没有活动订单，可以重新尝试。";
  if (classification === "invalid_json") return "上次市场响应无效，当前没有活动订单，可以重新尝试。";
  if (classification === "schema_incompatible") return "上次市场响应结构不兼容，当前没有活动订单，可以重新尝试。";
  return null;
}

function safeCurrentMessage(error: RunnerError) {
  if (priorSessionManualRecovery(error.message)) return PRIOR_SESSION_MANUAL_RECOVERY_MESSAGE;
  if (priorSessionAutoRecovery(error.message)) return PRIOR_SESSION_AUTO_RECOVERY_MESSAGE;
  if (createRateLimitFailure(error)) return CURRENT_CREATE_RATE_LIMIT_MESSAGE;
  if (modelDownloadFailure(error.message, error.classification)) return CURRENT_MODEL_DOWNLOAD_MESSAGE;
  return providerPayload(error.message) ? "启动请求遇到服务端错误，请先停止并检查运行状态。" : error.message;
}

function safeClassification(error: RunnerError) {
  if (priorSessionManualRecovery(error.message)) return PRIOR_SESSION_MANUAL_RECOVERY_CLASSIFICATION;
  if (priorSessionAutoRecovery(error.message)) return PRIOR_SESSION_RECOVERY_CLASSIFICATION;
  if (createRateLimitFailure(error)) return CREATE_RATE_LIMIT_CLASSIFICATION;
  if (modelDownloadFailure(error.message, error.classification)) return MODEL_DOWNLOAD_FAILURE_CLASSIFICATION;
  if (rentedCandidateCode6(error.message, error.classification)) return "candidate_already_rented";
  if (["rate_limited", "authentication_failed", "transport_failed", "invalid_json", "schema_incompatible", "provider_error"].includes(error.classification ?? "")) return error.classification;
  return undefined;
}

/**
 * This is a response-only projection. It deliberately never mutates the
 * persisted runner receipt or log evidence.
 */
export function projectRunnerStatus(runner: RunnerLike, state: { pidAlive: boolean; activeOrder: boolean; createLock: boolean }): RunnerStatusProjection {
  if (!runner.error) {
    if (!runner.blocker) return { error: null, blocker: null };
    const blockerError: RunnerError = { stage: "", message: runner.blocker, at: "" };
    if (createRateLimitFailure(blockerError)) return { error: null, blocker: CURRENT_CREATE_RATE_LIMIT_MESSAGE };
    return { error: null, blocker: providerPayload(runner.blocker) ? "启动请求遇到服务端错误，请先停止并检查运行状态。" : runner.blocker };
  }
  // A terminal record can retain its old host/order identifiers as evidence.
  // Only live PID, reconciled active-order state, or a create lock makes it current.
  const historical = ["idle", "failed", "completed"].includes(runner.state) && !state.pidAlive && !state.activeOrder && !state.createLock;
  if (historical) {
    const retryablePreorderSupervisorCollision =
      runner.error.stage === "runner_exited"
      && !runner.pid
      && !runner.host?.orderId
      && /prior_session_local_execution_state_present/i.test(runner.error.message);
    if (retryablePreorderSupervisorCollision) {
      // The supervisor has not published a Worker yet, so this attempt cannot
      // have reached create_order or inference. A fresh start still repeats
      // both the local execution-owner gate and the live active-order check.
      return {
        error: {
          stage: runner.error.stage,
          at: runner.error.at,
          displayMessage: HISTORICAL_RUNNER_GENERIC_MESSAGE,
          isBlocking: false,
          historical: true,
          classification: PREORDER_SUPERVISOR_START_FAILURE_CLASSIFICATION,
        },
        blocker: null,
      };
    }
    if (priorSessionManualRecovery(runner.error.message)) {
      return {
        error: {
          stage: runner.error.stage,
          at: runner.error.at,
          displayMessage: PRIOR_SESSION_MANUAL_RECOVERY_MESSAGE,
          isBlocking: true,
          historical: true,
          classification: PRIOR_SESSION_MANUAL_RECOVERY_CLASSIFICATION,
        },
        blocker: PRIOR_SESSION_MANUAL_RECOVERY_MESSAGE,
      };
    }
    const rented = rentedCandidateCode6(runner.error.message, runner.error.classification);
    const createRateLimited = createRateLimitFailure(runner.error);
    const marketMessage = historicalMarketMessage(runner.error.classification);
    const autoRecovery = priorSessionAutoRecovery(runner.error.message);
    const modelFailure = modelDownloadFailure(runner.error.message, runner.error.classification);
    const displayMessage = autoRecovery
      ? PRIOR_SESSION_AUTO_RECOVERY_MESSAGE
      : createRateLimited
      ? HISTORICAL_CREATE_RATE_LIMIT_MESSAGE
      : rented
        ? HISTORICAL_RENTED_CANDIDATE_MESSAGE
        : marketMessage
          ?? (modelFailure
            ? HISTORICAL_MODEL_DOWNLOAD_MESSAGE
            : agentStageAcceptanceFailure(runner.error.message)
              ? HISTORICAL_AGENT_STAGE_MESSAGE
              : HISTORICAL_RUNNER_GENERIC_MESSAGE);
    return {
      error: {
        stage: runner.error.stage,
        at: runner.error.at,
        displayMessage,
        isBlocking: false,
        historical: true,
        classification: autoRecovery
          ? PRIOR_SESSION_RECOVERY_CLASSIFICATION
          : createRateLimited
          ? CREATE_RATE_LIMIT_CLASSIFICATION
          : rented
            ? "candidate_already_rented"
            : marketMessage
              ? runner.error.classification
              : modelFailure
                ? MODEL_DOWNLOAD_FAILURE_CLASSIFICATION
                : undefined,
      },
      blocker: null,
    };
  }
  const displayMessage = safeCurrentMessage(runner.error);
  return {
    error: { stage: runner.error.stage, at: runner.error.at, displayMessage, isBlocking: true, historical: false, classification: safeClassification(runner.error) },
    blocker: runner.blocker && (
      providerPayload(runner.blocker)
      || createRateLimitFailure({ ...runner.error, message: runner.blocker })
      || modelDownloadFailure(runner.blocker, runner.error.classification)
    ) ? displayMessage : runner.blocker ?? displayMessage,
  };
}
