import { Injectable, inject } from '@angular/core';

import { SYNC_CONFIG } from '../config';
import { AUTH_CONFIG } from '../config/auth.config';
import { RetryQueueService } from '../core-bridge';
import type { Project } from '../models';
import { ExternalSourceCacheService } from '../app/core/external-sources/external-source-cache.service';
import { AuthService } from './auth.service';
import {
  AttachmentUploadOutboxService,
  type PendingAttachmentUploadRecord,
} from './attachment-upload-outbox.service';
import { BackupDataSafetyMetadataRestoreService } from './backup-data-safety-metadata-restore.service';
import { blobToBase64 } from './disaster-backup-blob.helpers';
import {
  readLocalStateRestoreSnapshot,
  type LocalStateRestoreSnapshot,
} from './data-safety-indexeddb-local-state';
import type { DataSafetyMetadataRestoreState } from './import-backup-data-safety-metadata.helpers';
import { normalizeLocalBackupUiRestoreRetryQueueFootprint } from './local-backup-ui-restore-stage-snapshots';
import { ProjectStateService } from './project-state.service';
import type {
  LocalBackupUiRestoreJsonValue,
  LocalBackupUiRestorePreImage,
} from './local-backup-ui-restore-types';

export interface CaptureLocalBackupUiRestorePreImageInput {
  ownerUserId: string;
  touchedProjectIds: readonly string[];
  currentProjects: readonly Project[];
  retryQueueRestoreItems: readonly unknown[];
}

export interface LocalBackupUiRestorePreImageReaders {
  readLocalStateSnapshot(ownerUserId: string): Promise<LocalStateRestoreSnapshot>;
  readMetadata(
    ownerUserId: string,
    touchedProjectIds: ReadonlySet<string>,
  ): Promise<DataSafetyMetadataRestoreState | unknown>;
  readExternalLinks(ownerUserId: string): Promise<unknown[]>;
  readExternalPendingLinks(ownerUserId: string): Promise<unknown[]>;
  readAttachmentUploads(ownerUserId: string): Promise<PendingAttachmentUploadRecord[]>;
  encodeBlob(blob: Blob): Promise<string>;
}

@Injectable({ providedIn: 'root' })
export class LocalBackupUiRestorePreImageService {
  private readonly authService = inject(AuthService);
  private readonly metadata = inject(BackupDataSafetyMetadataRestoreService);
  private readonly projectState = inject(ProjectStateService);
  private readonly externalSourceCache = inject(ExternalSourceCacheService);
  private readonly attachmentUploadOutbox = inject(AttachmentUploadOutboxService, { optional: true });
  private readonly retryQueue = inject(RetryQueueService);

  capture(input: CaptureLocalBackupUiRestorePreImageInput): Promise<LocalBackupUiRestorePreImage> {
    const currentProjects = this.readCurrentProjects(input.ownerUserId);
    return captureLocalBackupUiRestorePreImage({ ...input, currentProjects }, {
      readLocalStateSnapshot: ownerUserId => readLocalStateRestoreSnapshot(ownerUserId),
      readMetadata: (ownerUserId, touchedProjectIds) => (
        this.metadata.readCurrent(ownerUserId, touchedProjectIds)
      ),
      readExternalLinks: ownerUserId => this.externalSourceCache.loadLinks(ownerUserId),
      readExternalPendingLinks: ownerUserId => this.externalSourceCache.loadPendingLinks(ownerUserId),
      readAttachmentUploads: ownerUserId => (
        this.attachmentUploadOutbox?.listPendingUploads(ownerUserId, {
          restoreSnapshot: true,
        }) ?? Promise.resolve([])
      ),
      encodeBlob: blobToBase64,
    }, {
      now: Date.now(),
      maxItemAgeMs: SYNC_CONFIG.MAX_RETRY_ITEM_AGE,
      maxRetries: this.retryQueue.MAX_RETRIES,
    });
  }

  private readCurrentProjects(ownerUserId: string): Project[] {
    this.assertCurrentOwner(ownerUserId);
    const projects = this.projectState.getProjectsWithCurrentData();
    this.assertCurrentOwner(ownerUserId);
    return projects;
  }

  private assertCurrentOwner(ownerUserId: string): void {
    const currentOwner = this.authService.currentUserId() || AUTH_CONFIG.LOCAL_MODE_USER_ID;
    if (currentOwner !== ownerUserId) {
      throw new Error('local backup UI restore pre-image owner changed');
    }
  }
}

export async function captureLocalBackupUiRestorePreImage(
  input: CaptureLocalBackupUiRestorePreImageInput,
  readers: LocalBackupUiRestorePreImageReaders,
  retryQueuePolicy: Parameters<typeof normalizeLocalBackupUiRestoreRetryQueueFootprint>[2],
): Promise<LocalBackupUiRestorePreImage> {
  const sources = await readPreImageSources(input, readers, retryQueuePolicy);
  const attachmentOutbox = await encodeAttachmentOutbox(
    input.ownerUserId,
    sources.attachmentUploads,
    readers.encodeBlob,
  );
  return toJsonValue(
    buildPreImageCandidate(sources, attachmentOutbox),
    'local backup UI restore pre-image',
  ) as unknown as LocalBackupUiRestorePreImage;
}

