export type TaskMediaType = "image" | "video";
export type VideoTaskSubtype = "short_video" | "long_video_parent" | "long_video_segment" | null;

/** The minimum task fields needed to derive an immutable gallery view. */
export type GalleryRoutableTask = {
  id: string;
  mediaType: TaskMediaType;
  videoSubtype: VideoTaskSubtype;
  galleryParentId: string | null;
  classificationError: string | null;
};

/**
 * Gallery ownership is intentionally independent from execution/model details.
 * A generated first-frame task may execute on the image model, but when it is a
 * child of a video request it never becomes an independent image card.
 */
export function selectGalleryTasks<T extends GalleryRoutableTask>(tasks: readonly T[], mediaType: TaskMediaType) {
  return tasks.filter((task) => task.mediaType === mediaType
    && task.galleryParentId === null
    && task.classificationError === null
    && task.videoSubtype !== "long_video_segment");
}

export function selectChildGalleryTasks<T extends GalleryRoutableTask>(tasks: readonly T[], galleryParentId: string) {
  return tasks.filter((task) => task.galleryParentId === galleryParentId);
}

/** Merge polling snapshots without dropping a newer locally returned task. */
export function mergeTasksByUpdatedAt<T extends { id: string; updatedAt: string }>(current: readonly T[], incoming: readonly T[]) {
  const previousById = new Map(current.map((task) => [task.id, task]));
  const incomingIds = new Set(incoming.map((task) => task.id));
  const latestIncoming = incoming.reduce((latest, task) => latest > task.updatedAt ? latest : task.updatedAt, "");
  const merged = incoming.map((task) => {
    const previous = previousById.get(task.id);
    return previous && previous.updatedAt > task.updatedAt ? previous : task;
  });
  for (const task of current) if (!incomingIds.has(task.id) && task.updatedAt >= latestIncoming) merged.push(task);
  return merged;
}
