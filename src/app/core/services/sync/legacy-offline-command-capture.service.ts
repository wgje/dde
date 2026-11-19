import type { RetryQueueItem } from './retry-queue.types';
import type { QueuedAction } from '../../../../services/action-queue.types';
import {
  queuedActionToOfflineCommand,
  retryQueueItemToOfflineCommand,
  type LegacyOfflineCommandAdapterContext,
} from './legacy-offline-command-adapter';
import {
  OfflineSyncCommandCoordinator,
  type CommitOfflineSyncCommandResult,
} from '../../../../services/sync/offline-sync-command-coordinator';

export interface LegacyOfflineCommandCaptureOptions {
  readonly coordinator: OfflineSyncCommandCoordinator;
  readonly context: LegacyOfflineCommandAdapterContext;
}

/**
 * Captures legacy queue records into the new local-first command store.
 * Existing queue consumers remain the source of network delivery.
 */
export class LegacyOfflineCommandCaptureService {
  private readonly coordinator: OfflineSyncCommandCoordinator;
  private readonly context: LegacyOfflineCommandAdapterContext;

  constructor(options: LegacyOfflineCommandCaptureOptions) {
    this.coordinator = options.coordinator;
    this.context = options.context;
  }

  async captureRetryQueueItem(item: RetryQueueItem): Promise<CommitOfflineSyncCommandResult> {
    const adapted = retryQueueItemToOfflineCommand(item, this.context);
    return this.coordinator.commitEnvelope(adapted.command, adapted.command.normalizedResultPatch);
  }

  async captureQueuedAction(action: QueuedAction): Promise<CommitOfflineSyncCommandResult> {
    const adapted = queuedActionToOfflineCommand(action, this.context);
    return this.coordinator.commitEnvelope(adapted.command, adapted.command.normalizedResultPatch);
  }
}