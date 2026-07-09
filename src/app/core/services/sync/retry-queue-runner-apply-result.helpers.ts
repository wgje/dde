import type {
  RetryQueueItem,
  RetryQueueItemProcessResult,
  RetryQueueSliceRuntime,
} from './retry-queue.types';

export interface PersistTerminalRetryQueueRemovalOptions {
  runtime: RetryQueueSliceRuntime;
  item: RetryQueueItem;
  reason: string;
  warn: (message: string, data?: unknown) => void;
  persistTerminalRetryEvidence: (
    item: RetryQueueItem,
    reason: string,
  ) => Promise<boolean>;
  failureMessage: string;
  failureDetails: Record<string, unknown>;
  incrementExceededCount?: boolean;
}

export async function persistTerminalRetryQueueRemoval(
  options: PersistTerminalRetryQueueRemovalOptions,
): Promise<RetryQueueItemProcessResult> {
  const {
    runtime,
    item,
    reason,
    warn,
    persistTerminalRetryEvidence,
    failureMessage,
    failureDetails,
    incrementExceededCount = false,
  } = options;

  if (!await persistTerminalRetryEvidence(item, reason)) {
    warn(failureMessage, failureDetails);
    runtime.stoppedByBudget = true;
    return 'break';
  }

  runtime.processedIds.add(item.id);
  if (incrementExceededCount) {
    runtime.exceededCount++;
  }
  runtime.hadTerminalRemoval = true;
  return 'continue';
}
