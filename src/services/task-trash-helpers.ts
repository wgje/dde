import { Connection, Project, Task } from '../models';

export interface TrashDeletedTaskMeta {
  parentId: string | null;
  stage: number | null;
  order: number;
  rank: number;
  x: number;
  y: number;
  parkingMeta?: import('../models/parking').TaskParkingMeta | null;
}

export interface TrashRestoreMutationOptions {
  idsToRestore: Set<string>;
  now: string;
  project: Project;
  rebalance: (project: Project) => Project;
  savedConnections: Connection[];
}

export interface TrashRestoreMutationResult {
  project: Project;
  restoredConnectionIds: string[];
}

export class TrashRestoreIntegrityError extends Error {
  readonly code = 'TRASH_RESTORE_MISSING_DELETED_META';

  constructor(readonly taskIds: string[]) {
    super(`Cannot restore tasks with missing deletedMeta: ${taskIds.join(', ')}`);
    this.name = 'TrashRestoreIntegrityError';
  }
}

export function createTrashTaskMap(tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((task) => [task.id, task] as const));
}

export function buildTrashChildrenByParent(
  tasks: Task[],
  includeDeletedTasks: boolean,
): Map<string, Task[]> {
  const childrenByParent = new Map<string, Task[]>();

  for (const task of tasks) {
    if (!includeDeletedTasks && task.deletedAt) continue;
    if (!task.parentId) continue;

    const children = childrenByParent.get(task.parentId) ?? [];
    children.push(task);
    childrenByParent.set(task.parentId, children);
  }

  return childrenByParent;
}

export function normalizeTrashActiveTaskIds(
  explicitIds: string[],
  tasksById: Map<string, Task>,
): string[] {
  const seen = new Set<string>();
  const normalizedIds: string[] = [];

  for (const id of explicitIds) {
    if (seen.has(id)) continue;

    const task = tasksById.get(id);
    if (!task || task.deletedAt) continue;

    seen.add(id);
    normalizedIds.push(id);
  }

  return normalizedIds;
}

export function collectTrashCascadeTaskIds(
  rootIds: string[],
  tasksById: Map<string, Task>,
  childrenByParent: Map<string, Task[]>,
): Set<string> {
  const idsToCollect = new Set<string>();
  const stack = [...rootIds];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || idsToCollect.has(currentId)) continue;

    const currentTask = tasksById.get(currentId);
    if (!currentTask || currentTask.deletedAt) continue;

    idsToCollect.add(currentId);
    for (const childTask of childrenByParent.get(currentId) ?? []) {
      stack.push(childTask.id);
    }
  }

  return idsToCollect;
}

export function collectTrashSubtreeIds(
  rootId: string,
  childrenByParent: Map<string, Task[]>,
): Set<string> {
  const idsToCollect = new Set<string>();
  const stack = [rootId];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || idsToCollect.has(currentId)) continue;

    idsToCollect.add(currentId);
    for (const childTask of childrenByParent.get(currentId) ?? []) {
      stack.push(childTask.id);
    }
  }

  return idsToCollect;
}

export function groupTrashConnectionsByTaskId(connections: Connection[]): Map<string, Connection[]> {
  const connectionsByTaskId = new Map<string, Connection[]>();

  for (const connection of connections) {
    for (const taskId of [connection.source, connection.target]) {
      const taskConnections = connectionsByTaskId.get(taskId) ?? [];
      taskConnections.push(connection);
      connectionsByTaskId.set(taskId, taskConnections);
    }
  }

  return connectionsByTaskId;
}

export function collectTrashSavedConnections(
  tasks: Task[],
  idsToRestore: Set<string>,
): Connection[] {
  const connectionsById = new Map<string, Connection>();

  for (const task of tasks) {
    if (!idsToRestore.has(task.id)) continue;

    for (const connection of task.deletedConnections ?? []) {
      connectionsById.set(connection.id, connection);
    }
  }

  return [...connectionsById.values()];
}

export function collectTrashRestoreTaskIds(taskId: string, tasks: Task[]): Set<string> {
  const tasksById = createTrashTaskMap(tasks);
  const childrenByParent = buildTrashChildrenByParent(tasks, true);
  const idsToRestore = new Set<string>();
  const stack = [taskId];

  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || idsToRestore.has(id)) continue;

    idsToRestore.add(id);
    for (const childTask of childrenByParent.get(id) ?? []) {
      if (tasksById.has(childTask.id)) {
        stack.push(childTask.id);
      }
    }
  }

  return idsToRestore;
}

