import { Injectable, inject } from '@angular/core';

import {
  createLocalBackupUiRestoreJournal,
  isLocalBackupUiRestoreMarkerActive,
} from './local-backup-ui-restore-journal';
import {
  LocalBackupUiRestoreOwnershipLostError,
} from './local-backup-ui-restore-stage-protocol';
import {
  LocalBackupUiRestoreStageService,
} from './local-backup-ui-restore-stage.service';
import { decodeLocalBackupUiBlackBoxRestoreSnapshot } from './local-backup-ui-black-box-restore.service';
import { decodeLocalBackupUiRestoreStageSnapshots } from './local-backup-ui-restore-stage-snapshots';
import {
  LocalBackupUiRestoreTransactionService,
} from './local-backup-ui-restore-transaction.service';
import {
  isLocalBackupUiRestoreQueueStateCompatible,
  type LocalBackupUiRestoreMarker,
} from './local-backup-ui-restore-types';
import {
  localBackupUiRestoreWriterQuiescence,
  type LocalBackupUiRestoreQuiescenceMarker,
} from './local-backup-ui-restore-writer-quiescence.service';
import { QueueBackupService } from './queue-backup.service';

export type LocalBackupUiRestoreStartupRecoveryResult =
  | { status: 'none' }
  | { status: 'recovered' }
  | {
    status: 'blocked';
    reason: 'active-or-mutated' | 'invalid-evidence' | 'ownership-lost';
  };

@Injectable({ providedIn: 'root' })
export class LocalBackupUiRestoreStartupRecoveryService {
  private readonly transaction = inject(LocalBackupUiRestoreTransactionService);
  private readonly stageService = inject(LocalBackupUiRestoreStageService);
  private readonly queueBackup = inject(QueueBackupService);

  async recover(ownerUserId: string): Promise<LocalBackupUiRestoreStartupRecoveryResult> {
    try {
      const journal = createLocalBackupUiRestoreJournal(ownerUserId);
      const marker = await journal.read();
      if (!marker) {
        const preMarker = await localBackupUiRestoreWriterQuiescence
          .recoverExpiredPreMarkerQuiescence(ownerUserId);
        if (preMarker.status === 'recovered') return { status: 'recovered' };
        if (preMarker.status === 'finalization') {
          return await recoverExpiredOrphanedFinalizationEvidence(preMarker.evidence);
        }
        return preMarker.status === 'blocked' ? blocked(preMarker.reason) : { status: 'none' };
      }
      if (!await this.hasCompatibleQueueState(marker, ownerUserId)) return blocked('invalid-evidence');
      const quiescence = await localBackupUiRestoreWriterQuiescence
        .readStartupRecoveryEvidence(ownerUserId);
      if (isEligibleExpiredPreparedMarker(marker)) {
        return await recoverExpiredPreparedEvidence(
          this.transaction,
          this.stageService,
          marker,
          quiescence,
        );
      }
      if (isEligibleExpiredRollbackRecovery(marker, quiescence)) {
        decodeStartupRecoveryEvidence(marker);
        const handle = await this.transaction.takeoverExpired(marker, quiescence);
        const result = await handle.runStartupRollback(
          this.stageService.createRecoveryOperations(ownerUserId, handle.actionQueueRestore),
        );
        return result.status === 'blocked'
          ? blocked(result.ownershipLost ? 'ownership-lost' : 'invalid-evidence')
          : { status: 'recovered' };
      }
      if (isEligibleExpiredFinalizationRecovery(marker, quiescence)) {
        decodeStartupRecoveryEvidence(marker);
        const handle = await this.transaction.takeoverExpired(marker, quiescence);
        await handle.finishFinalization(
          marker.state === 'completed' ? 'completed' : 'rolled-back',
        );
        return { status: 'recovered' };
      }
      return blocked(resolveBlockedReason(marker, quiescence));
    } catch (error) {
      return blocked(error instanceof LocalBackupUiRestoreOwnershipLostError
        ? 'ownership-lost'
        : 'invalid-evidence');
    }
  }

  private async hasCompatibleQueueState(
    marker: LocalBackupUiRestoreMarker,
    ownerUserId: string,
  ): Promise<boolean> {
    const state = await this.queueBackup.readPersonalRestoreIdentityState(
      marker.actionQueueRestoreIdentity,
      ownerUserId,
    );
    return isLocalBackupUiRestoreQueueStateCompatible(marker, state);
  }
}

async function recoverExpiredPreparedEvidence(
  transaction: LocalBackupUiRestoreTransactionService,
  stageService: LocalBackupUiRestoreStageService,
  marker: LocalBackupUiRestoreMarker,
  quiescence: LocalBackupUiRestoreQuiescenceMarker | null,
): Promise<LocalBackupUiRestoreStartupRecoveryResult> {
  if (!hasCompatibleExpiredQuiescence(marker, quiescence, 'quiesced')) {
    return blocked(resolveBlockedReason(marker, quiescence));
  }
  decodeStartupRecoveryEvidence(marker);
  const handle = await transaction.takeoverExpired(marker, quiescence);
  const operations = stageService.createRecoveryOperations(
    marker.ownerUserId,
    handle.actionQueueRestore,
  );
  operations.decodePreImage(marker);
  const result = await handle.runStartupRollback(operations);
  return result.status === 'blocked'
    ? blocked(result.ownershipLost ? 'ownership-lost' : 'invalid-evidence')
    : { status: 'recovered' };
}

