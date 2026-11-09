import type { DeadLetterItem, OutboxSyncState, QueuedAction } from './action-queue.types';
import {
  appendCappedDeadLetterItem,
  classifyQueueRetryError,
  LOCAL_QUEUE_CONFIG,
  type QueueRetryError,
} from './action-queue-storage.helpers';
import { buildDeadLetterItem } from './action-queue-storage-dead-letter-transition.helpers';
import {
  authorizeDeadLetterHandoffDurably,
  isDeadLetterHandoffAuthorized,
} from './action-queue-held-action.controller';
import type { ActionQueueDurableRetrySettlementResult } from './action-queue-retry-settlement.controller';

export type QueuedActionSkipReason =
  | 'missing-current-action'
  | 'held'
  | 'failed-create'
  | 'pending-create';

export interface QueuedActionSkipDecision {
  shouldSkip: boolean;
  reason: QueuedActionSkipReason | null;
  entityKey: string;
}

export interface ActionQueueProcessingMutationRuntime {
  updatePendingActions: (updater: (queue: QueuedAction[]) => QueuedAction[]) => void;
  getDeadLetters: () => DeadLetterItem[];
  updateDeadLetters: (updater: (queue: DeadLetterItem[]) => DeadLetterItem[]) => void;
  setDeadLetterSize: (size: number) => void;
  saveQueue: () => void;
  saveDeadLetters: () => boolean;
  syncSentryContext: () => void;
  getCurrentOwnerUserId: () => string;
  persistQueueMutationForOwner: (
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ) => Promise<QueuedAction[] | null>;
  settleRetry: (
    action: QueuedAction,
    error: string | QueueRetryError,
  ) => Promise<ActionQueueDurableRetrySettlementResult>;
  freezeQueueWrites: () => void;
  warn: (message: string, context: unknown) => void;
  warnSafely: (message: string, context: unknown) => void;
}

export function markQueuedActionSyncState(
  actionId: string,
  syncState: OutboxSyncState,
  runtime: ActionQueueProcessingMutationRuntime,
): QueuedAction | null {
  let updatedAction: QueuedAction | null = null;
  runtime.updatePendingActions(queue => queue.map(action => {
    if (action.id !== actionId) return action;
    updatedAction = { ...action, syncState };
    return updatedAction;
  }));
  if (updatedAction) {
    runtime.saveQueue();
    runtime.syncSentryContext();
  }
  return updatedAction;
}

export function stageQueuedActionDeadLetter(
  action: QueuedAction,
  reason: string,
  runtime: ActionQueueProcessingMutationRuntime,
): DeadLetterItem | null {
  if (!isDeadLetterHandoffAuthorized(action)) {
    runtime.warnSafely('拒绝在 durable handoff 完成并授权前写入 dead-letter', {
      actionId: action.id,
      operationId: action.operationId,
    });
    return null;
  }
  let deadLetterItem = runtime.getDeadLetters().find(item => item.action.id === action.id
    && item.action.operationId === action.operationId);
  if (!deadLetterItem) {
    deadLetterItem = buildDeadLetterItem(action, reason, () => new Date().toISOString());
    const item = deadLetterItem;
    runtime.updateDeadLetters(queue => {
      const result = appendCappedDeadLetterItem(queue, item);
      if (result.overflow > 0) {
        runtime.warn('死信队列超出上限，移除最旧的条目', {
          overflow: result.overflow,
          maxSize: LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE,
        });
      }
      return result.queue;
    });
  }
  runtime.setDeadLetterSize(runtime.getDeadLetters().length);
  const persisted = runtime.saveDeadLetters();
  runtime.syncSentryContext();
  if (!persisted) {
    runtime.warn('死信队列持久化失败，保留 pending action 等待恢复重试', {
      actionId: action.id,
      reason,
    });
    return null;
  }
  return deadLetterItem;
}

export async function handleQueuedActionRetryDurably(
  action: QueuedAction,
  error: string | QueueRetryError,
  runtime: ActionQueueProcessingMutationRuntime,
): Promise<ActionQueueDurableRetrySettlementResult> {
  const errorType = classifyQueueRetryError(error);
  const terminal = errorType === 'business'
    || errorType === 'permission'
    || (errorType !== 'deferred' && action.retryCount >= LOCAL_QUEUE_CONFIG.MAX_RETRIES);
  let settlementAction = action;
  if (terminal && action.localHandoff !== undefined) {
    try {
      settlementAction = await authorizeDeadLetterHandoffDurably({
        ownerUserId: runtime.getCurrentOwnerUserId(),
        action,
        authorizedAt: new Date().toISOString(),
        persistQueueMutationForOwner: runtime.persistQueueMutationForOwner,
      });
    } catch (authorizationError) {
      runtime.warnSafely('ActionQueue dead-letter durable 授权失败，保留 pending evidence', {
        actionId: action.id,
        authorizationError,
      });
      runtime.freezeQueueWrites();
      return 'persistence-failed';
    }
  }
  return runtime.settleRetry(settlementAction, error);
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

  if (input.action.syncState === 'held') {
    return { shouldSkip: true, reason: 'held', entityKey };
  }

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
