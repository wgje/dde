import type { OfflineCommandStore, OfflineCommandRecord } from '../../../../services/sync/offline-command-store';
import type { OfflineSyncCommandEnvelope } from '../../../../services/sync/offline-sync-command-envelope';
import {
  createOfflineSyncUnsupportedCommandQuarantiner,
  replayOfflineSyncCommand,
  type OfflineSyncCommandReplayOptions,
  type OfflineSyncCommandReplayResult,
} from './offline-sync-command-replay-adapter';
import type { RetryOperationHandler } from './retry-queue.types';

export interface OfflineSyncReplayProcessorOptions {
  readonly store: OfflineCommandStore;
  readonly ownerUserId: string;
  readonly handler: RetryOperationHandler;
  readonly replayOptions?: Omit<OfflineSyncCommandReplayOptions, 'quarantineUnsupported'>;
  readonly now?: () => string;
}

export interface OfflineSyncReplayDrainResult {
  readonly attempted: number;
  readonly acked: number;
  readonly rejected: number;
  readonly unknown: number;
  readonly unsupported: number;
}

/**
 * Drains the durable command store through the existing guarded replay seam.
 * Every attempt settles its command and audit row atomically, while unsupported
 * commands remain exportable in quarantine instead of being silently dropped.
 */
export class OfflineSyncCommandReplayProcessor {
  private readonly options: OfflineSyncReplayProcessorOptions;
  private readonly now: () => string;

  constructor(options: OfflineSyncReplayProcessorOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async drain(): Promise<OfflineSyncReplayDrainResult> {
    const records = await this.loadCandidates();
    const result = { attempted: 0, acked: 0, rejected: 0, unknown: 0, unsupported: 0 };
    const quarantineUnsupported = createOfflineSyncUnsupportedCommandQuarantiner(this.options.store, this.now);
    const replayOptions: OfflineSyncCommandReplayOptions = {
      ...this.options.replayOptions,
      captureRemoteEvidence: true,
      quarantineUnsupported,
    };

    for (const record of records) {
      const command = record.command as OfflineSyncCommandEnvelope;
      result.attempted += 1;
      if (record.ownerUserId !== this.options.ownerUserId
        || !command
        || command.ownerUserId !== this.options.ownerUserId) {
        await this.options.store.quarantine({
          ownerUserId: this.options.ownerUserId,
          reason: 'owner-mismatch',
          raw: {
            operationId: record.operationId,
            entityType: record.entityType,
            entityId: record.entityId,
          },
          quarantinedAt: this.now(),
          key: `${this.options.ownerUserId}:quarantine:owner-mismatch:${record.operationId}`,
        });
        result.unknown += 1;
        continue;
      }
      let replay: OfflineSyncCommandReplayResult;
      try {
        replay = await replayOfflineSyncCommand(command, this.options.handler, replayOptions);
      } catch (error) {
        await this.options.store.updateReplayResult({
          ownerUserId: this.options.ownerUserId,
          operationId: record.operationId,
          status: 'unknown',
          decision: 'transport-error',
          rawResponse: { error: error instanceof Error ? error.message : String(error) },
          updatedAt: this.now(),
        });
        result.unknown += 1;
        continue;
      }

      const status = this.mapStatus(replay);
      if (status === null) continue;

      const persisted = await this.options.store.updateReplayResult({
        ownerUserId: this.options.ownerUserId,
        operationId: record.operationId,
        status: status === 'unsupported' ? 'rejected' : status,
        ...(replay.status === 'replayed' && replay.decision === undefined ? {} : {
          decision: replay.status === 'replayed' ? replay.decision : replay.status,
        }),
        ...(replay.status === 'replayed' && replay.rawResponse === undefined ? {} : {
          rawResponse: replay.status === 'replayed' ? replay.rawResponse : replay,
        }),
        ...(replay.status === 'replayed' && replay.serverUpdatedAt === undefined ? {} : {
          serverUpdatedAt: replay.status === 'replayed' ? replay.serverUpdatedAt : undefined,
        }),
        updatedAt: this.now(),
      });
      if (!persisted) {
        result.unknown += 1;
        await this.options.store.quarantine({
          ownerUserId: this.options.ownerUserId,
          reason: 'replay-readback-missing',
          raw: { operationId: record.operationId, entityType: record.entityType, entityId: record.entityId },
          quarantinedAt: this.now(),
          key: `${this.options.ownerUserId}:quarantine:readback:${record.operationId}`,
        });
        continue;
      }
      if (status === 'acked') result.acked += 1;
      if (status === 'rejected') result.rejected += 1;
      if (status === 'unknown') result.unknown += 1;
      if (status === 'unsupported') result.unsupported += 1;
      if (status === 'rejected' && replay.status === 'replayed') {
        const decision = replay.decision ?? 'unspecified';
        await this.options.store.quarantine({
          ownerUserId: this.options.ownerUserId,
          reason: `remote-replay-not-applied:${decision}`,
          raw: { command, replay },
          quarantinedAt: this.now(),
          key: `${this.options.ownerUserId}:quarantine:replay:${record.operationId}`,
        });
      }
    }
    return result;
  }

  private async loadCandidates(): Promise<Array<OfflineCommandRecord<unknown>>> {
    const statuses = ['pending', 'sent', 'unknown'] as const;
    const byOperation = new Map<string, OfflineCommandRecord<unknown>>();
    for (const status of statuses) {
      const rows = await this.options.store.listCommands<unknown>(this.options.ownerUserId, status);
      for (const row of rows) byOperation.set(row.operationId, row);
    }
    return [...byOperation.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.operationId.localeCompare(right.operationId));
  }

  private mapStatus(result: OfflineSyncCommandReplayResult): 'acked' | 'rejected' | 'unknown' | 'unsupported' | null {
    if (result.status === 'acked') return 'acked';
    if (result.status === 'unknown') return 'unknown';
    if (result.status === 'skipped') return result.reason === 'unsupported' ? 'unsupported' : null;
    return result.success ? 'acked' : 'rejected';
  }
}
