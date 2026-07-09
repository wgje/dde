import type { BlackBoxEntry, Connection, Project, Task } from '../../../../models';
import type {
  RetryOperationHandler,
  RetryQueueItem,
  RetryTaskDeleteData,
} from './retry-queue.types';

export function pushRetryQueueItem(
  operationHandler: RetryOperationHandler,
  item: RetryQueueItem,
): Promise<boolean> {
  if (item.type === 'task') {
    return item.operation === 'upsert'
      ? pushTaskRetryItem(operationHandler, item)
      : deleteTaskRetryItem(operationHandler, item);
  }

  if (item.type === 'project') {
    return operationHandler.pushProject(
      item.data as Project,
      item.sourceUserId,
      item.taskIdsToDelete,
      item.taskDeleteBaseUpdatedAtMap,
      item.operationId,
    );
  }

  if (item.type === 'connection') {
    return operationHandler.pushConnection(item.data as Connection, item.projectId!, item.sourceUserId, item.operationId);
  }

  if (item.type === 'blackbox' && operationHandler.pushBlackBoxEntry) {
    return operationHandler.pushBlackBoxEntry(item.data as BlackBoxEntry, item.sourceUserId, item.operationId);
  }

  return Promise.resolve(false);
}

function pushTaskRetryItem(
  operationHandler: RetryOperationHandler,
  item: RetryQueueItem,
): Promise<boolean> {
  return operationHandler.pushTask(item.data as Task, item.projectId!, item.sourceUserId, item.writeIntent, item.operationId);
}

function deleteTaskRetryItem(
  operationHandler: RetryOperationHandler,
  item: RetryQueueItem,
): Promise<boolean> {
  return operationHandler.deleteTask(
    item.data.id,
    item.projectId!,
    item.sourceUserId,
    true,
    (item.data as RetryTaskDeleteData).baseUpdatedAt,
    item.operationId,
  );
}