interface LocalBackupUiRestorePreImageSources {
  touchedProjectIds: string[];
  currentProjects: Map<string, Project>;
  localState: LocalStateRestoreSnapshot;
  metadata: unknown;
  externalSourceLinks: unknown[];
  externalSourcePendingLinks: unknown[];
  attachmentUploads: PendingAttachmentUploadRecord[];
  retryQueueRestoreItems: Record<string, unknown>[];
}

async function readPreImageSources(
  input: CaptureLocalBackupUiRestorePreImageInput,
  readers: LocalBackupUiRestorePreImageReaders,
  retryQueuePolicy: Parameters<typeof normalizeLocalBackupUiRestoreRetryQueueFootprint>[2],
): Promise<LocalBackupUiRestorePreImageSources> {
  const touchedProjectIds = normalizeTouchedProjectIds(input.touchedProjectIds);
  const touchedProjectIdSet = new Set(touchedProjectIds);
  const currentProjects = new Map(input.currentProjects.map(project => [project.id, project]));
  const retryQueueRestoreItems = normalizeLocalBackupUiRestoreRetryQueueFootprint(
    input.retryQueueRestoreItems,
    input.ownerUserId,
    retryQueuePolicy,
  );
  const [
    localState,
    metadata,
    externalSourceLinks,
    externalSourcePendingLinks,
    attachmentUploads,
  ] = await Promise.all([
    readers.readLocalStateSnapshot(input.ownerUserId),
    readers.readMetadata(input.ownerUserId, touchedProjectIdSet),
    readers.readExternalLinks(input.ownerUserId),
    readers.readExternalPendingLinks(input.ownerUserId),
    readers.readAttachmentUploads(input.ownerUserId),
  ]);
  return {
    touchedProjectIds,
    currentProjects,
    localState,
    metadata,
    externalSourceLinks,
    externalSourcePendingLinks,
    attachmentUploads,
    retryQueueRestoreItems,
  };
}

async function encodeAttachmentOutbox(
  ownerUserId: string,
  attachmentUploads: PendingAttachmentUploadRecord[],
  encodeBlob: (blob: Blob) => Promise<string>,
) {
  return await Promise.all(attachmentUploads.map(async upload => {
    if (upload.ownerUserId !== ownerUserId) {
      throw new Error('local backup UI restore attachment pre-image owner mismatch');
    }
    return {
      ownerUserId: upload.ownerUserId,
      operationId: upload.operationId,
      attachmentId: upload.attachmentId,
      blobKey: upload.blobKey,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      size: upload.size,
      createdAt: upload.createdAt,
      encoding: 'base64' as const,
      blobBase64: await encodeBlob(upload.blob),
    };
  }));
}

function buildPreImageCandidate(
  sources: LocalBackupUiRestorePreImageSources,
  attachmentOutbox: Awaited<ReturnType<typeof encodeAttachmentOutbox>>,
): unknown {
  const { touchedProjectIds, currentProjects, localState } = sources;
  return {
    projectState: buildProjectStateCandidate(sources, touchedProjectIds, currentProjects),
    attachmentOutbox,
    actionQueue: {
      indexedDb: localState.actionQueueBackupRecord,
      localStorage: localState.actionQueueLocalStorageValue,
    },
    retryQueue: {
      schemaVersion: 2,
      indexedDb: localState.retryQueueIndexedDbItems,
      localStorage: localState.retryQueueLocalStorageValue,
      restoredItems: sources.retryQueueRestoreItems,
    },
    deadLetters: {
      indexedDb: localState.deadLetterBackupRecord,
      localStorage: localState.deadLetterLocalStorageValue,
    },
    conflicts: localState.conflictRestoreSnapshot ?? null,
    metadata: sources.metadata,
  };
}

function buildProjectStateCandidate(
  sources: LocalBackupUiRestorePreImageSources,
  touchedProjectIds: readonly string[],
  currentProjects: ReadonlyMap<string, Project>,
): unknown {
  const { localState } = sources;
  return {
    schemaVersion: 1,
    projects: touchedProjectIds.map(projectId => ({
      projectId,
      existed: currentProjects.has(projectId),
      project: currentProjects.get(projectId) ?? null,
    })),
    externalSourceLinks: sources.externalSourceLinks,
    externalSourcePendingLinks: sources.externalSourcePendingLinks,
    offlineSnapshot: localState.offlineSnapshotRestoreSnapshot ?? null,
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
  };
}

function normalizeTouchedProjectIds(projectIds: readonly string[]): string[] {
  if (projectIds.some(projectId => typeof projectId !== 'string' || projectId.length === 0)) {
    throw new Error('local backup UI restore touched project IDs are invalid');
  }
  const uniqueIds = new Set(projectIds);
  if (uniqueIds.size !== projectIds.length) {
    throw new Error('local backup UI restore touched project IDs must be unique');
  }
  return Array.from(uniqueIds).sort();
}

function toJsonValue(value: unknown, label: string): LocalBackupUiRestoreJsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('value is undefined');
    return JSON.parse(serialized) as LocalBackupUiRestoreJsonValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not JSON serializable: ${message}`);
  }
}
