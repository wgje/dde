import { retryOperationIdMatches } from './action-queue-retry-operation-id.helpers';

export { retryOperationIdMatches };

export interface DeferredEntityActionLike {
  entityId?: unknown;
  id?: unknown;
  entityType?: unknown;
  type?: unknown;
}

export interface TaskRetryItem {
  operation?: unknown;
  projectId?: unknown;
  data?: unknown;
  sourceUserId?: unknown;
  operationId?: unknown;
}

export interface TaskUpsertRetryPayloadLike {
  task: {
    id: string;
  };
  projectId: string;
  sourceUserId?: string | null;
}

export interface TaskDeleteRetryPayloadLike {
  taskId: string;
  projectId: string;
  sourceUserId?: string | null;
}

export function resolveDeferredEntityId(
  action: DeferredEntityActionLike,
  ...candidates: unknown[]
): string {
  const explicitEntityId = candidates.find((candidate): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0
  );
  if (explicitEntityId) {
    return explicitEntityId;
  }

  if (typeof action.entityId === 'string' && action.entityId.length > 0) {
    return action.entityId;
  }
  if (typeof action.id === 'string' && action.id.length > 0) {
    return action.id;
  }

  return `${String(action.entityType ?? 'unknown')}:${String(action.type ?? 'unknown')}`;
}

export function buildTaskRetryPayloadSignature(
  task: unknown,
  projectId: unknown,
  sourceUserId: unknown,
): string {
  return JSON.stringify({
    task,
    projectId: typeof projectId === 'string' ? projectId : null,
    sourceUserId: typeof sourceUserId === 'string' ? sourceUserId : null,
  });
}

export function wasTaskUpsertTransferredToRetryQueue(
  retryItem: TaskRetryItem | undefined,
  payload: TaskUpsertRetryPayloadLike,
  operationId?: string,
): boolean {
  if (!retryItem || retryItem.operation !== 'upsert' || retryItem.projectId !== payload.projectId) {
    return false;
  }
  if (!retryOperationIdMatches(retryItem, operationId)) {
    return false;
  }

  return buildTaskRetryPayloadSignature(retryItem.data, retryItem.projectId, retryItem.sourceUserId)
    === buildTaskRetryPayloadSignature(payload.task, payload.projectId, payload.sourceUserId);
}

export function wasTaskDeleteTransferredToRetryQueue(
  retryItem: TaskRetryItem | undefined,
  payload: TaskDeleteRetryPayloadLike,
  operationId?: string,
): boolean {
  return retryItem?.operation === 'delete'
    && retryItem.projectId === payload.projectId
    && retryOperationIdMatches(retryItem, operationId);
}
