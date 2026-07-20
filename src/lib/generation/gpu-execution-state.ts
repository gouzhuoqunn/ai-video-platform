export type GenerationFamily = "image" | "video";
export type RequiredGpuClass = "rtx4090" | "rtx5090";
export type GenerationActivity = "idle" | "searching" | "deploying" | "running" | "stopping" | "stopping_task" | "stopping_model" | "canceling" | "error";
export type DeployedModelFamily = "none" | "image" | "video" | "unknown";
export type DeployedModelKey = "none" | "image_flux" | "video_wan_silent" | "video_ltx_native_audio" | "unknown";

export const GPU_IDLE_CANCEL_SECONDS = 120;

export type ActiveGpuExecution = {
  generationFamily: GenerationFamily;
  modelKey?: DeployedModelKey;
  gpuClass: RequiredGpuClass;
  confirmedTaskIds: string[];
  runtimeSessionId: string | null;
};

export type GpuExecutionState = {
  rentedGpuClass: RequiredGpuClass | null;
  deployedFamily: DeployedModelFamily;
  deployedModel: DeployedModelKey;
  activity: GenerationActivity;
  providerOrderId: string | null;
  runtimeSessionId: string | null;
  activeExecution: ActiveGpuExecution | null;
  idleCancelAt: string | null;
  switchPhase: "unloading" | "deploying" | null;
  operationId: string | null;
  lastError: string | null;
  notice: "rental_succeeded" | "generation_stopped" | "model_switched" | "gpu_canceled" | null;
  updatedAt: string;
};

type GpuClassTaskLike = {
  requiredGpuClass?: RequiredGpuClass | null;
  gpuPreference?: string[];
  width?: number;
  height?: number;
};

export type QueueTaskLike = GpuClassTaskLike & {
  id: string;
  generationType: GenerationFamily;
  soundMode?: "silent" | "audible" | null;
  modelKey?: string;
  status: string;
};

export type ConfirmedQueueCounts = Record<GenerationFamily, Record<RequiredGpuClass, number>>;
export type ConfirmedVideoQueueCounts = Record<"silent" | "audible", Record<RequiredGpuClass, number>>;

const CONFIRMED_WAITING_STATUSES = new Set(["waiting_for_batch", "armed", "waiting_for_gpu"]);

function timestamp(at = Date.now()) {
  return new Date(at).toISOString();
}

export function defaultGpuExecutionState(at = Date.now()): GpuExecutionState {
  return {
    rentedGpuClass: null,
    deployedFamily: "none",
    deployedModel: "none",
    activity: "idle",
    providerOrderId: null,
    runtimeSessionId: null,
    activeExecution: null,
    idleCancelAt: null,
    switchPhase: null,
    operationId: null,
    lastError: null,
    notice: null,
    updatedAt: timestamp(at),
  };
}

export function normalizeRequiredGpuClass(task: GpuClassTaskLike): RequiredGpuClass {
  if (task.requiredGpuClass === "rtx4090" || task.requiredGpuClass === "rtx5090") return task.requiredGpuClass;
  const supported = [...new Set((task.gpuPreference ?? []).filter((gpu): gpu is RequiredGpuClass => gpu === "rtx4090" || gpu === "rtx5090"))];
  if (supported.length === 1) return supported[0];
  if ((task.width ?? 0) >= 2048 || (task.height ?? 0) >= 2048) return "rtx5090";
  return "rtx4090";
}

export function confirmedQueueTasks<T extends QueueTaskLike>(
  tasks: T[],
  family: GenerationFamily,
  gpuClass: RequiredGpuClass,
) {
  return tasks.filter((task) =>
    task.generationType === family
    && normalizeRequiredGpuClass(task) === gpuClass
    && CONFIRMED_WAITING_STATUSES.has(task.status),
  );
}

export function confirmedQueueCounts(tasks: QueueTaskLike[]): ConfirmedQueueCounts {
  const counts: ConfirmedQueueCounts = {
    image: { rtx4090: 0, rtx5090: 0 },
    video: { rtx4090: 0, rtx5090: 0 },
  };
  for (const task of tasks) {
    if (!CONFIRMED_WAITING_STATUSES.has(task.status)) continue;
    counts[task.generationType][normalizeRequiredGpuClass(task)] += 1;
  }
  return counts;
}

