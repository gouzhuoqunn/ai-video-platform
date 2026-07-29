import { requiresManualInferenceRecovery } from "./image-task-retry-policy";

export type GroupableImageTask = {
  id: string;
  status?: string;
  prompt?: string;
  width?: number | string | null;
  height?: number | string | null;
  referenceImage?: string | null;
  groupId?: string;
  groupIndex?: number;
  groupRequestedCount?: number;
  groupCreatedAt?: string;
  groupTitle?: string;
  createdAt?: string;
  updatedAt?: string;
  result?: { completedAt?: string; persistedAt?: string };
};

export type ImageTaskGroup<T extends GroupableImageTask = GroupableImageTask> = {
  id: string;
  title: string;
  tasks: T[];
  requestedCount: number;
  completedCount: number;
  pendingCount: number;
  pendingConfirmationCount: number;
  waitingForGpuCount: number;
  generatingCount: number;
  failedCount: number;
  currentChildIndex: number | null;
  status: "pending_confirmation" | "waiting_for_gpu" | "generating" | "failed" | "completed";
  latestCompletedAt: string | null;
  isActive: boolean;
};

export type MutableGroupableImageTask = GroupableImageTask & {
  status?: string;
  updatedAt?: string;
  attempts?: number;
  localClaim?: unknown;
  error?: unknown;
  inferenceRetryBlock?: unknown;
};

export type StudioExecutableBatch = {
  plannedTaskIds: string[];
  executableCount: number;
  excludedInconsistentTaskIds: string[];
};

export type StudioBatchTask = GroupableImageTask & {
  gpuClass?: "rtx4090" | "rtx5090" | null;
};

export const MAX_STUDIO_SELECTED_BATCH_SIZE = 8;

export function groupIdentity(task: GroupableImageTask) { return task.groupId || task.id; }
export function promptTitle(prompt: string | undefined) { return Array.from(prompt ?? "").slice(0, 12).join(""); }

/**
 * An explicit activity-rail selection is authoritative for the next paid
 * start. In particular, a selected pending group deliberately produces an
 * empty batch instead of falling through to unrelated historical waiting
 * tasks. The server still revalidates and canonically orders these exact IDs.
 */
export function selectStudioExecutableBatch<T extends StudioBatchTask>(
  tasks: readonly T[],
  selectedGroupIds: ReadonlySet<string>,
  gpuClass: "rtx4090" | "rtx5090",
  fallback: StudioExecutableBatch,
): StudioExecutableBatch {
  if (selectedGroupIds.size === 0) return fallback;
  const excluded = new Set(fallback.excludedInconsistentTaskIds);
  const seen = new Set<string>();
  const plannedTaskIds: string[] = [];
  for (const task of tasks) {
    if (
      plannedTaskIds.length >= MAX_STUDIO_SELECTED_BATCH_SIZE
      || seen.has(task.id)
      || !selectedGroupIds.has(groupIdentity(task))
      || task.status !== "waiting_for_gpu"
      || task.gpuClass !== gpuClass
      || excluded.has(task.id)
    ) continue;
    seen.add(task.id);
    plannedTaskIds.push(task.id);
  }
  return {
    plannedTaskIds,
    executableCount: plannedTaskIds.length,
    excludedInconsistentTaskIds: fallback.excludedInconsistentTaskIds,
  };
}

export function groupStatusLabel(status: ImageTaskGroup["status"]) {
  return ({ pending_confirmation: "待确认", waiting_for_gpu: "等待显卡", generating: "生成中", failed: "失败", completed: "已完成" })[status];
}

export function confirmImageTaskGroup<T extends MutableGroupableImageTask>(tasks: T[], groupId: string, updatedAt: string) {
  let confirmed = 0;
  let blocked = 0;
  const next = tasks.map((task) => {
    if (groupIdentity(task) !== groupId || task.status !== "pending_confirmation") return task;
    if (requiresManualInferenceRecovery(task)) {
      blocked += 1;
      return task;
    }
    confirmed += 1;
    return { ...task, status: "waiting_for_gpu", updatedAt } as T;
  });
  if (!confirmed && blocked) throw new Error("该任务组有图片请求已经提交但结果未确认，为避免重复生成，不能再次确认。");
  if (!confirmed) throw new Error("该任务组没有可确认的任务。");
  return { tasks: next, confirmed, blocked };
}

export function cancelImageTaskGroup<T extends MutableGroupableImageTask>(tasks: T[], groupId: string) {
  const members = tasks.filter((task) => groupIdentity(task) === groupId);
  if (!members.length) throw new Error("未找到任务组。");
  const cancellable = new Set(members.filter((task) => !task.localClaim && ["pending_confirmation", "waiting_for_gpu", "failed"].includes(task.status ?? "")).map((task) => task.id));
  const protectedCount = members.filter((task) => task.status === "generating" || task.localClaim).length;
  if (!cancellable.size && protectedCount) throw new Error("该任务组已有图像进入生成，不能在这里取消；请使用批次级停止操作。");
  if (!cancellable.size) throw new Error("该任务组没有可取消的未认领任务。");
  return {
    tasks: tasks.filter((task) => !cancellable.has(task.id)),
    cancelled: cancellable.size,
    blocker: protectedCount ? "已有图像正在生成，已保留该图像；其余未认领任务已取消。" : null,
  };
}

