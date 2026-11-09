import type { Project } from '../models';
import type { TaskDeleteBaseUpdatedAtMap } from './action-queue.types';
import type { ProjectSessionContext } from './project-operation-conflict.types';

type ProjectValidator = (project: Project) => Project;

export function createProjectSessionContext(
  ownerUserId: string | null,
  sessionGeneration: number,
): ProjectSessionContext {
  return { ownerUserId, sessionGeneration };
}

export function canSettleStaleProjectLocally(
  context: ProjectSessionContext,
  currentUserId: string | null,
): boolean {
  return !!context.ownerUserId && context.ownerUserId === currentUserId;
}

export interface ResolvedProjectMergeOptions {
  version?: number;
  pendingSync: boolean;
}

export function mergeResolvedProjectState(
  current: Project,
  project: Project,
  options: ResolvedProjectMergeOptions,
): Project {
  return {
    ...current,
    ...project,
    version: options.version ?? project.version,
    syncSource: 'synced',
    pendingSync: options.pendingSync,
  };
}

export function settleProjectSyncState(
  current: Project,
  options: ResolvedProjectMergeOptions,
): Project {
  return {
    ...current,
    version: options.version ?? current.version,
    syncSource: 'synced',
    pendingSync: options.pendingSync,
  };
}

export function normalizeProjectForConflictComparison(
  project: Project,
  validateAndRebalance: ProjectValidator,
): string {
  return JSON.stringify({
    ...validateAndRebalance(project),
    updatedAt: undefined,
    version: undefined,
    pendingSync: undefined,
    syncSource: undefined,
  });
}

export function removePendingTaskDeletesFromProject(
  project: Project,
  pendingTaskDeleteIds: string[],
  validateAndRebalance: ProjectValidator,
): Project {
  if (pendingTaskDeleteIds.length === 0) {
    return project;
  }

  const deletedTaskIds = new Set(pendingTaskDeleteIds);
  return validateAndRebalance({
    ...project,
    tasks: project.tasks.filter(task => !deletedTaskIds.has(task.id)),
    connections: project.connections.filter(connection =>
      !deletedTaskIds.has(connection.source) && !deletedTaskIds.has(connection.target)
    ),
  });
}

export function pickTaskDeleteBaseUpdatedAtMap(
  taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
  taskIds: string[],
): TaskDeleteBaseUpdatedAtMap | undefined {
  if (!taskDeleteBaseUpdatedAtMap) {
    return undefined;
  }

  const picked: TaskDeleteBaseUpdatedAtMap = {};
  for (const taskId of taskIds) {
    if (Object.prototype.hasOwnProperty.call(taskDeleteBaseUpdatedAtMap, taskId)) {
      picked[taskId] = taskDeleteBaseUpdatedAtMap[taskId] ?? null;
    }
  }

  return Object.keys(picked).length > 0 ? picked : undefined;
}