export function confirmedVideoQueueCounts(tasks: QueueTaskLike[]): ConfirmedVideoQueueCounts {
  const counts: ConfirmedVideoQueueCounts = { silent: { rtx4090: 0, rtx5090: 0 }, audible: { rtx4090: 0, rtx5090: 0 } };
  for (const task of tasks) {
    if (task.generationType !== "video" || !CONFIRMED_WAITING_STATUSES.has(task.status)) continue;
    counts[task.soundMode === "audible" ? "audible" : "silent"][normalizeRequiredGpuClass(task)] += 1;
  }
  return counts;
}

export function deployedModelFromModelKeys(modelKeys: string[]): DeployedModelKey {
  if (modelKeys.some((key) => /ltx|sulphur|native_audio/i.test(key))) return "video_ltx_native_audio";
  if (modelKeys.some((key) => /wan/i.test(key))) return "video_wan_silent";
  if (modelKeys.some((key) => /ultrareal|flux/i.test(key))) return "image_flux";
  return modelKeys.length ? "unknown" : "none";
}

export function deployedFamilyFromModelKeys(modelKeys: string[]): DeployedModelFamily {
  const image = modelKeys.some((key) => /ultrareal|flux/i.test(key));
  const video = modelKeys.some((key) => /wan/i.test(key));
  if (image && video) return "unknown";
  if (image) return "image";
  if (video) return "video";
  return modelKeys.length ? "unknown" : "none";
}

export function normalizeGpuExecutionState(
  value: (Partial<GpuExecutionState> & { rentalState?: string; runtimeState?: string }) | null | undefined,
  legacy?: {
    providerOrderId?: string | null;
    loadedModels?: string[];
    activeTaskIds?: string[];
    phase?: string;
    automaticShutdownAt?: string | null;
  } | null,
): GpuExecutionState {
  const base = defaultGpuExecutionState();
  if (value) {
    const current = { ...value };
    delete current.rentalState;
    delete current.runtimeState;
    const legacyActivity: GenerationActivity = value.rentalState === "searching"
      ? "searching"
      : value.rentalState === "canceling"
        ? "canceling"
        : value.runtimeState === "switching" || value.runtimeState === "deploying"
          ? "deploying"
          : value.runtimeState === "running"
            ? "running"
            : value.runtimeState === "stopping"
              ? "stopping"
              : value.runtimeState === "error" || value.rentalState === "error"
                ? "error"
                : "idle";
    const activity = ["idle", "searching", "deploying", "running", "stopping", "stopping_task", "stopping_model", "canceling", "error"].includes(value.activity ?? "")
      ? value.activity as GenerationActivity
      : legacyActivity;
    return {
      ...base,
      ...current,
      activity,
      activeExecution: value.activeExecution ?? null,
      rentedGpuClass: value.rentedGpuClass === "rtx4090" || value.rentedGpuClass === "rtx5090" ? value.rentedGpuClass : null,
      deployedModel: ["none", "image_flux", "video_wan_silent", "video_ltx_native_audio", "unknown"].includes(value.deployedModel ?? "") ? value.deployedModel as DeployedModelKey : value.deployedFamily === "image" ? "image_flux" : value.deployedFamily === "video" ? "video_wan_silent" : "none",
      runtimeSessionId: value.runtimeSessionId ?? value.activeExecution?.runtimeSessionId ?? null,
    };
  }
  if (!legacy?.providerOrderId) return base;
  const deployedFamily = deployedFamilyFromModelKeys(legacy.loadedModels ?? []);
  const deployedModel = deployedModelFromModelKeys(legacy.loadedModels ?? []);
  const running = /inference_running|media_conversion_running/.test(legacy.phase ?? "");
  return {
    ...base,
    activity: running ? "running" : "idle",
    deployedFamily,
    deployedModel,
    providerOrderId: legacy.providerOrderId,
    idleCancelAt: legacy.automaticShutdownAt ?? null,
  };
}

