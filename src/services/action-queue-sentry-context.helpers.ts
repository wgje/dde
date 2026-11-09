import type { CategoryLogger } from './logger.service';
import type { SentryAlertService } from './sentry-alert.service';
import { buildActionQueueSentryContext } from './action-queue-state.helpers';

interface SyncActionQueueSentryContextOptions {
  queueLength: number;
  deadLetterCount: number;
  sentryAlert: Pick<SentryAlertService, 'updateSyncContext'>;
  logger: Pick<CategoryLogger, 'warn'>;
}

export function syncActionQueueSentryContext(options: SyncActionQueueSentryContextOptions): void {
  try {
    options.sentryAlert.updateSyncContext(buildActionQueueSentryContext({
      queueLength: options.queueLength,
      deadLetterCount: options.deadLetterCount,
    }));
  } catch (error) {
    options.logger.warn('ActionQueue Sentry context sync failed', error);
  }
}
