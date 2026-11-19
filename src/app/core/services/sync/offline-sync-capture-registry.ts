import type { RetryQueueItem } from './retry-queue.types';

export interface OfflineSyncCaptureHooks {
  readonly enabled: boolean;
  readonly captureRetryQueueItem: (item: RetryQueueItem) => Promise<void>;
}

let hooks: OfflineSyncCaptureHooks | null = null;

export function configureOfflineSyncCaptureHooks(next: OfflineSyncCaptureHooks | null): void {
  hooks = next;
}

export function getOfflineSyncCaptureHooks(): OfflineSyncCaptureHooks | null {
  return hooks;
}