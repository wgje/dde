import {
  createOfflineSyncCommand,
  type CreateOfflineSyncCommandInput,
  type OfflineSyncCommandEnvelope,
  type JsonObject,
} from './offline-sync-command-envelope';
import {
  createEmptyOfflineSyncProjectionState,
  reconcileOfflineSyncCommand,
  type OfflineSyncProjectionState,
  type OfflineSyncReconcileResult,
  type OfflineSyncConflictEvidence,
} from './offline-sync-reconcile-policy';
import {
  createOfflineProjectionKey,
  type OfflineCommandStore,
  type OfflineCommandStoreWrite,
} from './offline-command-store';
import { createDerivedSyncOperationId } from '../../utils/sync-operation-id';

export interface CommitOfflineSyncCommandInput {
  readonly command: CreateOfflineSyncCommandInput;
  readonly initialProjection?: JsonObject;
  readonly projectionVersion?: number;
  readonly nowIso?: string;
}

export interface CommitOfflineSyncCommandResult {
  readonly command: OfflineSyncCommandEnvelope;
  readonly reconcile: OfflineSyncReconcileResult;
  readonly persistedProjectionVersion: number;
}

export interface OfflineSyncCommandCoordinatorOptions {
  readonly store: OfflineCommandStore;
  readonly now?: () => string;
}

/**
 * Local-first command boundary. It never performs network I/O: callers can
 * hand the returned envelope to an existing RetryQueue/ActionQueue adapter.
 */
export class OfflineSyncCommandCoordinator {
  private readonly store: OfflineCommandStore;
  private readonly now: () => string;

  constructor(options: OfflineSyncCommandCoordinatorOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async commit(input: CommitOfflineSyncCommandInput): Promise<CommitOfflineSyncCommandResult> {
    return this.commitEnvelope(
      createOfflineSyncCommand(input.command),
      input.initialProjection,
      input.projectionVersion,
      input.nowIso,
    );
  }

  async commitEnvelope(
    command: OfflineSyncCommandEnvelope,
    initialProjection: JsonObject = command.normalizedResultPatch,
    projectionVersion?: number,
    nowIso?: string,
  ): Promise<CommitOfflineSyncCommandResult> {
    const projectionKey = createOfflineProjectionKey(
      command.ownerUserId,
      command.entityType,
      command.entityId,
    );
    const existing = await this.store.getProjection<OfflineSyncProjectionState>(
      command.ownerUserId,
      projectionKey,
    );
    const current = existing?.value
      ?? createEmptyOfflineSyncProjectionState(initialProjection);
    const reconcile = reconcileOfflineSyncCommand(current, command);
    const persistedProjectionVersion = (existing?.version ?? projectionVersion ?? 0)
      + (reconcile.applied ? 1 : 0);
    const commitNowIso = nowIso ?? this.now();

    await this.store.commitLocalChange(buildOfflineCommandStoreWrite(
      command,
      reconcile,
      persistedProjectionVersion,
      commitNowIso,
    ));

    return { command, reconcile, persistedProjectionVersion };
  }
}
function buildOfflineCommandStoreWrite(
  command: OfflineSyncCommandEnvelope,
  reconcile: OfflineSyncReconcileResult,
  persistedProjectionVersion: number,
  commitNowIso: string,
): OfflineCommandStoreWrite<OfflineSyncCommandEnvelope, OfflineSyncProjectionState> {
  const status = reconcile.applied ? command.status : 'rejected';
  const conflictDecision = reconcile.evidence.map(item => item.reason).join(',') || undefined;
  const conflictEvidence = reconcile.evidence.map(evidence => toConflictEvidenceRecord(
    command.ownerUserId,
    evidence,
    commitNowIso,
  ));
  return {
    ownerUserId: command.ownerUserId,
    projection: {
      ownerUserId: command.ownerUserId,
      entityType: command.entityType,
      entityId: command.entityId,
      value: reconcile.state,
      version: persistedProjectionVersion,
      updatedAt: commitNowIso,
      tombstone: reconcile.state.tombstone !== undefined,
    },
    command: {
      ownerUserId: command.ownerUserId,
      operationId: command.operationId,
      entityType: command.entityType,
      entityId: command.entityId,
      command,
      status,
      createdAt: command.createdAtIso,
      updatedAt: commitNowIso,
    },
    audit: {
      ownerUserId: command.ownerUserId,
      operationId: command.operationId,
      entityType: command.entityType,
      entityId: command.entityId,
      operation: command.command,
      localTimestamp: command.createdAtIso,
      updatedAtBaseline: command.baseUpdatedAt ?? undefined,
      queueResult: status,
      conflictDecision,
      conflictEvidenceKeys: conflictEvidence.map(item => item.key),
      lastSyncTimeEffect: 'unchanged',
    },
    conflictEvidence,
  };
}

function toConflictEvidenceRecord(
  ownerUserId: string,
  evidence: OfflineSyncConflictEvidence,
  capturedAt: string,
) {
  const conflictId = createDerivedSyncOperationId(
    evidence.losingOperationId,
    `conflict:${evidence.winningOperationId}:${evidence.field ?? '*'}:${evidence.reason}`,
  );
  return {
    ownerUserId,
    conflictId,
    entityType: evidence.losingCommand?.entityType ?? evidence.winningCommand?.entityType ?? 'unknown',
    entityId: evidence.entityId,
    losingOperationId: evidence.losingOperationId,
    winningOperationId: evidence.winningOperationId,
    evidence,
    capturedAt,
    key: `${ownerUserId}:conflict:${conflictId}`,
  };
}
