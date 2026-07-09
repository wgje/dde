import type {
  ConnectionPayload,
  OutboxSyncState,
  QueuedAction,
  TaskDeletePayload,
  TaskPayload,
} from './action-queue.types';
import {
  classifyQueueRetryError,
  LOCAL_QUEUE_CONFIG,
  type QueueRetryError,
} from './action-queue-storage.helpers';
import {
  formatRetryError as formatRetryErrorPure,
  isAuthPendingRetryError as isAuthPendingRetryErrorPure,
  normalizeRetryError as normalizeRetryErrorPure,
} from './action-queue-retry-serialization';

export type FailedActionSettlement = {
  errorMessage: string;
  errorType: ReturnType<typeof classifyQueueRetryError>;
  shouldDeadLetter: boolean;
  syncState: OutboxSyncState;
};

export function createFailedActionSettlement(
  existingAction: QueuedAction,
  error: string | QueueRetryError,
): FailedActionSettlement {
  const normalizedError = normalizeRetryErrorPure(error);
  const errorMessage = formatRetryErrorPure(normalizedError);
  const errorType = classifyQueueRetryError(normalizedError);

  return {
    errorMessage,
    errorType,
    shouldDeadLetter:
      errorType === 'business'
      || errorType === 'permission'
      || (errorType !== 'deferred' && existingAction.retryCount >= LOCAL_QUEUE_CONFIG.MAX_RETRIES),
    syncState: errorType === 'deferred' && isAuthPendingRetryErrorPure(normalizedError)
      ? 'blocked_by_auth'
      : 'retry_scheduled',
  };
}

export function buildFailedActionRetryQueue(
  queue: QueuedAction[],
  actionId: string,
  settlement: FailedActionSettlement,
): QueuedAction[] {
  return queue.map(item => item.id === actionId
    ? {
        ...item,
        retryCount:
          settlement.errorType === 'deferred'
            ? item.retryCount
            : item.retryCount + 1,
        lastError: settlement.errorMessage,
        errorType: settlement.errorType,
        syncState: settlement.syncState,
      }
    : item
  );
}

export function shouldKeepAfterProjectDeleteSettlement(
  action: QueuedAction,
  projectId: string,
  actionId?: string,
): boolean {
  if (actionId && action.id === actionId) {
    return false;
  }

  if (action.entityType === 'project' && action.entityId === projectId) {
    return false;
  }

  if (action.entityType === 'task') {
    const payload = action.payload as TaskPayload | TaskDeletePayload;
    return payload.projectId !== projectId;
  }

  if (action.entityType === 'connection') {
    const payload = action.payload as ConnectionPayload;
    return payload.projectId !== projectId;
  }

  return true;
}
