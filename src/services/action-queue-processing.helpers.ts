import type { QueuedAction } from './action-queue.types';

export type QueuedActionSkipReason =
  | 'missing-current-action'
  | 'failed-create'
  | 'pending-create';

export interface QueuedActionSkipDecision {
  shouldSkip: boolean;
  reason: QueuedActionSkipReason | null;
  entityKey: string;
}

export function getActionEntityKey(action: Pick<QueuedAction, 'entityType' | 'entityId'>): string {
  return `${action.entityType}:${action.entityId}`;
}

export function getQueuedActionSkipDecision(input: {
  action: QueuedAction;
  currentPendingActions: readonly QueuedAction[];
  processQueueSnapshot: readonly QueuedAction[];
  failedCreateEntities: ReadonlySet<string>;
}): QueuedActionSkipDecision {
  const entityKey = getActionEntityKey(input.action);

  if (!input.currentPendingActions.some(action => action.id === input.action.id)) {
    return { shouldSkip: true, reason: 'missing-current-action', entityKey };
  }

  if (input.action.type !== 'create' && input.failedCreateEntities.has(entityKey)) {
    return { shouldSkip: true, reason: 'failed-create', entityKey };
  }

  if (input.action.type === 'create') {
    return { shouldSkip: false, reason: null, entityKey };
  }

  const hasUnprocessedCreate = input.processQueueSnapshot.some(action =>
    action.entityType === input.action.entityType
    && action.entityId === input.action.entityId
    && action.type === 'create'
    && action.id !== input.action.id
  );

  return hasUnprocessedCreate
    ? { shouldSkip: true, reason: 'pending-create', entityKey }
    : { shouldSkip: false, reason: null, entityKey };
}
