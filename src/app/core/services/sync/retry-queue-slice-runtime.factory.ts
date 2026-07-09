import type { LeaseHandle } from '../../../../services/sync-writer-lease.service';
import type {
  RetryOperationHandler,
  RetryQueueItem,
  RetryQueueSliceOptions,
  RetryQueueSliceRuntime,
} from './retry-queue.types';

export interface RetryQueueSliceRuntimeFactoryOptions {
  options: RetryQueueSliceOptions;
  startedAt: number;
  generation: number;
  itemsSnapshot: RetryQueueItem[];
  maxItems: number;
  maxDurationMs: number;
  operationHandler: RetryOperationHandler;
  leaseHandle: LeaseHandle | null;
}

export function createRetryQueueSliceRuntime(
  options: RetryQueueSliceRuntimeFactoryOptions,
): RetryQueueSliceRuntime {
  return {
    options: options.options,
    startedAt: options.startedAt,
    generation: options.generation,
    initialQueueLength: options.itemsSnapshot.length,
    itemsSnapshot: options.itemsSnapshot,
    maxItems: options.maxItems,
    maxDurationMs: options.maxDurationMs,
    operationHandler: options.operationHandler,
    leaseHandle: options.leaseHandle,
    hasNotifiedSyncStart: false,
    successfulReplayCount: 0,
    hadTerminalRemoval: false,
    stoppedByBudget: false,
    drainCompletedBySuccessfulReplay: false,
    expiredIds: new Set<string>(),
    processedIds: new Set<string>(),
    exceededCount: 0,
    processedCount: 0,
  };
}