export function assertSingleFamilyExecution(
  tasks: QueueTaskLike[],
  family: GenerationFamily,
  gpuClass: RequiredGpuClass,
) {
  if (!tasks.length) throw new Error("所选执行队列没有已确认任务。");
  if (tasks.some((task) => task.generationType !== family)) throw new Error("一次执行不能混合图片和视频任务。");
  if (tasks.some((task) => normalizeRequiredGpuClass(task) !== gpuClass)) throw new Error("一次执行不能混合 RTX 4090 和 RTX 5090 队列。");
  if (tasks.some((task) => !CONFIRMED_WAITING_STATUSES.has(task.status))) throw new Error("执行队列包含未确认或不可执行任务。");
}

function assertOperationIdle(state: GpuExecutionState) {
  if (state.operationId || !["idle", "running", "error"].includes(state.activity)) {
    throw new Error("GPU 操作正在处理中，请勿重复点击。");
  }
}

export function beginRentalSearch(
  state: GpuExecutionState,
  input: Omit<ActiveGpuExecution, "runtimeSessionId"> & { operationId: string },
  at = Date.now(),
): GpuExecutionState {
  assertOperationIdle(state);
  if (state.rentedGpuClass || state.providerOrderId) throw new Error("已有租用中的 GPU，不会创建第二个订单。");
  return {
    ...state,
    activity: "searching",
    activeExecution: { ...input, runtimeSessionId: null },
    idleCancelAt: null,
    operationId: input.operationId,
    lastError: null,
    notice: null,
    updatedAt: timestamp(at),
  };
}

export function abortRentalSearch(state: GpuExecutionState, at = Date.now()): GpuExecutionState {
  if (state.activity !== "searching" || state.providerOrderId || state.rentedGpuClass) throw new Error("当前没有可取消的寻卡操作。");
  return {
    ...defaultGpuExecutionState(at),
    lastError: state.lastError,
  };
}

export function recordRentalSuccess(
  state: GpuExecutionState,
  input: { providerOrderId: string; runtimeSessionId: string; gpuClass: RequiredGpuClass },
  at = Date.now(),
): GpuExecutionState {
  if (state.activity !== "searching" || !state.activeExecution || !state.operationId) throw new Error("没有可完成的手动租用操作。");
  if (state.activeExecution.gpuClass !== input.gpuClass) throw new Error("租用显卡与所选执行队列不一致。");
  return {
    ...state,
    activity: "deploying",
    deployedFamily: "none",
    deployedModel: "none",
    rentedGpuClass: input.gpuClass,
    providerOrderId: input.providerOrderId,
    runtimeSessionId: input.runtimeSessionId,
    activeExecution: { ...state.activeExecution, runtimeSessionId: input.runtimeSessionId },
    operationId: null,
    switchPhase: "deploying",
    notice: "rental_succeeded",
    updatedAt: timestamp(at),
  };
}

export function beginExistingGpuExecution(
  state: GpuExecutionState,
  input: Omit<ActiveGpuExecution, "runtimeSessionId"> & { operationId: string },
  at = Date.now(),
): GpuExecutionState {
  assertOperationIdle(state);
  if (!state.providerOrderId || !state.rentedGpuClass) throw new Error("当前没有可复用的已租用 GPU。");
  if (state.rentedGpuClass !== input.gpuClass) {
    throw new Error(`当前租用的是 ${state.rentedGpuClass === "rtx5090" ? "RTX 5090" : "RTX 4090"}，请先退租后处理 ${input.gpuClass === "rtx5090" ? "RTX 5090" : "RTX 4090"} 队列。`);
  }
  if (state.deployedFamily === "unknown") throw new Error("当前 GPU 模型状态未知，必须先安全停止或退租。");
  if (state.activity !== "idle") {
    throw new Error(state.activity === "running" ? "当前生成仍在运行，请先安全终止生成。" : "GPU 状态正在切换，请稍候。");
  }
  const sameFamily = state.deployedFamily === input.generationFamily;
  const switching = state.deployedFamily !== "none" && !sameFamily;
  return {
    ...state,
    activity: "deploying",
    activeExecution: { ...input, runtimeSessionId: state.runtimeSessionId },
    idleCancelAt: null,
    operationId: input.operationId,
    switchPhase: switching ? "unloading" : "deploying",
    lastError: null,
    notice: null,
    updatedAt: timestamp(at),
  };
}

