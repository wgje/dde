import type { Task } from '../models';

export interface KeepBothTaskRuntime {
  createId: () => string;
  createShortId: () => string;
  nowIso: () => string;
}

export interface KeepBothTaskCollectionResult {
  mergedTasks: Task[];
  copiedCount: number;
}

function hasKeepBothTaskConflict(localTask: Task, remoteTask: Task): boolean {
  return localTask.title !== remoteTask.title ||
    localTask.content !== remoteTask.content ||
    localTask.status !== remoteTask.status;
}

function createKeepBothConflictCopy(localTask: Task, runtime: KeepBothTaskRuntime): Task {
  return {
    ...localTask,
    id: runtime.createId(),
    title: `${localTask.title} (副本)`,
    displayId: '',
    shortId: runtime.createShortId(),
    updatedAt: runtime.nowIso(),
  };
}

export function collectKeepBothTasks(
  localTasks: Task[],
  remoteTasks: Task[],
  runtime: KeepBothTaskRuntime,
): KeepBothTaskCollectionResult {
  const remoteTaskMap = new Map(remoteTasks.map(t => [t.id, t]));
  const mergedTasks: Task[] = [...remoteTasks];
  let copiedCount = 0;

  for (const localTask of localTasks) {
    const remoteTask = remoteTaskMap.get(localTask.id);
    if (!remoteTask) {
      mergedTasks.push(localTask);
    } else if (hasKeepBothTaskConflict(localTask, remoteTask)) {
      mergedTasks.push(createKeepBothConflictCopy(localTask, runtime));
      copiedCount++;
    }
  }

  return { mergedTasks, copiedCount };
}
