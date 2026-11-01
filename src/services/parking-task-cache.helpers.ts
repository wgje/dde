import type { Task } from '../models';
import { shouldPreferIncoming } from '../utils/lww-merge';

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
  return shouldPreferIncoming(remote, local);
}

export function mergeRemoteParkedTask(local: Task | undefined | null, remote: Task): Task {
  if (!local) return remote;

  return {
    ...local,
    // Lightweight parking sync must not replace canonical task structure.
    parkingMeta: remote.parkingMeta,
    updatedAt: remote.updatedAt ?? local.updatedAt,
  };
}
