import type { EnhancedError } from '../../../../utils/supabase-error';
import type { RetryQueueLastFailure } from './retry-queue.service';

export function createRetryQueueLastFailure(
  error: EnhancedError,
  recordedAt = Date.now(),
): RetryQueueLastFailure | undefined {
  if (error.remoteOutcome !== 'unknown') {
    return undefined;
  }

  return {
    errorType: error.errorType,
    message: error.message,
    remoteOutcome: error.remoteOutcome,
    recordedAt,
  };
}
