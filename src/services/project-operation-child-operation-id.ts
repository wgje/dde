import type { Connection, Task } from '../models';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';

type TaskDeleteBaseUpdatedAtMap = Record<string, string | null | undefined>;

const NO_UPDATED_AT = 'no-updated-at';
const NO_BASE_UPDATED_AT = 'no-base-updated-at';

export function createProjectTaskUpsertOperationId(
  parentOperationId: string,
  projectId: string,
  task: Pick<Task, 'id' | 'updatedAt'>,
): string {
  return createDerivedSyncOperationId(
    parentOperationId,
    `project-task-upsert:${projectId}:${task.id}:${task.updatedAt ?? NO_UPDATED_AT}`,
  );
}

export function createProjectConnectionUpsertOperationId(
  parentOperationId: string,
  projectId: string,
  connection: Pick<Connection, 'id' | 'updatedAt'>,
): string {
  return createDerivedSyncOperationId(
    parentOperationId,
    `project-connection-upsert:${projectId}:${connection.id}:${connection.updatedAt ?? NO_UPDATED_AT}`,
  );
}

export function createProjectTaskDeleteOperationId(
  parentOperationId: string,
  projectId: string,
  taskId: string,
  baseUpdatedAt: string | null | undefined,
): string {
  return createDerivedSyncOperationId(
    parentOperationId,
    `project-task-delete:${projectId}:${describeTaskDelete(taskId, baseUpdatedAt)}`,
  );
}

export function createProjectTaskDeleteBatchOperationId(
  parentOperationId: string,
  projectId: string,
  taskIds: string[],
  baseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
): string {
  return createDerivedSyncOperationId(
    parentOperationId,
    describeTaskDeleteCollection('project-task-delete-batch', projectId, taskIds, baseUpdatedAtMap),
  );
}

export function createProjectTaskDeleteHandoffOperationId(
  parentOperationId: string,
  projectId: string,
  taskIds: string[],
  baseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
): string {
  return createDerivedSyncOperationId(
    parentOperationId,
    describeTaskDeleteCollection('project-task-delete-handoff', projectId, taskIds, baseUpdatedAtMap),
  );
}

function describeTaskDeleteCollection(
  purpose: 'project-task-delete-batch' | 'project-task-delete-handoff',
  projectId: string,
  taskIds: string[],
  baseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
): string {
  return [
    `${purpose}:${projectId}`,
    ...taskIds.map(taskId => describeTaskDelete(taskId, baseUpdatedAtMap?.[taskId])),
  ].join('|');
}

function describeTaskDelete(taskId: string, baseUpdatedAt: string | null | undefined): string {
  return `${taskId}:${baseUpdatedAt ?? NO_BASE_UPDATED_AT}`;
}
