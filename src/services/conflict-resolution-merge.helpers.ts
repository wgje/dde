import type { Task } from '../models';

export interface TaskMergeState {
  issues: string[];
  mergedTasks: Task[];
  processedIds: Set<string>;
  conflictCount: number;
  skippedTombstoneCount: number;
  preservedSoftDeleteCount: number;
  conservativeCount: number;
}

export interface TaskTombstoneSnapshot {
  ids: ReadonlySet<string>;
  deletedAtByTaskId?: ReadonlyMap<string, number>;
}

export type TaskTombstones = ReadonlySet<string> | TaskTombstoneSnapshot;

export function createTaskMergeState(issues: string[]): TaskMergeState {
  return {
    issues,
    mergedTasks: [],
    processedIds: new Set<string>(),
    conflictCount: 0,
    skippedTombstoneCount: 0,
    preservedSoftDeleteCount: 0,
    conservativeCount: 0,
  };
}

export function createTaskTombstoneSnapshot(
  ids: ReadonlySet<string>,
  deletedAtByTaskId?: ReadonlyMap<string, number>,
): TaskTombstoneSnapshot {
  return { ids, deletedAtByTaskId };
}

export function getTaskTombstoneCount(tombstones: TaskTombstones): number {
  return getTaskTombstoneIds(tombstones).size;
}

export function skipTombstoneTask(
  task: Task,
  tombstones: TaskTombstones,
  state: TaskMergeState,
): boolean {
  const tombstoneIds = getTaskTombstoneIds(tombstones);
  if (!tombstoneIds.has(task.id)) return false;

  const tombstoneDeletedAt = getTaskTombstoneDeletedAtByTaskId(tombstones)?.get(task.id);
  if (tombstoneDeletedAt !== undefined && isTaskUpdatedAfterTombstone(task, tombstoneDeletedAt)) {
    return false;
  }

  state.skippedTombstoneCount++;
  return true;
}

export function keepConservativeLocalTask(
  localTask: Task,
  remoteTask: Task | undefined,
  tombstones: TaskTombstones,
  tombstoneQueryFailed: boolean,
  state: TaskMergeState,
): boolean {
  if (remoteTask || !tombstoneQueryFailed || getTaskTombstoneCount(tombstones) > 0) return false;

  state.mergedTasks.push(localTask);
  state.conservativeCount++;
  return true;
}

export function keepSoftDeletedLocalTask(
  localTask: Task,
  remoteTask: Task | undefined,
  state: TaskMergeState,
): boolean {
  if (!localTask.deletedAt || remoteTask) return false;

  state.mergedTasks.push(localTask);
  state.preservedSoftDeleteCount++;
  return true;
}

export function appendUnprocessedRemoteTasks(
  remoteTasks: Task[],
  state: TaskMergeState,
  shouldInclude: (remoteTask: Task) => boolean,
): void {
  for (const remoteTask of remoteTasks) {
    if (!state.processedIds.has(remoteTask.id) && shouldInclude(remoteTask)) {
      state.mergedTasks.push(remoteTask);
    }
  }
}

function getTaskTombstoneIds(tombstones: TaskTombstones): ReadonlySet<string> {
  return 'ids' in tombstones ? tombstones.ids : tombstones;
}

function getTaskTombstoneDeletedAtByTaskId(
  tombstones: TaskTombstones,
): ReadonlyMap<string, number> | undefined {
  return 'deletedAtByTaskId' in tombstones ? tombstones.deletedAtByTaskId : undefined;
}

function isTaskUpdatedAfterTombstone(task: Task, tombstoneDeletedAt: number): boolean {
  if (!task.updatedAt) return false;
  const taskUpdatedAt = Date.parse(task.updatedAt);
  return !Number.isNaN(taskUpdatedAt) && taskUpdatedAt > tombstoneDeletedAt;
}
