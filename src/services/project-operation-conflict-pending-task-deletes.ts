import type { TaskDeleteBaseUpdatedAtMap } from './action-queue.types';
import type { Project } from '../models';
import type {
  ProjectConflictSnapshot,
  ResolveConflictInternalOptions,
} from './project-operation-conflict.types';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';

export interface PendingTaskDeleteSource {
  pendingTaskDeleteIds?: string[];
  pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
}

export function resolveEffectivePendingTaskDeleteIds(
  options: Pick<ResolveConflictInternalOptions, 'preservePendingTaskDeletes' | 'filterPendingTaskDeletes'>,
  conflictData: ProjectConflictSnapshot,
  storedConflict: PendingTaskDeleteSource | null | undefined,
): string[] {
  if (!options.preservePendingTaskDeletes) return [];

  const pendingTaskDeleteIds = [...new Set([
    ...(conflictData?.pendingTaskDeleteIds ?? []),
    ...(storedConflict?.pendingTaskDeleteIds ?? []),
  ].filter(taskId => typeof taskId === 'string' && taskId.length > 0))];
  return options.filterPendingTaskDeletes
    ? options.filterPendingTaskDeletes(pendingTaskDeleteIds)
    : pendingTaskDeleteIds;
}

export function resolveEffectivePendingTaskDeleteBaseUpdatedAtMap(
  conflictData: ProjectConflictSnapshot,
  storedConflict: PendingTaskDeleteSource | null | undefined,
  pendingTaskDeleteIds: string[],
): TaskDeleteBaseUpdatedAtMap | undefined {
  const sourceMap = {
    ...(storedConflict?.pendingTaskDeleteBaseUpdatedAtMap ?? {}),
    ...(conflictData?.pendingTaskDeleteBaseUpdatedAtMap ?? {}),
  };
  const picked: TaskDeleteBaseUpdatedAtMap = {};
  for (const taskId of pendingTaskDeleteIds) {
    if (Object.prototype.hasOwnProperty.call(sourceMap, taskId)) {
      picked[taskId] = sourceMap[taskId] ?? null;
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

export function createPendingTaskDeleteOperationId(
  project: Pick<Project, 'id' | 'version' | 'updatedAt'>,
  taskId: string,
  ownerUserId: string | null,
  baseUpdatedAt: string | null | undefined,
): string {
  return createDerivedSyncOperationId([
    project.id,
    ownerUserId ?? 'local-owner',
    String(project.version ?? 'no-version'),
    project.updatedAt ?? 'no-project-updated-at',
    taskId,
    baseUpdatedAt ?? 'no-base-updated-at',
  ].join('\u0000'), 'conflict-pending-task-delete');
}
