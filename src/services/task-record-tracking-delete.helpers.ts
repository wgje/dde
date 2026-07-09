import type { Task } from '../models';
import type { TaskDeleteBaseUpdatedAtMap } from './action-queue.types';

export function buildTaskDeleteBaseUpdatedAtMap(
  taskIds: readonly string[],
  getSnapshotTask: (taskId: string) => Pick<Task, 'updatedAt'> | null | undefined,
): TaskDeleteBaseUpdatedAtMap | undefined {
  const map: TaskDeleteBaseUpdatedAtMap = {};
  for (const taskId of taskIds) {
    const snapshotTask = getSnapshotTask(taskId);
    if (typeof snapshotTask?.updatedAt === 'string' && snapshotTask.updatedAt.length > 0) {
      map[taskId] = snapshotTask.updatedAt;
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

export function collectJustDeletedTaskIds(tasks: Task[], explicitIds: string[]): string[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task] as const));
  const childrenByParent = new Map<string, string[]>();

  for (const task of tasks) {
    if (!task.parentId) continue;

    const childIds = childrenByParent.get(task.parentId) ?? [];
    childIds.push(task.id);
    childrenByParent.set(task.parentId, childIds);
  }

  const resultIds = new Set<string>();
  const visitedIds = new Set<string>();
  const stack = [...new Set(explicitIds)];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || visitedIds.has(currentId)) continue;

    visitedIds.add(currentId);
    const task = tasksById.get(currentId);
    if (!task) continue;

    if (task.deletedAt) {
      resultIds.add(currentId);
    }

    for (const childId of childrenByParent.get(currentId) ?? []) {
      stack.push(childId);
    }
  }

  return [...resultIds];
}

export function buildTaskTombstoneTimestamps(
  tasks: Task[],
  taskIds: readonly string[],
): Record<string, string> {
  const taskIdSet = new Set(taskIds);
  return Object.fromEntries(
    tasks
      .filter(task => taskIdSet.has(task.id))
      .map(task => [task.id, task.deletedAt ?? task.updatedAt ?? new Date().toISOString()]),
  );
}
