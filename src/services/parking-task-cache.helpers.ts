import type { Task } from '../models';

export interface ParkedTaskCacheEntry {
  task: Task;
  projectId: string;
}

export function buildParkedTaskCacheEntries(
  tasks: Task[],
  findProjectId: (taskId: string) => string | null
): ParkedTaskCacheEntry[] {
  return tasks
    .map((task) => ({
      task,
      projectId: findProjectId(task.id),
    }))
    .filter((entry): entry is ParkedTaskCacheEntry => !!entry.projectId);
}

export function shouldApplyRemoteParkedTask(local: Task | undefined | null, remote: Task): boolean {
  return !(local && local.updatedAt && remote.updatedAt && local.updatedAt > remote.updatedAt);
}

export function mergeRemoteParkedTask(local: Task | undefined | null, remote: Task): Task {
  if (!local) return remote;

  return {
    ...local,
    ...remote,
    // Keep local displayId maintained by layout logic.
    displayId: local.displayId || remote.displayId,
  };
}
