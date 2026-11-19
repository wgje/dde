import type { QueuedAction } from '../action-queue.types';

export interface OfflineSyncActionCaptureHooks {
  readonly enabled: boolean;
  readonly captureQueuedAction: (ownerUserId: string, action: QueuedAction) => Promise<void>;
}

let hooks: OfflineSyncActionCaptureHooks | null = null;

export function configureOfflineSyncActionCaptureHooks(next: OfflineSyncActionCaptureHooks | null): void {
  hooks = next;
}

export function getOfflineSyncActionCaptureHooks(): OfflineSyncActionCaptureHooks | null {
  return hooks;
}