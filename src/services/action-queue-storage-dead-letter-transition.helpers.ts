import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import { isSyncOperationId } from '../utils/sync-operation-id';

export function buildDeadLetterRetryAction(
  action: QueuedAction,
  createOperationId: () => QueuedAction['operationId'],
): QueuedAction {
  return {
    ...action,
    operationId: isSyncOperationId(action.operationId)
      ? action.operationId
      : createOperationId(),
    retryCount: 0,
    lastError: undefined,
    errorType: undefined,
    syncState: 'pending_sync',
  };
}

export function upsertDeadLetterRetryAction(queue: QueuedAction[], action: QueuedAction): QueuedAction[] {
  return [...queue.filter(queuedAction => queuedAction.id !== action.id), action];
}

export function buildDeadLetterItem(
  action: QueuedAction,
  reason: string,
  createFailedAt: () => string,
): DeadLetterItem {
  const deadLetterAction: QueuedAction = {
    ...action,
    syncState: 'dead_letter',
  };
  return {
    action: deadLetterAction,
    failedAt: createFailedAt(),
    reason,
  };
}