export function recordPreviousFamilyUnloaded(state: GpuExecutionState, at = Date.now()): GpuExecutionState {
  if (state.activity !== "deploying" || state.switchPhase !== "unloading") throw new Error("当前不在模型卸载阶段。");
  return {
    ...state,
    deployedFamily: "none",
    switchPhase: "deploying",
    updatedAt: timestamp(at),
  };
}

export function recordDeploymentReady(state: GpuExecutionState, at = Date.now()): GpuExecutionState {
  if (!state.activeExecution || state.activity !== "deploying" || state.switchPhase === "unloading") {
    throw new Error("当前没有可完成的模型部署。");
  }
  return {
    ...state,
    activity: "running",
    deployedFamily: state.activeExecution.generationFamily,
    deployedModel: state.activeExecution.modelKey ?? (state.activeExecution.generationFamily === "image" ? "image_flux" : "video_wan_silent"),
    switchPhase: null,
    operationId: null,
    idleCancelAt: null,
    notice: state.deployedFamily !== "none" && state.deployedFamily !== state.activeExecution.generationFamily ? "model_switched" : state.notice,
    updatedAt: timestamp(at),
  };
}

export function recordDeploymentFailure(state: GpuExecutionState, reason: string, at = Date.now()): GpuExecutionState {
  if (!state.rentedGpuClass || !state.providerOrderId) throw new Error("没有可记录部署失败的已租用 GPU。");
  return {
    ...state,
    activity: "error",
    deployedFamily: "none",
    deployedModel: "none",
    activeExecution: null,
    idleCancelAt: timestamp(at + GPU_IDLE_CANCEL_SECONDS * 1000),
    switchPhase: null,
    operationId: null,
    lastError: reason.split(/\r?\n/)[0].slice(0, 300),
    updatedAt: timestamp(at),
  };
}

export function requestGenerationStop(state: GpuExecutionState, operationId: string, at = Date.now()): GpuExecutionState {
  assertOperationIdle(state);
  if (!state.providerOrderId || !state.rentedGpuClass || state.activity !== "running" || !state.activeExecution) throw new Error("当前没有正在运行的生成任务。");
  return {
    ...state,
    activity: "stopping",
    operationId,
    lastError: null,
    updatedAt: timestamp(at),
  };
}

export function completeGenerationStop(state: GpuExecutionState, at = Date.now()): GpuExecutionState {
  if (!state.rentedGpuClass || !state.providerOrderId || state.activity !== "stopping") throw new Error("当前没有等待完成的停止操作。");
  return {
    ...state,
    activity: "idle",
    activeExecution: null,
    idleCancelAt: timestamp(at + GPU_IDLE_CANCEL_SECONDS * 1000),
    operationId: null,
    notice: "generation_stopped",
    updatedAt: timestamp(at),
  };
}

export function requestModelStop(state: GpuExecutionState, operationId: string, at = Date.now()): GpuExecutionState {
  if (!state.rentedGpuClass || !state.providerOrderId || state.deployedModel === "none" || state.activity === "canceling" || state.operationId) throw new Error("当前没有可停止的模型。");
  return { ...state, activity: "stopping_model", operationId, idleCancelAt: null, updatedAt: timestamp(at) };
}

export function completeModelStop(state: GpuExecutionState, at = Date.now()): GpuExecutionState {
  if (state.activity !== "stopping_model") throw new Error("当前没有等待完成的停止模型操作。");
  return { ...state, activity: "idle", deployedFamily: "none", deployedModel: "none", activeExecution: null, switchPhase: null, operationId: null, idleCancelAt: timestamp(at + GPU_IDLE_CANCEL_SECONDS * 1000), notice: "generation_stopped", updatedAt: timestamp(at) };
}

