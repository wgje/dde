import { UNDO_CONFIG } from '../config';
import type { Project, UndoAction } from '../models';

export type UndoTaskField = 'title' | 'content';

export interface PersistedUndoData {
  version: number;
  timestamp: string;
  projectId: string;
  undoStack: UndoAction[];
  undoLimitNotificationLocked?: boolean;
}

export type UndoVersionConflictResult =
  | 'version-mismatch'
  | { type: 'version-mismatch-forceable'; action: UndoAction; versionDiff: number };

export function limitStackForMax(stack: UndoAction[], maxSize: number): {
  stack: UndoAction[];
  truncatedCount: number;
} {
  if (stack.length <= maxSize) {
    return { stack, truncatedCount: 0 };
  }

  return {
    stack: stack.slice(-maxSize),
    truncatedCount: stack.length - maxSize,
  };
}

export function resolveUndoVersionConflict(
  action: UndoAction,
  currentProjectVersion?: number,
): UndoVersionConflictResult | null {
  if (
    currentProjectVersion === undefined
    || currentProjectVersion === null
    || action.projectVersion === undefined
    || action.projectVersion === null
  ) {
    return null;
  }

  const versionDiff = currentProjectVersion - action.projectVersion;
  if (versionDiff > UNDO_CONFIG.VERSION_TOLERANCE * 2) {
    return 'version-mismatch';
  }

  if (versionDiff > UNDO_CONFIG.VERSION_TOLERANCE) {
    return {
      type: 'version-mismatch-forceable',
      action,
      versionDiff,
    };
  }

  return null;
}

export function hasRedoVersionConflict(action: UndoAction, currentProjectVersion?: number): boolean {
  return currentProjectVersion !== undefined
    && currentProjectVersion !== null
    && action.projectVersion !== undefined
    && action.projectVersion !== null
    && currentProjectVersion > action.projectVersion + UNDO_CONFIG.VERSION_TOLERANCE;
}

export function collectTaskFieldChanges(
  appliedSnapshot: Partial<Project>,
  previousSnapshot?: Partial<Project>,
): Readonly<Record<string, readonly UndoTaskField[]>> {
  const appliedTasks = new Map((appliedSnapshot.tasks ?? []).map(task => [task.id, task]));
  const previousTasks = new Map((previousSnapshot?.tasks ?? []).map(task => [task.id, task]));
  const taskIds = new Set([...appliedTasks.keys(), ...previousTasks.keys()]);
  const changes: Record<string, UndoTaskField[]> = {};

  for (const taskId of taskIds) {
    const appliedTask = appliedTasks.get(taskId);
    const previousTask = previousTasks.get(taskId);
    const changedFields: UndoTaskField[] = [];

    if ((appliedTask?.title ?? '') !== (previousTask?.title ?? '')) {
      changedFields.push('title');
    }
    if ((appliedTask?.content ?? '') !== (previousTask?.content ?? '')) {
      changedFields.push('content');
    }

    if (changedFields.length > 0) {
      changes[taskId] = changedFields;
    }
  }

  return changes;
}

export function hasProjectTaskSnapshotChanges(
  beforeSnapshot: Partial<Project>,
  afterSnapshot: Partial<Project>,
): boolean {
  const beforeTasks = beforeSnapshot.tasks;
  const afterTasks = afterSnapshot.tasks;

  if (!beforeTasks || !afterTasks || beforeTasks.length !== afterTasks.length) {
    return true;
  }

  const afterTaskMap = new Map(afterTasks.map(task => [task.id, task] as const));
  return beforeTasks.some(before => {
    const after = afterTaskMap.get(before.id);
    if (!after) return true;

    return Math.abs((before.x ?? 0) - (after.x ?? 0)) > 1
      || Math.abs((before.y ?? 0) - (after.y ?? 0)) > 1
      || before.title !== after.title
      || before.content !== after.content
      || before.stage !== after.stage
      || before.parentId !== after.parentId
      || before.status !== after.status;
  });
}

export function createProjectUndoSnapshot(project: Project): Partial<Project> {
  return {
    id: project.id,
    tasks: project.tasks.map(task => ({
      ...task,
      attachments: task.attachments ? task.attachments.map(attachment => ({ ...attachment })) : undefined,
      deletedConnections: task.deletedConnections ? task.deletedConnections.map(connection => ({ ...connection })) : undefined,
      tags: task.tags ? [...task.tags] : undefined,
    })),
    connections: project.connections.map(connection => ({ ...connection })),
  };
}

export function serializeUndoAction(action: UndoAction): UndoAction {
  return JSON.parse(JSON.stringify(action)) as UndoAction;
}

export function deserializeUndoAction(data: unknown): UndoAction | null {
  if (!data || typeof data !== 'object') return null;

  const action = data as Record<string, unknown>;
  if (
    typeof action['type'] !== 'string'
    || typeof action['projectId'] !== 'string'
    || typeof action['timestamp'] !== 'number'
  ) {
    return null;
  }

  return action as unknown as UndoAction;
}

export function selectUndoActionsForPersistence(
  undoStack: readonly UndoAction[],
  limits: { historyLimit: number; persistedLimit: number },
): UndoAction[] {
  return undoStack
    .slice(-limits.historyLimit)
    .slice(-limits.persistedLimit);
}

export function filterRestorableUndoActions(items: readonly unknown[]): UndoAction[] {
  return items
    .map(item => deserializeUndoAction(item))
    .filter((item): item is UndoAction => item !== null);
}

export function isUndoActionInvolvingTask(
  action: UndoAction,
  projectId: string,
  taskId: string,
): boolean {
  if (action.projectId !== projectId) return false;

  const beforeTasks = action.data.before?.tasks as Array<{ id: string }> | undefined;
  const afterTasks = action.data.after?.tasks as Array<{ id: string }> | undefined;
  return beforeTasks?.some(task => task.id === taskId) === true
    || afterTasks?.some(task => task.id === taskId) === true;
}

export function filterUndoActionsExcludingTask(
  actions: readonly UndoAction[],
  taskId: string,
  projectId: string,
): UndoAction[] {
  return actions.filter(action => !isUndoActionInvolvingTask(action, projectId, taskId));
}
