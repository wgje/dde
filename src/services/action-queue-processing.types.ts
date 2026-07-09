import type { ActionQueueProcessorResult } from './action-queue-processor-result.helpers';
import type { QueuedAction } from './action-queue.types';

export type ActionQueueProcessResult = {
  processed: number;
  failed: number;
  movedToDeadLetter: number;
};

export type QueueProcessor = (action: QueuedAction) => Promise<ActionQueueProcessorResult>;

export type QueueProcessContext = {
  processGeneration: number;
  processOwnerUserId: string;
  processLifecycleToken: number;
  queue: QueuedAction[];
  failedCreateEntities: Set<string>;
};