/** Destructive deletion is intentionally limited to never-confirmed children. */
export function deletePendingImageTaskGroup<T extends MutableGroupableImageTask>(tasks: T[], groupId: string) {
  const members = tasks.filter((task) => groupIdentity(task) === groupId);
  if (!members.length) throw new Error("未找到任务组。");
  const deletable = new Set(members.filter((task) => task.status === "pending_confirmation").map((task) => task.id));
  if (!deletable.size) throw new Error("等待显卡的任务不能删除；请使用取消任务。");
  return { tasks: tasks.filter((task) => !deletable.has(task.id)), deleted: deletable.size };
}

/** Reverts only unclaimed waiting children; it never deletes task history or artifacts. */
export function unconfirmImageTaskGroup<T extends MutableGroupableImageTask>(tasks: T[], groupId: string, updatedAt: string) {
  const members = tasks.filter((task) => groupIdentity(task) === groupId);
  if (!members.length) throw new Error("未找到任务组。");
  const activeClaim = (task: T) => {
    if (!task.localClaim || typeof task.localClaim !== "object") return Boolean(task.localClaim);
    const expiresAt = (task.localClaim as { leaseExpiresAt?: unknown }).leaseExpiresAt;
    return typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) > Date.now();
  };
  if (members.some((task) => task.status === "generating" || activeClaim(task))) {
    throw new Error("任务已开始生成，请使用停止并退租。");
  }
  let reverted = 0;
  const next = tasks.map((task) => {
    if (groupIdentity(task) !== groupId || task.status !== "waiting_for_gpu") return task;
    reverted += 1;
    const restored = { ...task, status: "pending_confirmation", updatedAt } as T;
    delete restored.localClaim;
    delete restored.error;
    return restored;
  });
  if (!reverted) throw new Error("尚未确认生成，无需取消。");
  return { tasks: next, reverted };
}

export function retryFailedImageTaskGroup<T extends MutableGroupableImageTask>(tasks: T[], groupId: string, updatedAt: string) {
  let retried = 0;
  let blocked = 0;
  const next = tasks.map((task) => {
    if (groupIdentity(task) !== groupId || task.status !== "failed" || task.localClaim) return task;
    if (requiresManualInferenceRecovery(task)) {
      blocked += 1;
      return task;
    }
    retried += 1;
    const replacement = { ...task, status: "pending_confirmation", attempts: Number(task.attempts ?? 0) + 1, updatedAt } as T;
    delete replacement.error;
    return replacement;
  });
  if (!retried && blocked) throw new Error("该任务组有图片请求已经提交但结果未确认，为避免重复生成，已禁止自动重试。");
  if (!retried) throw new Error("该任务组没有可重试的失败任务。");
  return { tasks: next, retried, blocked };
}

export function groupImageTasks<T extends GroupableImageTask>(tasks: T[]): ImageTaskGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const task of tasks) {
    const id = groupIdentity(task);
    map.set(id, [...(map.get(id) ?? []), task]);
  }
  return [...map.entries()].map(([id, members]) => {
    const ordered = [...members].sort((a, b) => (a.groupIndex ?? 1) - (b.groupIndex ?? 1) || a.id.localeCompare(b.id));
    const completed = ordered.filter((task) => task.status === "completed");
    const pendingConfirmation = ordered.filter((task) => task.status === "pending_confirmation");
    const waitingForGpu = ordered.filter((task) => task.status === "waiting_for_gpu");
    const pending = [...pendingConfirmation, ...waitingForGpu];
    const generating = ordered.filter((task) => task.status === "generating");
    const failed = ordered.filter((task) => task.status === "failed");
    const requested = Math.max(ordered.length, ...ordered.map((task) => Number.isSafeInteger(task.groupRequestedCount) && task.groupRequestedCount! > 0 ? task.groupRequestedCount! : 0));
    const completedDates = completed.map((task) => task.result?.completedAt ?? task.result?.persistedAt ?? task.updatedAt ?? task.createdAt ?? "").filter(Boolean).sort();
    const generatingTask = generating[0];
    const status = generating.length ? "generating" : pendingConfirmation.length ? "pending_confirmation" : waitingForGpu.length ? "waiting_for_gpu" : failed.length ? "failed" : "completed";
    return {
      id,
      title: ordered.find((task) => task.groupTitle)?.groupTitle || promptTitle(ordered[0]?.prompt),
      tasks: ordered,
      requestedCount: requested,
      completedCount: completed.length,
      pendingCount: pending.length,
      pendingConfirmationCount: pendingConfirmation.length,
      waitingForGpuCount: waitingForGpu.length,
      generatingCount: generating.length,
      failedCount: failed.length,
      currentChildIndex: generatingTask?.groupIndex ?? null,
      status,
      latestCompletedAt: completedDates.at(-1) ?? null,
      isActive: pending.length + generating.length + failed.length > 0,
    };
  });
}
