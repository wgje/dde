import type { RetryableEntityType } from '../core-bridge';
import type { EnqueueParams, QueuedAction } from './action-queue.types';
import type { EnqueueMutationResult } from './action-queue-enqueue-mutation.service';

export interface ActionQueueSentryContext {
  actionQueueLength: number;
  pendingActions: number;
  deadLetterCount: number;
}

export interface DurableEnqueueMutationOutcome {
  persistedQueue: QueuedAction[] | null;
  mutation: EnqueueMutationResult | null;
}

const RETRYABLE_ENTITY_TYPES: ReadonlySet<string> = new Set<string>([
  'task',
  'project',
  'connection',
  'attachment',
  'blackbox',
]);

export function isActionQueueRetryableEntityType(
  entityType: string,
): entityType is RetryableEntityType {
  return RETRYABLE_ENTITY_TYPES.has(entityType);
}

export function buildActionQueueSentryContext(input: {
  queueLength: number;
  deadLetterCount: number;
}): ActionQueueSentryContext {
  return {
    actionQueueLength: input.queueLength,
    pendingActions: input.queueLength,
    deadLetterCount: input.deadLetterCount,
  };
}

export function buildActionEnqueuedBreadcrumb(input: {
  action: EnqueueParams;
  queuedAction: QueuedAction;
  resolvedActionId: string;
  queueSize: number;
}): Record<string, unknown> {
  return {
    category: 'sync',
    message: `Action enqueued: ${input.action.type} ${input.action.entityType}`,
    level: 'info',
    data: {
      actionId: input.resolvedActionId,
      entityType: input.action.entityType,
      entityId: input.action.entityId,
      type: input.action.type,
      priority: input.queuedAction.priority,
      queueSize: input.queueSize,
    },
  };
}

export function runActionQueueEnqueueSideEffects(input: {
  action: EnqueueParams;
  queuedAction: QueuedAction;
  resolvedActionId: string;
  queueSize: number;
  removeRetrySourceOnSuccess: boolean;
  retryQueue: {
    removeByEntity(entityType: RetryableEntityType, entityId: string): void;
  };
  sentryLazyLoader: {
    addBreadcrumb(breadcrumb: Record<string, unknown>): void;
  };
  warn(message: string, error: unknown): void;
}): void {
  if (
    input.removeRetrySourceOnSuccess
    && isActionQueueRetryableEntityType(input.action.entityType)
  ) {
    input.retryQueue.removeByEntity(input.action.entityType, input.action.entityId);
  }

  try {
    input.sentryLazyLoader.addBreadcrumb(buildActionEnqueuedBreadcrumb(input));
  } catch (error) {
    try {
      input.warn('ActionQueue enqueue breadcrumb failed', error);
    } catch {
      // Observability failures must not turn a completed enqueue into a caller-visible failure.
    }
  }
}
