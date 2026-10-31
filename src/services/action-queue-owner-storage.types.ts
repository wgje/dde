import type { DeadLetterItem, QueuedAction } from './action-queue.types';

export interface ActionQueueOwnerStorageRuntime {
  pendingActions: () => QueuedAction[];
  setPendingActions: (queue: QueuedAction[]) => void;
  setQueueSize: (size: number) => void;
  deadLetterQueue: () => DeadLetterItem[];
  setDeadLetterQueue: (queue: DeadLetterItem[]) => void;
  setDeadLetterSize: (size: number) => void;
  syncSentryContext: () => void;
  freezeQueueWrites: (reason: string) => void;
  clearQueueFreeze: () => void;
  triggerStorageFailureEscapeMode: () => void;
  saveQueueToStorage: () => void;
  requestQueueProcessing: (reason: string) => void;
}

export type QueueSnapshot = {
  found: boolean;
  queue: QueuedAction[];
  removedActionIdentities?: string[];
  corrupted?: boolean;
  storageKey?: string;
  error?: unknown;
};