function decodeStartupRecoveryEvidence(marker: LocalBackupUiRestoreMarker): void {
  decodeLocalBackupUiRestoreStageSnapshots(marker);
  decodeLocalBackupUiBlackBoxRestoreSnapshot(
    marker.preImage.blackBox,
    marker.ownerUserId,
    marker.source.checksum,
  );
}

async function recoverExpiredOrphanedFinalizationEvidence(
  quiescence: LocalBackupUiRestoreQuiescenceMarker,
): Promise<LocalBackupUiRestoreStartupRecoveryResult> {
  if (!isEligibleExpiredOrphanedFinalization(quiescence)) {
    return blocked(resolveOrphanedQuiescenceReason(quiescence));
  }
  const handle = await localBackupUiRestoreWriterQuiescence
    .takeoverExpiredFinalization(quiescence);
  await handle.releaseFinalized();
  return { status: 'recovered' };
}

function isEligibleExpiredPreparedMarker(marker: LocalBackupUiRestoreMarker): boolean {
  return !isLocalBackupUiRestoreMarkerActive(marker)
    && marker.state === 'prepared'
    && marker.phase === 'pre-image-captured'
    && marker.completedStages.length === 0
    && marker.rollbackCompletedStages.length === 0
    && marker.rollbackErrors.length === 0;
}

function isEligibleExpiredRollbackRecovery(
  marker: LocalBackupUiRestoreMarker,
  quiescence: LocalBackupUiRestoreQuiescenceMarker | null,
): quiescence is LocalBackupUiRestoreQuiescenceMarker {
  return !isLocalBackupUiRestoreMarkerActive(marker)
    && (marker.state === 'restoring'
      || marker.state === 'rolling-back'
      || marker.state === 'rollback-failed')
    && hasCompatibleExpiredQuiescence(marker, quiescence, 'quiesced');
}

function isEligibleExpiredFinalizationRecovery(
  marker: LocalBackupUiRestoreMarker,
  quiescence: LocalBackupUiRestoreQuiescenceMarker | null,
): quiescence is LocalBackupUiRestoreQuiescenceMarker {
  if (isLocalBackupUiRestoreMarkerActive(marker) || marker.phase !== 'finalizing') {
    return false;
  }
  if (marker.state !== 'completed' && marker.state !== 'rolled-back') {
    return false;
  }
  const expectedState = marker.state === 'completed'
    ? 'finalizing-completed'
    : 'finalizing-rolled-back';
  return hasCompatibleExpiredQuiescence(marker, quiescence, expectedState)
    || hasCompatibleExpiredQuiescence(marker, quiescence, 'quiesced');
}

function hasCompatibleExpiredQuiescence(
  marker: LocalBackupUiRestoreMarker,
  quiescence: LocalBackupUiRestoreQuiescenceMarker | null,
  expectedState: LocalBackupUiRestoreQuiescenceMarker['state'],
): quiescence is LocalBackupUiRestoreQuiescenceMarker {
  return quiescence !== null
    && quiescence.ownerUserId === marker.ownerUserId
    && quiescence.runId === marker.runId
    && quiescence.createdAt === marker.createdAt
    && quiescence.state === expectedState
    && Date.parse(quiescence.leaseExpiresAt) <= Date.now();
}

function isEligibleExpiredOrphanedFinalization(
  quiescence: LocalBackupUiRestoreQuiescenceMarker,
): boolean {
  return quiescence.state.startsWith('finalizing-')
    && Date.parse(quiescence.leaseExpiresAt) <= Date.now();
}

function resolveBlockedReason(
  marker: LocalBackupUiRestoreMarker,
  quiescence: LocalBackupUiRestoreQuiescenceMarker | null,
): Extract<LocalBackupUiRestoreStartupRecoveryResult, { status: 'blocked' }>['reason'] {
  return isLocalBackupUiRestoreMarkerActive(marker)
    || (quiescence !== null && Date.parse(quiescence.leaseExpiresAt) > Date.now())
    ? 'active-or-mutated'
    : 'invalid-evidence';
}

function resolveOrphanedQuiescenceReason(
  quiescence: LocalBackupUiRestoreQuiescenceMarker,
): Extract<LocalBackupUiRestoreStartupRecoveryResult, { status: 'blocked' }>['reason'] {
  return Date.parse(quiescence.leaseExpiresAt) > Date.now()
    ? 'active-or-mutated'
    : 'invalid-evidence';
}

function blocked(
  reason: Extract<LocalBackupUiRestoreStartupRecoveryResult, { status: 'blocked' }>['reason'],
): LocalBackupUiRestoreStartupRecoveryResult {
  return { status: 'blocked', reason };
}
