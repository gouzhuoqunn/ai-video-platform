export type RentalTiming = {
  startedAt: string;
  drainingAt: string | null;
  hardDeadlineAt: string | null;
};

type RunnerIdentity = {
  state: string;
  attemptId: string | null;
  orderId: string | null;
  serverId: string | null;
  candidateRole: string | null;
  frozenTaskIds: string[];
};

type ActiveOrderIdentity = {
  orderId: string;
  serverId: string;
  createdAt: string;
  createAttemptId: string | null;
};

type WatchdogTiming = {
  armed: boolean;
  serverId: string;
  drainingAt: string;
  hardDeadlineAt: string;
};

type LiveStageProjection = {
  stage: string;
  currentTaskIndex: number | null;
};

const LIVE_STAGE_LABELS = {
  environment: "正在检查运行环境",
  gpu: "正在验证 RTX 4090",
  controller: "正在启动 Controller",
  comfyui: "正在启动 ComfyUI",
  models: "正在下载并校验模型",
  inference: "正在生成图像",
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonemptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function validTimestamp(value: unknown) {
  const text = nonemptyString(value);
  return text
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)
    && Number.isFinite(Date.parse(text))
    ? text
    : null;
}

export function activeOrderMatchesRunner(
  runner: RunnerIdentity,
  activeOrder: ActiveOrderIdentity | null,
) {
  if (!activeOrder || !runner.attemptId || !runner.serverId) return false;
  if (runner.state === "idle") return false;
  if (runner.serverId !== activeOrder.serverId) return false;
  if (runner.orderId && runner.orderId !== activeOrder.orderId) return false;
  return !activeOrder.createAttemptId || activeOrder.createAttemptId === runner.attemptId;
}

export function projectLiveReceiptStage(
  runner: RunnerIdentity,
  receiptValue: unknown,
): LiveStageProjection | null {
  const receipt = record(receiptValue);
  if (!receipt || runner.state !== "running" || !runner.attemptId || !runner.orderId || !runner.serverId) return null;
  if (receipt.sessionState !== "running"
    || receipt.sessionId !== runner.attemptId
    || receipt.orderId !== runner.orderId
    || receipt.serverId !== runner.serverId) return null;
  if (!nonemptyString(receipt.currentStageRunId)) return null;

  const remoteStage = nonemptyString(receipt.currentRemoteStage);
  if (!remoteStage || !(remoteStage in LIVE_STAGE_LABELS)) return null;
  const selectedTaskIds = Array.isArray(receipt.selectedTaskIds)
    ? receipt.selectedTaskIds.map(nonemptyString).filter((value): value is string => Boolean(value))
    : [];
  if (selectedTaskIds.length !== runner.frozenTaskIds.length
    || selectedTaskIds.some((taskId, index) => taskId !== runner.frozenTaskIds[index])) return null;

  const currentTaskId = nonemptyString(receipt.currentTaskId);
  const currentTaskIndex = currentTaskId ? runner.frozenTaskIds.indexOf(currentTaskId) : -1;
  if (remoteStage === "inference" && currentTaskIndex < 0) return null;
  const base = LIVE_STAGE_LABELS[remoteStage as keyof typeof LIVE_STAGE_LABELS];
  return {
    stage: remoteStage === "inference"
      ? `${base}（第 ${currentTaskIndex + 1} / ${runner.frozenTaskIds.length} 张）`
      : base,
    currentTaskIndex: currentTaskIndex >= 0 ? currentTaskIndex : null,
  };
}

export function projectRentalTiming(input: {
  runner: RunnerIdentity;
  activeOrder: ActiveOrderIdentity | null;
  watchdog: WatchdogTiming | null;
}): RentalTiming | null {
  const { runner, activeOrder, watchdog } = input;
  if (runner.candidateRole !== "rented_host"
    || !runner.orderId
    || !activeOrderMatchesRunner(runner, activeOrder)
    || runner.orderId !== activeOrder?.orderId) return null;
  const startedAt = validTimestamp(activeOrder.createdAt);
  if (!startedAt) return null;
  if (!watchdog?.armed || watchdog.serverId !== activeOrder.serverId) {
    return { startedAt, drainingAt: null, hardDeadlineAt: null };
  }
  return {
    startedAt,
    drainingAt: validTimestamp(watchdog.drainingAt),
    hardDeadlineAt: validTimestamp(watchdog.hardDeadlineAt),
  };
}

export function formatClockDuration(milliseconds: number) {
  const totalSeconds = Math.floor(Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

export function rentalClockSnapshot(timing: RentalTiming | null | undefined, nowMs: number) {
  const startedAt = timing ? validTimestamp(timing.startedAt) : null;
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return null;
  const hardDeadlineAt = timing?.hardDeadlineAt ? validTimestamp(timing.hardDeadlineAt) : null;
  const hardDeadlineAtMs = hardDeadlineAt ? Date.parse(hardDeadlineAt) : Number.NaN;
  return {
    elapsed: formatClockDuration(nowMs - startedAtMs),
    countdown: Number.isFinite(hardDeadlineAtMs)
      ? formatClockDuration(hardDeadlineAtMs - nowMs)
      : null,
    deadlineReached: Number.isFinite(hardDeadlineAtMs) && nowMs >= hardDeadlineAtMs,
  };
}
