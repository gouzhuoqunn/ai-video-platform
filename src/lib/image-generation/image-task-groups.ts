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
  generatingCount: number;
  failedCount: number;
  latestCompletedAt: string | null;
  isActive: boolean;
};

export function groupIdentity(task: GroupableImageTask) { return task.groupId || task.id; }
export function promptTitle(prompt: string | undefined) { return Array.from(prompt ?? "").slice(0, 12).join(""); }

export function groupImageTasks<T extends GroupableImageTask>(tasks: T[]): ImageTaskGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const task of tasks) {
    const id = groupIdentity(task);
    map.set(id, [...(map.get(id) ?? []), task]);
  }
  return [...map.entries()].map(([id, members]) => {
    const ordered = [...members].sort((a, b) => (a.groupIndex ?? 1) - (b.groupIndex ?? 1) || a.id.localeCompare(b.id));
    const completed = ordered.filter((task) => task.status === "completed");
    const pending = ordered.filter((task) => task.status === "pending_confirmation" || task.status === "waiting_for_gpu");
    const generating = ordered.filter((task) => task.status === "generating");
    const failed = ordered.filter((task) => task.status === "failed");
    const requested = Math.max(ordered.length, ...ordered.map((task) => Number.isSafeInteger(task.groupRequestedCount) && task.groupRequestedCount! > 0 ? task.groupRequestedCount! : 0));
    const completedDates = completed.map((task) => task.result?.completedAt ?? task.result?.persistedAt ?? task.updatedAt ?? task.createdAt ?? "").filter(Boolean).sort();
    return {
      id,
      title: ordered.find((task) => task.groupTitle)?.groupTitle || promptTitle(ordered[0]?.prompt),
      tasks: ordered,
      requestedCount: requested,
      completedCount: completed.length,
      pendingCount: pending.length,
      generatingCount: generating.length,
      failedCount: failed.length,
      latestCompletedAt: completedDates.at(-1) ?? null,
      isActive: pending.length + generating.length + failed.length > 0,
    };
  });
}
