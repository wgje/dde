import type { ActionQueueProcessorResult } from './action-queue-processor-result.helpers';
import type { QueuedAction } from './action-queue.types';

export type ActionQueueProcessResult = {
  processed: number;
  failed: number;
  movedToDeadLetter: number;
};

export type QueueProcessorContext = {
  leaseSignal?: AbortSignal;
  isCurrent?: () => boolean;
};

export type QueueProcessor = (
  action: QueuedAction,
  context?: QueueProcessorContext,
) => Promise<ActionQueueProcessorResult>;

export type QueueProcessContext = {
  processGeneration: number;
  processOwnerUserId: string;
  processLifecycleToken: number;
  leaseSignal?: AbortSignal;
  queue: QueuedAction[];
  failedCreateEntities: Set<string>;
};
