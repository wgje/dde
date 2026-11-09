import type { Connection, Task } from '../models';
import type { ChangeRecord, ProjectChangeBuckets } from './change-tracker.types';

interface InvalidConnectionDeleteContext {
  record: ChangeRecord;
  recordKey: string;
}

export function collectProjectChangeBuckets(
  projectId: string,
  pendingChanges: ReadonlyMap<string, ChangeRecord>,
  onInvalidConnectionDelete?: (context: InvalidConnectionDeleteContext) => void,
): ProjectChangeBuckets {
  const buckets = createProjectChangeBuckets();

  pendingChanges.forEach((record, recordKey) => {
    if (record.projectId !== projectId) return;
    if (record.entityType === 'task') {
      addTaskChangeToBuckets(record, buckets);
      return;
    }

    addConnectionChangeToBuckets(record, recordKey, buckets, onInvalidConnectionDelete);
  });

  return buckets;
}

function createProjectChangeBuckets(): ProjectChangeBuckets {
  return {
    tasksToCreate: [],
    tasksToUpdate: [],
    taskIdsToDelete: [],
    taskDeleteBaseUpdatedAtMap: {},
    connectionsToCreate: [],
    connectionsToUpdate: [],
    connectionsToDelete: [],
    invalidConnectionDeleteKeys: [],
    taskUpdateFieldsById: {},
  };
}

function addTaskChangeToBuckets(record: ChangeRecord, buckets: ProjectChangeBuckets): void {
  switch (record.changeType) {
    case 'create':
      if (record.data) buckets.tasksToCreate.push(record.data as Task);
      break;
    case 'update':
      if (record.data) {
        buckets.tasksToUpdate.push(record.data as Task);
        buckets.taskUpdateFieldsById[record.entityId] = record.changedFields;
      }
      break;
    case 'delete':
      buckets.taskIdsToDelete.push(record.entityId);
      addTaskDeleteBaseUpdatedAtToBuckets(record, buckets);
      break;
  }
}

function addTaskDeleteBaseUpdatedAtToBuckets(record: ChangeRecord, buckets: ProjectChangeBuckets): void {
  const task = record.data as Partial<Task> | undefined;
  if (typeof task?.updatedAt === 'string' && task.updatedAt.length > 0) {
    buckets.taskDeleteBaseUpdatedAtMap[record.entityId] = task.updatedAt;
  }
}

function addConnectionChangeToBuckets(
  record: ChangeRecord,
  recordKey: string,
  buckets: ProjectChangeBuckets,
  onInvalidConnectionDelete: ((context: InvalidConnectionDeleteContext) => void) | undefined,
): void {
  switch (record.changeType) {
    case 'create':
      if (record.data) buckets.connectionsToCreate.push(record.data as Connection);
      break;
    case 'update':
      if (record.data) buckets.connectionsToUpdate.push(record.data as Connection);
      break;
    case 'delete':
      addConnectionDeleteToBuckets(record, recordKey, buckets, onInvalidConnectionDelete);
      break;
  }
}

function addConnectionDeleteToBuckets(
  record: ChangeRecord,
  recordKey: string,
  buckets: ProjectChangeBuckets,
  onInvalidConnectionDelete: ((context: InvalidConnectionDeleteContext) => void) | undefined,
): void {
  const conn = record.data as Partial<Connection> | undefined;
  if (conn?.id && conn.source && conn.target) {
    buckets.connectionsToDelete.push({
      id: conn.id,
      source: conn.source,
      target: conn.target,
    });
    return;
  }

  buckets.invalidConnectionDeleteKeys.push(recordKey);
  onInvalidConnectionDelete?.({ record, recordKey });
}