export function applyTrashRestoreMutation(
  options: TrashRestoreMutationOptions,
): TrashRestoreMutationResult {
  const missingMetadataTaskIds = collectTrashRestoreMissingMetadataTaskIds(
    options.project.tasks,
    options.idsToRestore,
  );
  if (missingMetadataTaskIds.size > 0) {
    throw new TrashRestoreIntegrityError([...missingMetadataTaskIds]);
  }

  const restoredDraftById = createRestoredDrafts(
    options.project.tasks,
    options.idsToRestore,
    options.now,
  );
  reconcileRestoredParentLinks(
    restoredDraftById,
    options.project.tasks,
    options.idsToRestore,
  );
  const restoredTasks = applyRestoredDrafts(
    options.project.tasks,
    options.idsToRestore,
    restoredDraftById,
    options.now,
  );
  const connectionsToRestore = findConnectionsToRestore(
    options.project.connections,
    restoredTasks,
    options.savedConnections,
  );

  return {
    restoredConnectionIds: connectionsToRestore.map(connection => connection.id),
    project: options.rebalance({
      ...options.project,
      tasks: restoredTasks,
      connections: [...options.project.connections, ...connectionsToRestore],
    }),
  };
}

export function collectTrashRestoreMissingMetadataTaskIds(
  tasks: Task[],
  idsToRestore: ReadonlySet<string>,
): Set<string> {
  const missingTaskIds = new Set<string>();
  for (const task of tasks) {
    if (idsToRestore.has(task.id) && !hasCompleteTrashDeletedTaskMeta(task.deletedMeta)) {
      missingTaskIds.add(task.id);
    }
  }
  return missingTaskIds;
}

export function hasCompleteTrashDeletedTaskMeta(meta: Task['deletedMeta']): meta is TrashDeletedTaskMeta {
  if (!meta || typeof meta !== 'object') return false;

  return Object.prototype.hasOwnProperty.call(meta, 'parentId')
    && (meta.parentId === null || typeof meta.parentId === 'string')
    && Object.prototype.hasOwnProperty.call(meta, 'stage')
    && (meta.stage === null || Number.isFinite(meta.stage))
    && Number.isFinite(meta.order)
    && Number.isFinite(meta.rank)
    && Number.isFinite(meta.x)
    && Number.isFinite(meta.y);
}

function createRestoredTaskDraft(task: Task, now: string): Task {
  const meta = task.deletedMeta as TrashDeletedTaskMeta | undefined;
  const { deletedConnections: _deletedConnections, deletedMeta: _deletedMeta, ...rest } = task;
  const restoredTask: Task = meta
    ? {
        ...rest,
        deletedAt: null,
        updatedAt: now,
        parentId: meta.parentId,
        stage: meta.stage,
        order: meta.order,
        rank: meta.rank,
        x: meta.x,
        y: meta.y,
        parkingMeta: meta.parkingMeta ?? rest.parkingMeta ?? null,
      }
    : { ...rest, deletedAt: null, updatedAt: now };

  return ensureRestoredTaskHasRequiredText(restoredTask);
}

function ensureRestoredTaskHasRequiredText(task: Task): Task {
  if ((task.title && task.title.trim() !== '') || (task.content && task.content.trim() !== '')) {
    return task;
  }

  return { ...task, title: '新任务' };
}

function createRestoredDrafts(
  tasks: Task[],
  idsToRestore: Set<string>,
  now: string,
): Map<string, Task> {
  const restoredDraftById = new Map<string, Task>();

  for (const task of tasks) {
    if (idsToRestore.has(task.id)) {
      restoredDraftById.set(task.id, createRestoredTaskDraft(task, now));
    }
  }

  return restoredDraftById;
}

function reconcileRestoredParentLinks(
  restoredDraftById: Map<string, Task>,
  tasks: Task[],
  idsToRestore: Set<string>,
): void {
  for (const [id, restoredTask] of restoredDraftById.entries()) {
    const parentId = restoredTask.parentId;
    if (!parentId || hasRestorableParent(parentId, restoredDraftById, tasks, idsToRestore)) {
      continue;
    }

    restoredDraftById.set(id, {
      ...restoredTask,
      parentId: null,
      stage: restoredTask.stage ?? 1,
    });
  }
}

function hasRestorableParent(
  parentId: string,
  restoredDraftById: Map<string, Task>,
  tasks: Task[],
  idsToRestore: Set<string>,
): boolean {
  if (restoredDraftById.has(parentId)) {
    return true;
  }

  return tasks.some(
    candidate => candidate.id === parentId
      && !candidate.deletedAt
      && !idsToRestore.has(candidate.id),
  );
}

function applyRestoredDrafts(
  tasks: Task[],
  idsToRestore: Set<string>,
  restoredDraftById: Map<string, Task>,
  now: string,
): Task[] {
  return tasks.map(task => {
    if (!idsToRestore.has(task.id)) return task;
    return restoredDraftById.get(task.id) ?? { ...task, deletedAt: null, updatedAt: now };
  });
}

function findConnectionsToRestore(
  existingConnections: Connection[],
  restoredTasks: Task[],
  savedConnections: Connection[],
): Connection[] {
  const existingConnKeys = new Set(
    existingConnections.map(connection => `${connection.source}->${connection.target}`),
  );
  const activeOrRestoredTaskIds = new Set(
    restoredTasks
      .filter(task => !task.deletedAt)
      .map(task => task.id),
  );

  return savedConnections.filter(
    connection => !existingConnKeys.has(`${connection.source}->${connection.target}`)
      && activeOrRestoredTaskIds.has(connection.source)
      && activeOrRestoredTaskIds.has(connection.target),
  );
}