export function requestGpuCancellation(state: GpuExecutionState, operationId: string, at = Date.now()): GpuExecutionState {
  if (state.activity === "canceling" || state.operationId) throw new Error("GPU 操作正在处理中，请勿重复点击。");
  if (!state.rentedGpuClass || !state.providerOrderId) throw new Error("当前没有可退租的 GPU。");
  return {
    ...state,
    activity: "canceling",
    operationId,
    idleCancelAt: null,
    lastError: null,
    updatedAt: timestamp(at),
  };
}

export function completeGpuCancellation(state: GpuExecutionState, at = Date.now()): GpuExecutionState {
  if (state.activity !== "canceling") throw new Error("当前没有等待完成的退租操作。");
  return {
    ...defaultGpuExecutionState(at),
    notice: "gpu_canceled",
  };
}

export type ExecutionAction =
  | { kind: "rent"; label: "开始任务并租用显卡"; disabled: false; reason: null }
  | { kind: "continue"; label: string; disabled: false; reason: null }
  | { kind: "deploy"; label: string; disabled: false; reason: null }
  | { kind: "switch"; label: string; disabled: false; reason: null }
  | { kind: "blocked"; label: null; disabled: true; reason: string };

export function executionActionFor(
  state: GpuExecutionState,
  family: GenerationFamily,
  gpuClass: RequiredGpuClass,
  queueCount: number,
): ExecutionAction {
  if (queueCount <= 0) return { kind: "blocked", label: null, disabled: true, reason: "所选队列暂无已确认任务。" };
  if (state.activity === "searching") return { kind: "blocked", label: null, disabled: true, reason: "正在搜寻显卡中" };
  if (state.activity === "canceling") return { kind: "blocked", label: null, disabled: true, reason: "正在退租显卡" };
  if (["deploying", "stopping"].includes(state.activity)) return { kind: "blocked", label: null, disabled: true, reason: "GPU 状态正在切换，请稍候。" };
  if (!state.rentedGpuClass && !state.providerOrderId && state.activity === "idle") return { kind: "rent", label: "开始任务并租用显卡", disabled: false, reason: null };
  if (!state.rentedGpuClass || !state.providerOrderId) return { kind: "blocked", label: null, disabled: true, reason: state.lastError ?? "GPU 状态不可用。" };
  if (state.rentedGpuClass !== gpuClass) {
    return {
      kind: "blocked",
      label: null,
      disabled: true,
      reason: `当前租用的是 ${state.rentedGpuClass === "rtx5090" ? "RTX 5090" : "RTX 4090"}，请先退租后处理 ${gpuClass === "rtx5090" ? "RTX 5090" : "RTX 4090"} 队列。`,
    };
  }
  const familyLabel = family === "image" ? "图片" : "视频";
  if (state.activity === "running") return { kind: "blocked", label: null, disabled: true, reason: `当前正在生成${state.deployedFamily === "video" ? "视频" : "图片"}，请先终止生成。` };
  if (state.activity === "error") return { kind: "blocked", label: null, disabled: true, reason: state.lastError ?? "GPU 状态异常，请先安全退租。" };
  if (state.deployedFamily === family) return { kind: "continue", label: `继续处理${familyLabel}任务`, disabled: false, reason: null };
  if (state.deployedFamily === "none") return { kind: "deploy", label: `在当前GPU上部署${familyLabel}模型并开始`, disabled: false, reason: null };
  if (state.deployedFamily === "unknown") return { kind: "blocked", label: null, disabled: true, reason: "当前 GPU 模型状态未知，请先安全退租。" };
  return { kind: "switch", label: `在当前GPU上部署${familyLabel}模型并开始`, disabled: false, reason: null };
}

export function idleCancellationDue(state: GpuExecutionState, at = Date.now()) {
  return Boolean(
    state.activity === "idle"
    && state.rentedGpuClass
    && state.providerOrderId
    && state.idleCancelAt
    && Date.parse(state.idleCancelAt) <= at,
  );
}
