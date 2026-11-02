import { Injectable, inject } from '@angular/core';

import { SYNC_CONFIG } from '../config';
import type { Project } from '../models';
import type { BackupData } from '../../supabase/functions/_shared/backup-utils';
import type { ExportData } from './export.service';
import { ProjectStateService } from './project-state.service';
import { ProjectDataService, RetryQueueService } from '../core-bridge';
import { normalizeOfflineSnapshotProject } from '../app/core/services/sync/project-data-projection';
import {
  ExternalSourceCacheService,
} from '../app/core/external-sources/external-source-cache.service';
import { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';
import { ActionQueueStorageService } from './action-queue-storage.service';
import { ConflictStorageService } from './conflict-storage.service';
import { blobToBase64 } from './disaster-backup-blob.helpers';
import {
  extractBackupActionQueueActions,
} from './action-queue-restore.helpers';
import {
  restoreAttachmentUploadOutboxFromBackup,
  restoreAttachmentUploadOutboxItems,
  deriveAttachmentUploadOutboxRestoreTarget,
  preflightAttachmentUploadOutboxFromBackup,
  decodeConflictsFromBackup,
  restoreConflictsFromBackup,
  restoreDeadLettersFromBackup,
  deriveDeadLetterRestoreTarget,
  type DeadLetterRestoreTargetSnapshot,
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
import {
  projectConflictRestoreSnapshot,
  readConflictRestoreSnapshot,
} from './data-safety-conflict-restore.helpers';
import { BackupDataSafetyMetadataRestoreService } from './backup-data-safety-metadata-restore.service';
import { buildDataSafetyMetadataRestorePlan } from './import-backup-data-safety-metadata.helpers';
import type {
  LocalBackupUiRestoreStageOperationContext,
  LocalBackupUiRestoreStageOperations,
} from './local-backup-ui-restore-stage-protocol';
import {
  LOCAL_BACKUP_UI_RESTORE_STAGES,
  type LocalBackupUiRestoreMarker,
  type LocalBackupUiRestoreStage,
} from './local-backup-ui-restore-types';
import { LocalBackupUiBlackBoxRestoreService } from './local-backup-ui-black-box-restore.service';
import { canonicalizePersistedValue } from './action-queue-identity.helpers';
import type {
  LocalBackupUiBlackBoxPersistedEntry,
  LocalBackupUiBlackBoxRestoreSnapshot,
} from './local-backup-ui-black-box-restore.types';
import {
  decodeLocalBackupUiRestoreStageSnapshots,
  deriveLocalBackupUiRestoreRetryQueueRestoredItems,
  projectLocalBackupUiRestoreRetryQueueItems,
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
}

export interface LocalBackupUiRestoreActionQueueParticipant {
  confirmPrepared(): Promise<number>;
  rollback(): Promise<void>;
}

export interface LocalBackupUiRestoreStageApplyResult {
  result: unknown;
  expected?: unknown;
  verify?: (actual: unknown) => boolean | Promise<boolean>;
}

export interface LocalBackupUiRestoreStageEffect {
  apply(
    context: LocalBackupUiRestoreStageOperationContext,
    snapshots: LocalBackupUiRestoreStageSnapshots,
  ): Promise<unknown | LocalBackupUiRestoreStageApplyResult>;
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
        (context, snapshots) => this.applyAttachmentOutbox(
          input.backup,
          snapshots.attachmentOutbox,
          context,
        ),
        context => this.readAttachmentOutbox(input.ownerUserId, context),
        (snapshot, context) => this.restoreAttachmentOutbox(input.ownerUserId, snapshot, context),
      ),
      'action-queue': createStageEffect<LocalBackupUiRestoreActionQueuePreImage>(
        (context, snapshots) => this.applyActionQueue(input, snapshots.actionQueue, context),
        context => this.readActionQueue(input.ownerUserId, context),
        (_snapshot, context) => this.restoreActionQueue(input.actionQueueRestore, context),
      ),
      'retry-queue': createStageEffect<LocalBackupUiRestoreRetryQueuePreImage>(
        (context, snapshots) => this.applyRetryQueue(
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
        (context, snapshots) => this.applyDeadLetters(input, snapshots.deadLetters, context),
        context => this.readDeadLetters(input.ownerUserId, context),
        (snapshot, context) => this.restoreDeadLetters(input.ownerUserId, snapshot, context),
      ),
      conflicts: createStageEffect<LocalBackupUiRestoreStageSnapshots['conflicts']>(
        (context, snapshots) => this.applyConflicts(input, snapshots.conflicts, context),
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
  ): Promise<LocalBackupUiRestoreStageApplyResult> {
    const plan = await this.importService.prepareLocalBackupRestorePlan(
      input.data,
      input.existingProjects,
      context.checkpoint,
    );
    await context.checkpoint();
    const nextProjects = upsertLocalBackupUiRestoreProjects(
      this.projectState.getProjectsWithCurrentData(),
      plan.projects,
    );
    const nextLinks = mergeExternalSourceLinks(preImage.externalSourceLinks, plan.externalSourceLinks);
    const nextPendingLinks = mergePendingLinks(preImage.externalSourcePendingLinks, plan.externalSourceLinks);
    const importedCount = await context.runWriterMutation('external-source', async () => {
      await context.checkpoint();
      this.projectState.updateProjects(() => nextProjects);
      await context.checkpoint();
      await this.projectData.saveOfflineSnapshotAndWait(nextProjects, input.ownerUserId);
      await context.checkpoint();
      await this.externalSourceCache.saveLinks(nextLinks, input.ownerUserId);
      await context.checkpoint();
      await this.externalSourceCache.replacePendingLinksForOwner(nextPendingLinks, input.ownerUserId);
      await context.checkpoint();
      return plan.importedCount;
    });
    await this.applyProjectLocalState(input, context);
    await context.runWriterMutation('black-box', () => this.blackBoxRestore.apply(blackBox, context.checkpoint));
    return {
      result: importedCount,
      verify: actual => verifyProjectsReadback(
        actual,
        input.ownerUserId,
        context.marker().touchedProjectIds,
        nextProjects,
        nextLinks,
        nextPendingLinks,
        buildProjectLocalStateRestoreSnapshot(input.ownerUserId, input.backup.localState),
        blackBox.target,
        preImage.offlineSnapshot,
      ),
    };
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
    await context.runWriterMutation('external-source', async () => {
      await context.checkpoint();
      this.projectState.updateProjects(() => restoredProjects);
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
    preImage: LocalBackupUiRestoreStageSnapshots['attachmentOutbox'],
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<LocalBackupUiRestoreStageApplyResult> {
    const expected = deriveAttachmentUploadOutboxRestoreTarget(
      preImage,
      backup,
      context.marker().ownerUserId,
    );
    const result = await restoreAttachmentUploadOutboxFromBackup(backup, this.attachmentOutbox, {
      checkpoint: context.checkpoint,
      runWrite: write => context.runWriterMutation('attachment-outbox', write),
    });
    return { result, expected };
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

  private async applyActionQueue(
    input: LocalBackupUiRestoreStageInput,
    preImage: LocalBackupUiRestoreActionQueuePreImage,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<LocalBackupUiRestoreStageApplyResult> {
    const expectedActions = extractBackupActionQueueActions(input.backup.localState?.actionQueue);
    const preImageActions = preImage.indexedDb?.actions ?? [];
    const result = await context.runWriterMutation('action-queue', async () => {
      await context.checkpoint();
      const restoredCount = await input.actionQueueRestore.confirmPrepared();
      await context.checkpoint();
      return restoredCount;
    });
    return {
      result,
      verify: actual => verifyActionQueueReadback(
        actual,
        preImage,
        preImageActions,
        expectedActions,
        context.marker().actionQueueRestoreIdentity,
      ),
    };
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

  private async applyRetryQueue(
    ownerUserId: string,
    preImage: LocalBackupUiRestoreRetryQueuePreImage,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<LocalBackupUiRestoreStageApplyResult> {
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
    const result = await context.runWriterMutation('retry-queue', () => (
      this.retryQueue.restoreFromBackupItems(currentlyRestorableItems, ownerUserId, {
        validationNow,
        terminalEvidence: 'forbid',
      })
    ));
    return {
      result,
      verify: actual => verifyRetryQueueReadback(
        actual,
        preImage,
        currentlyRestorableItems,
        ownerUserId,
      ),
    };
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
      schemaVersion: 2,
      indexedDb: snapshot.retryQueueIndexedDbItems,
      localStorage: snapshot.retryQueueLocalStorageValue,
      restoredItems,
    };
  }

  private restoreRetryQueue(
    ownerUserId: string,
    snapshot: LocalBackupUiRestoreRetryQueuePreImage,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<void> {
    return context.runWriterMutation('retry-queue', () => restoreRetryQueueRestoreSnapshot(
      ownerUserId,
      {
        retryQueueIndexedDbItems: snapshot.indexedDb,
        retryQueueLocalStorageValue: snapshot.localStorage,
      },
      snapshot.restoredItems,
      () => true,
      context.checkpoint,
    ));
  }

  private async applyDeadLetters(
    input: LocalBackupUiRestoreStageInput,
    preImage: LocalBackupUiRestoreDeadLetterPreImage,
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<LocalBackupUiRestoreStageApplyResult> {
    const expected = deriveDeadLetterRestoreTarget(
      preImage,
      input.backup,
      input.ownerUserId,
    );
    const result = await context.runWriterMutation('action-queue', async () => {
      await context.checkpoint();
      const count = restoreDeadLettersFromBackup(
        input.backup,
        input.ownerUserId,
        this.actionQueueStorage,
      );
      await context.checkpoint();
      return count;
    });
    return {
      result,
      verify: actual => verifyDeadLetterReadback(actual, expected, input.ownerUserId),
    };
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

  private async applyConflicts(
    input: LocalBackupUiRestoreStageInput,
    preImage: LocalBackupUiRestoreStageSnapshots['conflicts'],
    context: LocalBackupUiRestoreStageOperationContext,
  ): Promise<LocalBackupUiRestoreStageApplyResult> {
    const incoming = decodeConflictsFromBackup(input.backup, input.ownerUserId);
    const expected = projectConflictRestoreSnapshot(preImage, incoming, input.ownerUserId);
    const result = await restoreConflictsFromBackup(
      input.backup,
      input.ownerUserId,
      this.conflictStorage,
      {
        checkpoint: context.checkpoint,
        runWrite: write => context.runWriterMutation('conflicts', write),
      },
    );
    return { result, expected };
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
  ): Promise<LocalBackupUiRestoreStageApplyResult> {
    const plan = buildDataSafetyMetadataRestorePlan(input.backup, input.ownerUserId, preImage);
    await this.metadataRestore.replaceAtomically(
      input.ownerUserId,
      plan.target,
      preImage,
      context.checkpoint,
    );
    await context.checkpoint();
    return { result: plan.counts, expected: plan.target };
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

interface LocalBackupUiRestoreStageReadbackExpectation {
  expected?: string;
  verify?: (actual: unknown) => boolean | Promise<boolean>;
}

export function createLocalBackupUiRestoreStageOperations(
  input: LocalBackupUiRestoreStageInput,
  dependencies: LocalBackupUiRestoreStageOperationDependencies,
): LocalBackupUiRestoreStageOperations {
  let snapshots: LocalBackupUiRestoreStageSnapshots | null = null;
  const appliedReadBack = new Map<
    LocalBackupUiRestoreStage,
    LocalBackupUiRestoreStageReadbackExpectation
  >();
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
  };
}

async function applyLocalBackupUiRestoreStage(
  input: LocalBackupUiRestoreStageInput,
  dependencies: LocalBackupUiRestoreStageOperationDependencies,
  requireSnapshots: () => LocalBackupUiRestoreStageSnapshots,
  appliedReadBack: Map<LocalBackupUiRestoreStage, LocalBackupUiRestoreStageReadbackExpectation>,
  stage: LocalBackupUiRestoreStage,
  context: LocalBackupUiRestoreStageOperationContext,
): Promise<unknown> {
  const decoded = requireSnapshots();
  const guarded = guardOperationContext(input, context);
  const applied = await dependencies.effects[stage].apply(guarded, decoded);
  const result = isStageApplyResult(applied) ? applied : null;
  if (!result
    || (!result.verify && !Object.prototype.hasOwnProperty.call(result, 'expected'))) {
    throw new Error(`local backup UI restore ${stage} apply did not provide an independent target`);
  }
  appliedReadBack.set(stage, {
    ...(result.verify ? { verify: result.verify } : {}),
    ...(Object.prototype.hasOwnProperty.call(result, 'expected')
      ? { expected: serializeLocalBackupUiRestoreStageSnapshot(stage, result.expected) }
      : {}),
  });
  return result.result;
}

async function verifyAppliedLocalBackupUiRestoreStage(
  input: LocalBackupUiRestoreStageInput,
  dependencies: LocalBackupUiRestoreStageOperationDependencies,
  requireSnapshots: () => LocalBackupUiRestoreStageSnapshots,
  appliedReadBack: ReadonlyMap<LocalBackupUiRestoreStage, LocalBackupUiRestoreStageReadbackExpectation>,
  stage: LocalBackupUiRestoreStage,
  context: LocalBackupUiRestoreStageOperationContext,
): Promise<void> {
  const decoded = requireSnapshots();
  const guarded = guardOperationContext(input, context);
  const expectation = appliedReadBack.get(stage);
  const actualValue = await dependencies.effects[stage].read(guarded, decoded);
  if (expectation === undefined) {
    throw new Error(`local backup UI restore ${stage} durable read-back verification failed`);
  }
  if (expectation.verify) {
    if (!await expectation.verify(actualValue)) {
      throw new Error(`local backup UI restore ${stage} durable read-back verification failed`);
    }
    return;
  }
  const expected = expectation.expected;
  const actual = serializeLocalBackupUiRestoreStageSnapshot(stage, actualValue);
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

function isStageApplyResult(value: unknown): value is LocalBackupUiRestoreStageApplyResult {
  if (!isRecordValue(value) || !Object.prototype.hasOwnProperty.call(value, 'result')) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(value, 'expected')
    || typeof value['verify'] === 'function';
}

function verifyProjectsReadback(
  actual: unknown,
  ownerUserId: string,
  touchedProjectIds: readonly string[],
  nextProjects: readonly Project[],
  nextLinks: readonly unknown[],
  nextPendingLinks: readonly unknown[],
  localStateTarget: ReturnType<typeof buildProjectLocalStateRestoreSnapshot>,
  blackBoxTarget: readonly LocalBackupUiBlackBoxPersistedEntry[],
  preImageOfflineSnapshot?: LocalBackupUiRestoreProjectPreImage['offlineSnapshot'],
): boolean {
  if (!isRecordValue(actual)) return false;
  const projectById = new Map(nextProjects.map(project => [project.id, project]));
  const expected = {
    schemaVersion: 1,
    projects: touchedProjectIds.map(projectId => ({
      projectId,
      existed: projectById.has(projectId),
      project: projectById.get(projectId) ?? null,
    })),
    externalSourceLinks: nextLinks,
    externalSourcePendingLinks: nextPendingLinks,
    offlineSnapshot: null,
    dockSnapshot: localStateTarget.dockSnapshotRestoreSnapshot,
    launchSnapshot: localStateTarget.launchSnapshotRestoreSnapshot,
    parkedTaskCache: localStateTarget.parkedTaskCacheRestoreSnapshot,
    blackBox: blackBoxTarget,
  };
  const comparableActual = { ...actual, offlineSnapshot: null };
  if (canonicalizePersistedValue(comparableActual) !== canonicalizePersistedValue(expected)) {
    return false;
  }
  return verifyOfflineSnapshotReadback(
    actual['offlineSnapshot'],
    ownerUserId,
    nextProjects,
    preImageOfflineSnapshot,
  );
}

function verifyOfflineSnapshotReadback(
  actual: unknown,
  ownerUserId: string,
  nextProjects: readonly Project[],
  preImage?: LocalBackupUiRestoreProjectPreImage['offlineSnapshot'],
): boolean {
  if (!isRecordValue(actual)) return false;
  const expectedProjects = nextProjects.map(project => normalizeOfflineSnapshotProject(project));
  const verifyPayload = (raw: unknown): boolean => {
    if (typeof raw !== 'string') return false;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed['ownerUserId'] === ownerUserId
        && typeof parsed['savedAt'] === 'string'
        && Array.isArray(parsed['projects'])
        && canonicalizePersistedValue(parsed['projects'])
          === canonicalizePersistedValue(expectedProjects);
    } catch {
      return false;
    }
  };
  if (!verifyPayload(actual['scopedLocalStorageValue'])) return false;
  const indexedDb = actual['scopedIndexedDbRecord'];
  if (indexedDb === null) {
    return preImage?.scopedIndexedDbRecord === null;
  }
  if (!isRecordValue(indexedDb)
    || indexedDb['id'] !== `offline-snapshot:${ownerUserId}`
    || indexedDb['ownerUserId'] !== ownerUserId) {
    return false;
  }
  return verifyPayload(indexedDb['data']);
}

function verifyActionQueueReadback(
  actual: unknown,
  preImage: LocalBackupUiRestoreActionQueuePreImage,
  preImageActions: readonly unknown[],
  restoredActions: readonly unknown[],
  identity: LocalBackupUiRestoreMarker['actionQueueRestoreIdentity'],
): boolean {
  if (!isRecordValue(actual) || actual['localStorage'] !== preImage.localStorage) return false;
  const record = actual['indexedDb'];
  if (!isRecordValue(record)
    || record['id'] !== identity.recordId
    || record['ownerUserId'] !== identity.ownerUserId
    || !Array.isArray(record['actions'])
    || canonicalizePersistedValue(record['actions'])
      !== canonicalizePersistedValue([...preImageActions, ...restoredActions])) {
    return false;
  }
  const transition = record['personalRestoreTransition'];
  const preparedReceipt = isRecordValue(transition)
    && isRecordValue(transition['preparedReceipt'])
    ? transition['preparedReceipt']
    : null;
  if (!isRecordValue(transition)
    || transition['state'] !== 'prepared'
    || transition['id'] !== identity.identityDigest
    || !preparedReceipt
    || preparedReceipt['identityDigest'] !== identity.identityDigest
    || preparedReceipt['ownerUserId'] !== identity.ownerUserId
    || !Array.isArray(transition['preimage'])
    || !Array.isArray(transition['restoredActions'])) {
    return false;
  }
  return canonicalizePersistedValue(transition['preimage'])
      === canonicalizePersistedValue(preImageActions)
    && canonicalizePersistedValue(transition['restoredActions'])
      === canonicalizePersistedValue(restoredActions);
}

function verifyRetryQueueReadback(
  actual: unknown,
  preImage: LocalBackupUiRestoreRetryQueuePreImage,
  restoredItems: readonly Record<string, unknown>[],
  ownerUserId: string,
): boolean {
  if (!isRecordValue(actual) || actual['schemaVersion'] !== 2
    || !Array.isArray(actual['indexedDb'])
    || !Array.isArray(actual['restoredItems'])) {
    return false;
  }
  let localItems: unknown[] = [];
  if (actual['localStorage'] !== null) {
    if (typeof actual['localStorage'] !== 'string') return false;
    try {
      const parsed = JSON.parse(actual['localStorage']) as Record<string, unknown>;
      if (parsed['version'] !== 1 || !Array.isArray(parsed['items'])) return false;
      localItems = parsed['items'];
    } catch {
      return false;
    }
  }
  const indexedDbItems = actual['indexedDb'] as unknown[];
  if (!hasUniquePersistedItems(indexedDbItems) || !hasUniquePersistedItems(localItems)) {
    return false;
  }
  let target: unknown[];
  try {
    target = projectLocalBackupUiRestoreRetryQueueItems(preImage, restoredItems, ownerUserId);
  } catch {
    return false;
  }
  let expectedRestoredItems: unknown[];
  try {
    expectedRestoredItems = deriveLocalBackupUiRestoreRetryQueueRestoredItems(
      preImage,
      { indexedDb: target as Record<string, unknown>[], localStorage: null },
      ownerUserId,
    );
  } catch {
    return false;
  }
  return samePersistedItemSet(
    [...indexedDbItems, ...localItems],
    target,
  ) && samePersistedItemSet(actual['restoredItems'], expectedRestoredItems);
}

function verifyDeadLetterReadback(
  actual: unknown,
  expected: DeadLetterRestoreTargetSnapshot,
  ownerUserId: string,
): boolean {
  if (!isRecordValue(actual)) return false;
  const actualLocalStorage = actual['localStorage'];
  if (expected.localStorage === null) {
    if (actualLocalStorage !== null) return false;
  } else {
    if (typeof actualLocalStorage !== 'string') return false;
    try {
      if (canonicalizePersistedValue(JSON.parse(actualLocalStorage))
        !== canonicalizePersistedValue(JSON.parse(expected.localStorage))) return false;
    } catch {
      return false;
    }
  }
  const actualIndexedDb = actual['indexedDb'];
  if (actualIndexedDb === null) return expected.indexedDb === null;
  if (!isRecordValue(actualIndexedDb)
    || !Array.isArray(actualIndexedDb['deadLetters'])) {
    return false;
  }
  if (expected.indexedDb) {
    if (actualIndexedDb['ownerUserId'] !== expected.indexedDb.ownerUserId
      || actualIndexedDb['id'] !== expected.indexedDb.id) return false;
  } else if (actualIndexedDb['ownerUserId'] !== ownerUserId
    || actualIndexedDb['id'] !== `dead-letter-backup:${ownerUserId}`
    || expected.localStorage === null) {
    return false;
  }
  const expectedQueue = expected.indexedDb?.deadLetters
    ?? parseDeadLetterItems(expected.localStorage);
  return canonicalizePersistedValue(actualIndexedDb['deadLetters'])
    === canonicalizePersistedValue(expectedQueue);
}

function parseDeadLetterItems(value: string | null): unknown[] {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function samePersistedItemSet(left: readonly unknown[], right: readonly unknown[]): boolean {
  const leftSet = new Set(left.map(item => canonicalizePersistedValue(item)));
  const rightSet = new Set(right.map(item => canonicalizePersistedValue(item)));
  return leftSet.size === rightSet.size && [...leftSet].every(item => rightSet.has(item));
}

function hasUniquePersistedItems(items: readonly unknown[]): boolean {
  const identities = new Set(items.map(item => canonicalizePersistedValue(item)));
  return identities.size === items.length;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
