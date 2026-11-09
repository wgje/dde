import type { RetryableEntityType } from '../core-bridge';
import type { CategoryLogger } from './logger.service';
import type { SentryAlertService } from './sentry-alert.service';
import type { EnqueueParams, QueuedAction } from './action-queue.types';
import { runActionQueueEnqueueSideEffects } from './action-queue-state.helpers';
import { syncActionQueueSentryContext } from './action-queue-sentry-context.helpers';

export interface ActionQueueRuntimeSideEffectsOptions {
  getQueueLength: () => number;
  getDeadLetterCount: () => number;
  retryQueue: {
    removeByEntity(entityType: RetryableEntityType, entityId: string): void;
  };
  sentryLazyLoader: {
    addBreadcrumb(breadcrumb: Record<string, unknown>): void;
  };
  sentryAlert: Pick<SentryAlertService, 'updateSyncContext'>;
  logger: Pick<CategoryLogger, 'warn'>;
}

export interface ActionQueueEnqueueSideEffectsInput {
  action: EnqueueParams;
  queuedAction: QueuedAction;
  resolvedActionId: string;
  removeRetrySourceOnSuccess: boolean;
}

export class ActionQueueRuntimeSideEffectsController {
  constructor(private readonly options: ActionQueueRuntimeSideEffectsOptions) {}

  syncSentryContext(): void {
    syncActionQueueSentryContext({
      queueLength: this.options.getQueueLength(),
      deadLetterCount: this.options.getDeadLetterCount(),
      sentryAlert: this.options.sentryAlert,
      logger: this.options.logger,
    });
  }

  runEnqueueSideEffects(input: ActionQueueEnqueueSideEffectsInput): void {
    runActionQueueEnqueueSideEffects({
      ...input,
      queueSize: this.options.getQueueLength(),
      retryQueue: this.options.retryQueue,
      sentryLazyLoader: this.options.sentryLazyLoader,
      warn: (message, error) => this.options.logger.warn(message, error),
    });
  }
}
