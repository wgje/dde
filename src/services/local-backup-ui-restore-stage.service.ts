import { Injectable, inject } from '@angular/core';

import { SYNC_CONFIG } from '../config';
import type { Project } from '../models';
import type { BackupData } from '../../supabase/functions/_shared/backup-utils';
import type { ExportData } from './export.service';
import { ProjectStateService } from './project-state.service';
import { ProjectDataService, RetryQueueService } from '../core-bridge';
import {
  ExternalSourceCacheService,
} from '../app/core/external-sources/external-source-cache.service';
import { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';
import { ActionQueueStorageService } from './action-queue-storage.service';
import { ConflictStorageService } from './conflict-storage.service';
import { blobToBase64 } from './disaster-backup-blob.helpers';
import {
  restoreAttachmentUploadOutboxFromBackup,
  restoreAttachmentUploadOutboxItems,
  preflightAttachmentUploadOutboxFromBackup,
  decodeConflictsFromBackup,
  restoreConflictsFromBackup,
  restoreDeadLettersFromBackup,
} from './import-backup-conversion.helpers';
import { ImportService } from './import.service';
import {
  buildProjectLocalStateRestoreSnapshot,
  readLocalStateRestoreSnapshot,
  restoreConflictRestoreStateSnapshot,
  restoreDeadLetterRestoreSnapshot,
  restoreDockSnapshotRestoreSnapshot,
  restoreLaunchSnapshotRestoreSnapshot,
  restoreOfflineProjectRestoreSnapshot,
  restoreParkedTaskCacheRestoreSnapshot,
  restoreRetryQueueRestoreSnapshot,
} from './data-safety-indexeddb-local-state';
import { readConflictRestoreSnapshot } from './data-safety-conflict-restore.helpers';
import { BackupDataSafetyMetadataRestoreService } from './backup-data-safety-metadata-restore.service';
import { buildDataSafetyMetadataRestorePlan } from './import-backup-data-safety-metadata.helpers';
import type {
  LocalBackupUiRestoreFinalOutcome,
  LocalBackupUiRestoreStageOperationContext,
  LocalBackupUiRestoreStageOperations,
} from './local-backup-ui-restore-stage-protocol';
import {
  LOCAL_BACKUP_UI_RESTORE_STAGES,
  type LocalBackupUiRestoreMarker,
  type LocalBackupUiRestoreStage,
} from './local-backup-ui-restore-types';
import { LocalBackupUiBlackBoxRestoreService } from './local-backup-ui-black-box-restore.service';
import {
  collectLegacyRetryReviewQueueIdentityOverlapErrors,
  mergeLegacyRetryReviewItems,
  parseLegacyRetryReviewItems,
  restoreOwnerScopedLegacyRetryReviewStorageValue,
  writeOwnerScopedLegacyRetryReviewItems,
} from './legacy-retry-review-backup.helpers';
import type {
  LocalBackupUiBlackBoxPersistedEntry,
  LocalBackupUiBlackBoxRestoreSnapshot,
} from './local-backup-ui-black-box-restore.types';
import {
  decodeLocalBackupUiRestoreStageSnapshots,
  deriveLocalBackupUiRestoreRetryQueueRestoredItems,
  mergeExternalSourceLinks,
  mergePendingLinks,
  normalizeLocalBackupUiRestoreRetryQueueFootprint,
  restoreTouchedProjects,
  serializeLocalBackupUiRestoreStageSnapshot,
  snapshotForLocalBackupUiRestoreStage,
  sortLocalBackupUiRestoreAttachmentUploads,
  sortLocalBackupUiRestoreExternalLinks,
  sortLocalBackupUiRestorePendingLinks,
  upsertLocalBackupUiRestoreProjects,
  type LocalBackupUiRestoreActionQueuePreImage,
  type LocalBackupUiRestoreDeadLetterPreImage,
  type LocalBackupUiRestoreProjectPreImage,
  type LocalBackupUiRestoreRetryQueuePreImage,
  type LocalBackupUiRestoreStageSnapshots,
} from './local-backup-ui-restore-stage-snapshots';

export interface LocalBackupUiRestoreStageInput {
  ownerUserId: string;
  data: ExportData;
  backup: BackupData;
  existingProjects: Project[];
  actionQueueRestore: LocalBackupUiRestoreActionQueueParticipant;
  verifyRunContext?: () => void;
  verifyFinalReadBack?: (
    outcome: LocalBackupUiRestoreFinalOutcome,
    context: LocalBackupUiRestoreStageOperationContext,
  ) => Promise<void>;
}

export interface LocalBackupUiRestoreActionQueueParticipant {
  confirmPrepared(): Promise<number>;
  rollback(): Promise<void>;
}

export interface LocalBackupUiRestoreStageEffect {
  apply(
    context: LocalBackupUiRestoreStageOperationContext,
    snapshots: LocalBackupUiRestoreStageSnapshots,
  ): Promise<unknown>;
  read(
    context: LocalBackupUiRestoreStageOperationContext,
    snapshots: LocalBackupUiRestoreStageSnapshots,
  ): Promise<unknown>;
  restore(
    snapshot: unknown,
    context: LocalBackupUiRestoreStageOperationContext,
    snapshots: LocalBackupUiRestoreStageSnapshots,
  ): Promise<void>;
}

export interface LocalBackupUiRestoreStageOperationDependencies {
  decodePreImage(marker: LocalBackupUiRestoreMarker): LocalBackupUiRestoreStageSnapshots;
  effects: Record<LocalBackupUiRestoreStage, LocalBackupUiRestoreStageEffect>;
}

type ProjectPreImageWithBlackBox = LocalBackupUiRestoreProjectPreImage & {
  blackBox: LocalBackupUiBlackBoxPersistedEntry[];
};

@Injectable({ providedIn: 'root' })
export class LocalBackupUiRestoreStageService {
  private readonly importService = inject(ImportService);
  private readonly projectState = inject(ProjectStateService);
  private readonly projectData = inject(ProjectDataService);
  private readonly externalSourceCache = inject(ExternalSourceCacheService);
  private readonly attachmentOutbox = inject(AttachmentUploadOutboxService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly actionQueueStorage = inject(ActionQueueStorageService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly metadataRestore = inject(BackupDataSafetyMetadataRestoreService);
  private readonly blackBoxRestore = inject(LocalBackupUiBlackBoxRestoreService);

  createOperations(input: LocalBackupUiRestoreStageInput): LocalBackupUiRestoreStageOperations {
    preflightAttachmentUploadOutboxFromBackup(input.backup, input.ownerUserId);
    preflightLegacyRetryReviewFromBackup(input.backup, input.ownerUserId);
    decodeConflictsFromBackup(input.backup, input.ownerUserId);
    return createLocalBackupUiRestoreStageOperations(input, {
      decodePreImage: marker => this.decodeStageSnapshots(marker),
      effects: this.createEffects(input),
    });
  }

  createRecoveryOperations(
    ownerUserId: string,
    actionQueueRestore: LocalBackupUiRestoreActionQueueParticipant,
  ): LocalBackupUiRestoreStageOperations {
    return createLocalBackupUiRestoreStageOperations({
      ownerUserId,
      data: {} as ExportData,
      backup: {} as BackupData,
      existingProjects: [],
      actionQueueRestore,
    }, {
      decodePreImage: marker => this.decodeStageSnapshots(marker),
      effects: this.createRecoveryEffects(ownerUserId, actionQueueRestore),
    });
  }

  private decodeStageSnapshots(marker: LocalBackupUiRestoreMarker): LocalBackupUiRestoreStageSnapshots {
    const snapshots = decodeLocalBackupUiRestoreStageSnapshots(marker);
    const blackBox = this.blackBoxRestore.decode(marker.preImage.blackBox, marker.ownerUserId, marker.source.checksum);
    return Object.assign(snapshots, {
      projects: { ...snapshots.projects, blackBox: blackBox.before },
      blackBoxRestore: blackBox,
    });
  }

  private createEffects(
    input: LocalBackupUiRestoreStageInput,
  ): Record<LocalBackupUiRestoreStage, LocalBackupUiRestoreStageEffect> {
    return {
      projects: createStageEffect<LocalBackupUiRestoreProjectPreImage>(
        (context, snapshots) => this.applyProjects(input, snapshots.projects, blackBoxFor(snapshots), context),
        context => this.readProjects(input.ownerUserId, context),
        (snapshot, context, snapshots) => this.restoreProjects(input.ownerUserId, snapshot, blackBoxFor(snapshots), context),
      ),
      'attachment-outbox': createStageEffect<LocalBackupUiRestoreStageSnapshots['attachmentOutbox']>(
        context => this.applyAttachmentOutbox(input.backup, context),
        context => this.readAttachmentOutbox(input.ownerUserId, context),
        (snapshot, context) => this.restoreAttachmentOutbox(input.ownerUserId, snapshot, context),
      ),
      'action-queue': createStageEffect<LocalBackupUiRestoreActionQueuePreImage>(
        context => this.applyActionQueue(input, context),
        context => this.readActionQueue(input.ownerUserId, context),
        (_snapshot, context) => this.restoreActionQueue(input.actionQueueRestore, context),
      ),
      'retry-queue': createStageEffect<LocalBackupUiRestoreRetryQueuePreImage>(
        (context, snapshots) => this.applyRetryQueue(
          input,
          input.ownerUserId,
          snapshots.retryQueue,
          context,
        ),
        (context, snapshots) => this.readRetryQueue(
          input.ownerUserId,
          snapshots.retryQueue,
          context,
        ),
        (snapshot, context) => this.restoreRetryQueue(input.ownerUserId, snapshot, context),
      ),
      'dead-letters': createStageEffect<LocalBackupUiRestoreDeadLetterPreImage>(
        context => this.applyDeadLetters(input, context),
        context => this.readDeadLetters(input.ownerUserId, context),
        (snapshot, context) => this.restoreDeadLetters(input.ownerUserId, snapshot, context),
      ),
      conflicts: createStageEffect<LocalBackupUiRestoreStageSnapshots['conflicts']>(
        context => this.applyConflicts(input, context),
        context => this.readConflicts(input.ownerUserId, context),
        (snapshot, context) => this.restoreConflicts(input.ownerUserId, snapshot, context),
      ),
      metadata: createStageEffect<LocalBackupUiRestoreStageSnapshots['metadata']>(
        (context, snapshots) => this.applyMetadata(input, snapshots.metadata, context),
        context => this.readMetadata(input.ownerUserId, context),
        (snapshot, context) => this.restoreMetadata(input.ownerUserId, snapshot, context),
      ),
    };
  }

  private createRecoveryEffects(
    ownerUserId: string,
    actionQueueRestore: LocalBackupUiRestoreActionQueueParticipant,
  ): Record<LocalBackupUiRestoreStage, LocalBackupUiRestoreStageEffect> {
    return disableForwardStageApplies(this.createEffects({
      ownerUserId,
      data: {} as ExportData,
      backup: {} as BackupData,
      existingProjects: [],
      actionQueueRestore,
    }));
  }

  private async applyProjects(
    input: LocalBackupUiRestoreStageInput,
    preImage: LocalBackupUiRestoreProjectPreImage,
    blackBox: LocalBackupUiBlackBoxRestoreSnapshot,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<number> {
    const plan = await this.importService.prepareLocalBackupRestorePlan(
      input.data,
      this.projectState.getProjectsWithCurrentData(),
      context.checkpoint,
    );
    await context.checkpoint();
    const nextProjects = upsertLocalBackupUiRestoreProjects(
      this.projectState.getProjectsWithCurrentData(),
      plan.projects,
    );
    const nextLinks = mergeExternalSourceLinks(preImage.externalSourceLinks, plan.externalSourceLinks);
    const nextPendingLinks = mergePendingLinks(preImage.externalSourcePendingLinks, plan.externalSourceLinks);
    await context.runWriterMutation('project-state', async () => {
      await context.checkpoint();
      this.projectState.updateProjects(() => nextProjects, input.ownerUserId);
      await context.checkpoint();
    });
    await context.runWriterMutation('offline-snapshot', async () => {
      await context.checkpoint();
      await this.projectData.saveOfflineSnapshotAndWait(nextProjects, input.ownerUserId, {
        restoreWriterContinuation: true,
      });
      await context.checkpoint();
    });
    const importedCount = await context.runWriterMutation('external-source', async () => {
      await context.checkpoint();
      await this.externalSourceCache.saveLinks(nextLinks, input.ownerUserId);
      await context.checkpoint();
      await this.externalSourceCache.replacePendingLinksForOwner(nextPendingLinks, input.ownerUserId);
      await context.checkpoint();
      return plan.importedCount;
    });
    await this.applyProjectLocalState(input, context);
    await context.runWriterMutation('black-box', () => this.blackBoxRestore.apply(blackBox, context.checkpoint));
    return importedCount;
  }

  private async applyProjectLocalState(
    input: LocalBackupUiRestoreStageInput,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<void> {
    const nextLocalState = buildProjectLocalStateRestoreSnapshot(
      input.ownerUserId,
      input.backup.localState,
    );
    await context.runWriterMutation('dock-snapshot', async () => {
      await restoreDockSnapshotRestoreSnapshot(
        input.ownerUserId,
        nextLocalState.dockSnapshotRestoreSnapshot,
        context.checkpoint,
      );
    });
    await context.runWriterMutation('launch-snapshot', async () => {
      await restoreLaunchSnapshotRestoreSnapshot(
        input.ownerUserId,
        nextLocalState.launchSnapshotRestoreSnapshot,
        context.checkpoint,
      );
    });
    await context.runWriterMutation('parked-task-cache', async () => {
      await restoreParkedTaskCacheRestoreSnapshot(
        input.ownerUserId,
        nextLocalState.parkedTaskCacheRestoreSnapshot,
        context.checkpoint,
      );
    });
  }

  private async readProjects(
    ownerUserId: string,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<ProjectPreImageWithBlackBox> {
    const marker = context.marker();
    const currentProjects = new Map(
      this.projectState.getProjectsWithCurrentData().map(project => [project.id, project]),
    );
    const externalSourceLinks = await this.externalSourceCache.loadLinks(ownerUserId);
    await context.checkpoint();
    const externalSourcePendingLinks = await this.externalSourceCache.loadPendingLinks(ownerUserId);
    await context.checkpoint();
    const localState = await readLocalStateRestoreSnapshot(ownerUserId);
    await context.checkpoint();
    const blackBox = await this.blackBoxRestore.read(ownerUserId);
    await context.checkpoint();
    if (!localState.offlineSnapshotRestoreSnapshot) {
      throw new Error('local backup UI restore project snapshot read-back is incomplete');
    }
    return {
      schemaVersion: 1,
      projects: marker.touchedProjectIds.map(projectId => ({
        projectId,
        existed: currentProjects.has(projectId),
        project: currentProjects.get(projectId) ?? null,
      })),
      externalSourceLinks: sortLocalBackupUiRestoreExternalLinks(externalSourceLinks),
      externalSourcePendingLinks: sortLocalBackupUiRestorePendingLinks(externalSourcePendingLinks),
      offlineSnapshot: localState.offlineSnapshotRestoreSnapshot,
      dockSnapshot: localState.dockSnapshotRestoreSnapshot ?? {
        present: false,
        localStorage: null,
        indexedDb: null,
      },
      launchSnapshot: localState.launchSnapshotRestoreSnapshot ?? {
        present: false,
        v1: null,
        v2: null,
      },
      parkedTaskCache: localState.parkedTaskCacheRestoreSnapshot ?? {
        present: false,
        entries: [],
        syncMetadata: {},
      },
      blackBox,
    };
  }

  private async restoreProjects(
    ownerUserId: string,
    snapshot: LocalBackupUiRestoreProjectPreImage,
    blackBox: LocalBackupUiBlackBoxRestoreSnapshot,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<void> {
    await context.runWriterMutation('black-box', () => this.blackBoxRestore.rollback(blackBox, context.checkpoint));
    const restoredProjects = restoreTouchedProjects(
      this.projectState.getProjectsWithCurrentData(),
      snapshot,
    );
    await context.runWriterMutation('project-state', async () => {
      await context.checkpoint();
      this.projectState.updateProjects(() => restoredProjects, ownerUserId);
      await context.checkpoint();
    });
    await context.runWriterMutation('external-source', async () => {
      await context.checkpoint();
      await restoreOfflineProjectRestoreSnapshot(ownerUserId, snapshot.offlineSnapshot, context.checkpoint);
      await this.externalSourceCache.saveLinks(snapshot.externalSourceLinks, ownerUserId);
      await context.checkpoint();
      await this.externalSourceCache.replacePendingLinksForOwner(
        snapshot.externalSourcePendingLinks,
        ownerUserId,
      );
      await context.checkpoint();
    });
    await context.runWriterMutation('dock-snapshot', async () => {
      await restoreDockSnapshotRestoreSnapshot(ownerUserId, snapshot.dockSnapshot, context.checkpoint);
    });
    await context.runWriterMutation('launch-snapshot', async () => {
      await restoreLaunchSnapshotRestoreSnapshot(ownerUserId, snapshot.launchSnapshot, context.checkpoint);
    });
    await context.runWriterMutation('parked-task-cache', async () => {
      await restoreParkedTaskCacheRestoreSnapshot(
        ownerUserId,
        snapshot.parkedTaskCache,
        context.checkpoint,
      );
    });
  }

  private async applyAttachmentOutbox(
    backup: BackupData,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<number> {
    return restoreAttachmentUploadOutboxFromBackup(backup, this.attachmentOutbox, {
      checkpoint: context.checkpoint,
      runWrite: write => context.runWriterMutation('attachment-outbox', write),
    });
  }

  private async readAttachmentOutbox(
    ownerUserId: string,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<LocalBackupUiRestoreStageSnapshots['attachmentOutbox']> {
    const uploads = await this.attachmentOutbox.listPendingUploads(ownerUserId, {
      restoreSnapshot: true,
    });
    await context.checkpoint();
    const encoded: LocalBackupUiRestoreStageSnapshots['attachmentOutbox'] = [];
    for (const upload of uploads) {
      const blobBase64 = await blobToBase64(upload.blob);
      await context.checkpoint();
      encoded.push({
        ownerUserId: upload.ownerUserId,
        operationId: upload.operationId,
        attachmentId: upload.attachmentId,
        blobKey: upload.blobKey,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        size: upload.size,
        createdAt: upload.createdAt,
        encoding: 'base64',
        blobBase64,
      });
    }
    return encoded.sort(sortLocalBackupUiRestoreAttachmentUploads);
  }

  private async restoreAttachmentOutbox(
    ownerUserId: string,
    snapshot: LocalBackupUiRestoreStageSnapshots['attachmentOutbox'],
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<void> {
    const current = await this.attachmentOutbox.listPendingUploads(ownerUserId, {
      restoreSnapshot: true,
    });
    await context.checkpoint();
    for (const upload of current) {
      await context.runWriterMutation('attachment-outbox', () => (
        this.attachmentOutbox.removePendingUpload(upload, { restoreWriterContinuation: true })
      ));
      await context.checkpoint();
    }
    await restoreAttachmentUploadOutboxItems(snapshot, this.attachmentOutbox, {
      checkpoint: context.checkpoint,
      runWrite: write => context.runWriterMutation('attachment-outbox', write),
    });
  }

  private applyActionQueue(
    input: LocalBackupUiRestoreStageInput,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<number> {
    return context.runWriterMutation('action-queue', async () => {
      await context.checkpoint();
      const restoredCount = await input.actionQueueRestore.confirmPrepared();
      await context.checkpoint();
      return restoredCount;
    });
  }

  private async readActionQueue(
    ownerUserId: string,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<LocalBackupUiRestoreActionQueuePreImage> {
    const snapshot = await readLocalStateRestoreSnapshot(ownerUserId);
    await context.checkpoint();
    return {
      indexedDb: snapshot.actionQueueBackupRecord,
      localStorage: snapshot.actionQueueLocalStorageValue,
    };
  }

  private restoreActionQueue(
    participant: LocalBackupUiRestoreActionQueueParticipant,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<void> {
    return context.runWriterMutation('action-queue', async () => {
      await context.checkpoint();
      await participant.rollback();
      await context.checkpoint();
    });
  }

  private applyRetryQueue(
    input: LocalBackupUiRestoreStageInput,
    ownerUserId: string,
    preImage: LocalBackupUiRestoreRetryQueuePreImage,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<number> {
    return context.runWriterMutation('retry-queue', async () => {
      const validationNow = Date.now();
      const currentlyRestorableItems = normalizeLocalBackupUiRestoreRetryQueueFootprint(
        preImage.restoredItems,
        ownerUserId,
        {
          now: validationNow,
          maxItemAgeMs: SYNC_CONFIG.MAX_RETRY_ITEM_AGE,
          maxRetries: this.retryQueue.MAX_RETRIES,
        },
      );
      const restoredCount = await this.retryQueue.restoreFromBackupItems(currentlyRestorableItems, ownerUserId, {
        validationNow,
        terminalEvidence: 'forbid',
      });
      const previousLegacyReviewItems = preImage.legacyReviewLocalStorageValue === undefined
        || preImage.legacyReviewLocalStorageValue === null
        ? []
        : parseLegacyRetryReviewItems(
          JSON.parse(preImage.legacyReviewLocalStorageValue) as unknown,
          ownerUserId,
          'marker legacyRetryReview',
        );
      const incomingLegacyReviewItems = input.backup.localState?.legacyRetryReview;
      if (incomingLegacyReviewItems !== undefined) {
        const targetLegacyReviewItems = mergeLegacyRetryReviewItems(
          previousLegacyReviewItems,
          incomingLegacyReviewItems,
          ownerUserId,
        );
        await context.checkpoint();
        writeOwnerScopedLegacyRetryReviewItems(ownerUserId, targetLegacyReviewItems);
        await context.checkpoint();
      }
      return restoredCount;
    });
  }

  private async readRetryQueue(
    ownerUserId: string,
    preImage: LocalBackupUiRestoreRetryQueuePreImage,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<LocalBackupUiRestoreRetryQueuePreImage> {
    const snapshot = await readLocalStateRestoreSnapshot(ownerUserId);
    await context.checkpoint();
    const restoredItems = context.marker().state === 'restoring'
      ? deriveLocalBackupUiRestoreRetryQueueRestoredItems(preImage, {
        indexedDb: snapshot.retryQueueIndexedDbItems,
        localStorage: snapshot.retryQueueLocalStorageValue,
      }, ownerUserId)
      : preImage.restoredItems;
    return {
      schemaVersion: preImage.schemaVersion,
      indexedDb: snapshot.retryQueueIndexedDbItems,
      localStorage: snapshot.retryQueueLocalStorageValue,
      ...(preImage.legacyReviewLocalStorageValue === undefined
        ? {}
        : { legacyReviewLocalStorageValue: snapshot.legacyRetryReviewLocalStorageValue ?? null }),
      restoredItems,
    };
  }

  private restoreRetryQueue(
    ownerUserId: string,
    snapshot: LocalBackupUiRestoreRetryQueuePreImage,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<void> {
    return context.runWriterMutation('retry-queue', async () => {
      await restoreRetryQueueRestoreSnapshot(
        ownerUserId,
        {
          retryQueueIndexedDbItems: snapshot.indexedDb,
          retryQueueLocalStorageValue: snapshot.localStorage,
        },
        snapshot.restoredItems,
        () => true,
        context.checkpoint,
      );
      if (snapshot.legacyReviewLocalStorageValue !== undefined) {
        await context.checkpoint();
        restoreOwnerScopedLegacyRetryReviewStorageValue(
          ownerUserId,
          snapshot.legacyReviewLocalStorageValue,
        );
        await context.checkpoint();
      }
    });
  }

  private async applyDeadLetters(
    input: LocalBackupUiRestoreStageInput,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<number> {
    return context.runWriterMutation('action-queue', async () => {
      await context.checkpoint();
      const count = restoreDeadLettersFromBackup(
        input.backup,
        input.ownerUserId,
        this.actionQueueStorage,
      );
      await context.checkpoint();
      return count;
    });
  }

  private async readDeadLetters(
    ownerUserId: string,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<LocalBackupUiRestoreDeadLetterPreImage> {
    const snapshot = await readLocalStateRestoreSnapshot(ownerUserId);
    await context.checkpoint();
    return {
      indexedDb: snapshot.deadLetterBackupRecord,
      localStorage: snapshot.deadLetterLocalStorageValue,
    };
  }

  private restoreDeadLetters(
    ownerUserId: string,
    snapshot: LocalBackupUiRestoreDeadLetterPreImage,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<void> {
    return context.runWriterMutation('action-queue', () => restoreDeadLetterRestoreSnapshot(
      ownerUserId,
      {
        deadLetterBackupRecord: snapshot.indexedDb,
        deadLetterLocalStorageValue: snapshot.localStorage,
      },
      () => true,
      context.checkpoint,
    ));
  }

  private applyConflicts(
    input: LocalBackupUiRestoreStageInput,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<number> {
    return restoreConflictsFromBackup(
      input.backup,
      input.ownerUserId,
      this.conflictStorage,
      {
        checkpoint: context.checkpoint,
        runWrite: write => context.runWriterMutation('conflicts', write),
      },
    );
  }

  private async readConflicts(
    ownerUserId: string,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<LocalBackupUiRestoreStageSnapshots['conflicts']> {
    const snapshot = await readConflictRestoreSnapshot(ownerUserId);
    await context.checkpoint();
    return snapshot;
  }

  private restoreConflicts(
    ownerUserId: string,
    snapshot: LocalBackupUiRestoreStageSnapshots['conflicts'],
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<void> {
    return context.runWriterMutation('conflicts', () => (
      restoreConflictRestoreStateSnapshot(ownerUserId, snapshot, context.checkpoint)
    ));
  }

  private async applyMetadata(
    input: LocalBackupUiRestoreStageInput,
    preImage: LocalBackupUiRestoreStageSnapshots['metadata'],
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<unknown> {
    const plan = buildDataSafetyMetadataRestorePlan(input.backup, input.ownerUserId, preImage);
    await this.metadataRestore.replaceAtomically(
      input.ownerUserId,
      plan.target,
      preImage,
      context.checkpoint,
    );
    await context.checkpoint();
    return plan.counts;
  }

  private async readMetadata(
    ownerUserId: string,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<LocalBackupUiRestoreStageSnapshots['metadata']> {
    const result = await this.metadataRestore.readCurrent(
      ownerUserId,
      new Set(context.marker().touchedProjectIds),
      context.checkpoint,
    );
    await context.checkpoint();
    return result;
  }

  private async restoreMetadata(
    ownerUserId: string,
    snapshot: LocalBackupUiRestoreStageSnapshots['metadata'],
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<void> {
    const current = await this.readMetadata(ownerUserId, context);
    await this.metadataRestore.replaceAtomically(
      ownerUserId,
      snapshot,
      current,
      context.checkpoint,
    );
    await context.checkpoint();
  }
}

function createStageEffect<TSnapshot>(
  apply: LocalBackupUiRestoreStageEffect['apply'],
  read: LocalBackupUiRestoreStageEffect['read'],
  restore: (
    snapshot: TSnapshot,
    context: LocalBackupUiRestoreStageOperationContext,
    snapshots: LocalBackupUiRestoreStageSnapshots,
  ) => Promise<void>,
): LocalBackupUiRestoreStageEffect {
  return {
    apply,
    read,
    restore: (snapshot, context, snapshots) => (
      restore(snapshot as TSnapshot, context, snapshots)
    ),
  };
}

export function createLocalBackupUiRestoreStageOperations(
  input: LocalBackupUiRestoreStageInput,
  dependencies: LocalBackupUiRestoreStageOperationDependencies,
): LocalBackupUiRestoreStageOperations {
  let snapshots: LocalBackupUiRestoreStageSnapshots | null = null;
  const appliedReadBack = new Map<LocalBackupUiRestoreStage, string>();
  const requireSnapshots = (): LocalBackupUiRestoreStageSnapshots => {
    if (!snapshots) throw new Error('local backup UI restore pre-image was not decoded');
    return snapshots;
  };
  return {
    decodePreImage: marker => {
      if (input.ownerUserId && marker.ownerUserId !== input.ownerUserId) throw new Error('local backup UI restore stage owner mismatch');
      snapshots = dependencies.decodePreImage(marker);
    },
    apply: (stage, context) => applyLocalBackupUiRestoreStage(
      input, dependencies, requireSnapshots, appliedReadBack, stage, context,
    ),
    verifyApplied: (stage, context) => verifyAppliedLocalBackupUiRestoreStage(
      input, dependencies, requireSnapshots, appliedReadBack, stage, context,
    ),
    rollback: (stage, context) => rollbackLocalBackupUiRestoreStage(
      input, dependencies, requireSnapshots, stage, context,
    ),
    verifyRolledBack: (stage, context) => verifyRolledBackLocalBackupUiRestoreStage(
      input, dependencies, requireSnapshots, stage, context,
    ),
    ...(input.verifyFinalReadBack
      ? {
        verifyFinalReadBack: (outcome: LocalBackupUiRestoreFinalOutcome,
          context: LocalBackupUiRestoreStageOperationContext) => (
          input.verifyFinalReadBack!(outcome, guardOperationContext(input, context))
        ),
      }
      : {}),
  };
}

async function applyLocalBackupUiRestoreStage(
  input: LocalBackupUiRestoreStageInput,
  dependencies: LocalBackupUiRestoreStageOperationDependencies,
  requireSnapshots: () => LocalBackupUiRestoreStageSnapshots,
  appliedReadBack: Map<LocalBackupUiRestoreStage, string>,
  stage: LocalBackupUiRestoreStage,
  context: LocalBackupUiRestoreStageOperationContext,
): Promise<unknown> {
  const decoded = requireSnapshots();
  const guarded = guardOperationContext(input, context);
  const result = await dependencies.effects[stage].apply(guarded, decoded);
  appliedReadBack.set(stage, serializeLocalBackupUiRestoreStageSnapshot(
    stage,
    await dependencies.effects[stage].read(guarded, decoded),
  ));
  return result;
}

async function verifyAppliedLocalBackupUiRestoreStage(
  input: LocalBackupUiRestoreStageInput,
  dependencies: LocalBackupUiRestoreStageOperationDependencies,
  requireSnapshots: () => LocalBackupUiRestoreStageSnapshots,
  appliedReadBack: ReadonlyMap<LocalBackupUiRestoreStage, string>,
  stage: LocalBackupUiRestoreStage,
  context: LocalBackupUiRestoreStageOperationContext,
): Promise<void> {
  const decoded = requireSnapshots();
  const guarded = guardOperationContext(input, context);
  const expected = appliedReadBack.get(stage);
  const actual = serializeLocalBackupUiRestoreStageSnapshot(
    stage,
    await dependencies.effects[stage].read(guarded, decoded),
  );
  if (expected === undefined || actual !== expected) {
    throw new Error(`local backup UI restore ${stage} durable read-back verification failed`);
  }
}

async function rollbackLocalBackupUiRestoreStage(
  input: LocalBackupUiRestoreStageInput,
  dependencies: LocalBackupUiRestoreStageOperationDependencies,
  requireSnapshots: () => LocalBackupUiRestoreStageSnapshots,
  stage: LocalBackupUiRestoreStage,
  context: LocalBackupUiRestoreStageOperationContext,
): Promise<void> {
  const decoded = requireSnapshots();
  await dependencies.effects[stage].restore(
    snapshotForLocalBackupUiRestoreStage(decoded, stage),
    guardOperationContext(input, context),
    decoded,
  );
}

async function verifyRolledBackLocalBackupUiRestoreStage(
  input: LocalBackupUiRestoreStageInput,
  dependencies: LocalBackupUiRestoreStageOperationDependencies,
  requireSnapshots: () => LocalBackupUiRestoreStageSnapshots,
  stage: LocalBackupUiRestoreStage,
  context: LocalBackupUiRestoreStageOperationContext,
): Promise<void> {
  const decoded = requireSnapshots();
  const actual = await dependencies.effects[stage].read(
    guardOperationContext(input, context),
    decoded,
  );
  const expected = snapshotForLocalBackupUiRestoreStage(decoded, stage);
  if (serializeLocalBackupUiRestoreStageSnapshot(stage, actual)
    !== serializeLocalBackupUiRestoreStageSnapshot(stage, expected)) {
    throw new Error(`local backup UI restore ${stage} rollback read-back verification failed`);
  }
}

function guardOperationContext(
  input: LocalBackupUiRestoreStageInput,
  context: LocalBackupUiRestoreStageOperationContext,
): LocalBackupUiRestoreStageOperationContext {
  const checkpoint = async (): Promise<void> => {
    input.verifyRunContext?.();
    await context.checkpoint();
    input.verifyRunContext?.();
  };
  return {
    marker: context.marker,
    checkpoint,
    runWriterMutation: (source, write) => context.runWriterMutation(source, async () => {
      await checkpoint();
      return await write();
    }),
  };
}

function forbidStartupRecoveryForwardApply(stage: LocalBackupUiRestoreStage): never {
  throw new Error(`local backup UI startup recovery must not resume forward ${stage}`);
}

function preflightLegacyRetryReviewFromBackup(backup: BackupData, ownerUserId: string): void {
  const items = backup.localState?.legacyRetryReview;
  if (items === undefined) return;
  parseLegacyRetryReviewItems(items, ownerUserId, 'backup.localState.legacyRetryReview');
  const overlapErrors = collectLegacyRetryReviewQueueIdentityOverlapErrors(
    backup.localState?.retryQueue,
    items,
    'backup.localState.legacyRetryReview',
  );
  if (overlapErrors.length > 0) {
    throw new Error(`backup local state has conflicting RetryQueue review identity: ${overlapErrors.join('; ')}`);
  }
}

function blackBoxFor(snapshots: LocalBackupUiRestoreStageSnapshots): LocalBackupUiBlackBoxRestoreSnapshot {
  const value = (snapshots as LocalBackupUiRestoreStageSnapshots & {
    blackBoxRestore?: LocalBackupUiBlackBoxRestoreSnapshot;
  }).blackBoxRestore;
  if (!value) throw new Error('local backup UI Black Box pre-image was not decoded');
  return value;
}

function disableForwardStageApplies(
  effects: Record<LocalBackupUiRestoreStage, LocalBackupUiRestoreStageEffect>,
): Record<LocalBackupUiRestoreStage, LocalBackupUiRestoreStageEffect> {
  return Object.fromEntries(LOCAL_BACKUP_UI_RESTORE_STAGES.map(stage => [stage, {
    ...effects[stage],
    apply: () => forbidStartupRecoveryForwardApply(stage),
  }])) as unknown as Record<LocalBackupUiRestoreStage, LocalBackupUiRestoreStageEffect>;
}
