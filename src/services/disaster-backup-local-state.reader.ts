import { FOCUS_CONFIG } from '../config/focus.config';
import { PARKING_CONFIG } from '../config/parking.config';
import type {
  BackupLocalState,
  BackupPendingAttachmentUpload,
} from '../../supabase/functions/_shared/backup-utils';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';
import type { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';
import { blobToBase64 } from './disaster-backup-blob.helpers';
import {
  getAllFromStore,
  getByKey,
  openExistingDb,
  readOwnerScopedLocalStorage,
  resolveRetryQueueItemOwner,
  safeGetLocalStorage,
  safeParseJson,
} from './disaster-backup-browser-storage.helpers';
import { buildDisasterBackupDataSafetySnapshot } from './disaster-backup-data-safety.helpers';
import {
  filterConnectionTombstonesByVisibleProjects,
  filterTaskTombstonesByVisibleProjects,
  isLaunchSnapshotOwnedByCurrentUser,
  pickNewerDockSnapshot,
  toDockSnapshotCandidate,
} from './disaster-backup-local-state.helpers';
import type { DataSafetyAuditPersistence } from './data-safety-audit-persistence';
import type { ConflictStorageService } from './conflict-storage.service';
import type { ExternalSourceCacheService } from '../app/core/external-sources/external-source-cache.service';

const ACTION_QUEUE_BACKUP_DB_NAME = 'nanoflow-queue-backup';
const ACTION_QUEUE_BACKUP_STORE_NAME = 'queue-backup';
const DOCK_SNAPSHOT_IDB_DB_NAME = 'keyval-store';
const DOCK_SNAPSHOT_IDB_STORE_NAME = 'keyval';
const DOCK_SNAPSHOT_IDB_KEY_PREFIX = 'nanoflow.focus-session.v5';
const OFFLINE_SNAPSHOT_STORAGE_KEY = 'nanoflow.offline-cache-v2';
const OFFLINE_SNAPSHOT_RECORD_PREFIX = 'offline-snapshot:';
const LAUNCH_SNAPSHOT_STORAGE_KEY_V1 = 'nanoflow.launch-snapshot.v1';
const LAUNCH_SNAPSHOT_STORAGE_KEY_V2 = 'nanoflow.launch-snapshot.v2';

export interface DisasterBackupLocalStateReaderDeps {
  conflictStorage: Pick<ConflictStorageService, 'getAllConflicts'>;
  externalSourceCache: Pick<ExternalSourceCacheService, 'loadPendingLinks'>;
  attachmentUploadOutbox: Pick<AttachmentUploadOutboxService, 'listPendingUploads'> | null;
  dataSafetyAuditPersistence: DataSafetyAuditPersistence;
}

interface DisasterBackupLocalStateParts {
  indexedSnapshot: string | null;
  dockSnapshot: BackupLocalState['dockSnapshot'];
  launchSnapshot: BackupLocalState['launchSnapshot'];
  parkedTaskCache: BackupLocalState['parkedTaskCache'];
  retryQueue: unknown[];
  actionQueue: unknown;
  deadLetters: unknown[];
  conflicts: BackupLocalState['conflicts'];
  externalSourcePendingLinks: BackupLocalState['externalSourcePendingLinks'];
  attachmentUploadOutbox: BackupPendingAttachmentUpload[];
}

export class DisasterBackupLocalStateReader {
  constructor(private readonly deps: DisasterBackupLocalStateReaderDeps) {}

  async readLocalState(
    ownerUserId: string | null,
    visibleProjectIds: Set<string>,
  ): Promise<BackupLocalState> {
    const parts = await this.readLocalStateParts(ownerUserId, visibleProjectIds);
    return this.buildLocalState(ownerUserId, visibleProjectIds, parts);
  }

  private async readLocalStateParts(
    ownerUserId: string | null,
    visibleProjectIds: Set<string>,
  ): Promise<DisasterBackupLocalStateParts> {
    const [
      indexedSnapshot,
      dockSnapshot,
      launchSnapshot,
      parkedTaskCache,
      retryQueue,
      actionQueue,
      deadLetters,
      conflicts,
      externalSourcePendingLinks,
      attachmentUploadOutbox,
    ] = await Promise.all([
      this.readSnapshotFromIndexedDb(ownerUserId),
      this.readDockSnapshot(ownerUserId),
      this.readLaunchSnapshot(ownerUserId),
      this.readParkedTaskCache(visibleProjectIds),
      this.readRetryQueue(ownerUserId),
      this.readActionQueue(ownerUserId),
      this.readDeadLetters(ownerUserId),
      this.deps.conflictStorage.getAllConflicts(),
      this.deps.externalSourceCache.loadPendingLinks(),
      this.readAttachmentUploadOutbox(),
    ]);

    return {
      indexedSnapshot,
      dockSnapshot,
      launchSnapshot,
      parkedTaskCache,
      retryQueue,
      actionQueue,
      deadLetters,
      conflicts,
      externalSourcePendingLinks,
      attachmentUploadOutbox,
    };
  }

  private buildLocalState(
    ownerUserId: string | null,
    visibleProjectIds: Set<string>,
    parts: DisasterBackupLocalStateParts,
  ): BackupLocalState {
    return {
      offlineSnapshot: {
        localStorage: this.readOfflineSnapshotFromLocalStorage(ownerUserId),
        indexedDb: parts.indexedSnapshot,
      },
      dockSnapshot: parts.dockSnapshot,
      launchSnapshot: parts.launchSnapshot,
      parkedTaskCache: parts.parkedTaskCache,
      retryQueue: parts.retryQueue,
      actionQueue: parts.actionQueue,
      deadLetters: parts.deadLetters,
      conflicts: parts.conflicts,
      taskTombstones: this.readTaskTombstones(visibleProjectIds),
      connectionTombstones: this.readConnectionTombstones(visibleProjectIds),
      externalSourcePendingLinks: parts.externalSourcePendingLinks,
      attachmentUploadOutbox: parts.attachmentUploadOutbox,
      dataSafety: buildDisasterBackupDataSafetySnapshot({
        ownerUserId,
        retryQueue: parts.retryQueue,
        actionQueue: parts.actionQueue,
        deadLetters: parts.deadLetters,
        dataSafetyAuditPersistence: this.deps.dataSafetyAuditPersistence,
      }),
    };
  }

  private async readAttachmentUploadOutbox(): Promise<BackupPendingAttachmentUpload[]> {
    if (!this.deps.attachmentUploadOutbox) {
      return [];
    }

    const pendingUploads = await this.deps.attachmentUploadOutbox.listPendingUploads();
    return Promise.all(pendingUploads.map(async (upload) => ({
      attachmentId: upload.attachmentId,
      blobKey: upload.blobKey,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      size: upload.size,
      createdAt: upload.createdAt,
      encoding: 'base64' as const,
      blobBase64: await blobToBase64(upload.blob),
    })));
  }

  private readTaskTombstones(visibleProjectIds: Set<string>): Record<string, unknown> {
    const parsed = safeParseJson(safeGetLocalStorage('nanoflow.local-tombstones'));
    return filterTaskTombstonesByVisibleProjects(parsed, visibleProjectIds);
  }

  private readConnectionTombstones(visibleProjectIds: Set<string>): unknown[] {
    const parsed = safeParseJson(safeGetLocalStorage('nanoflow.local-connection-tombstones'));
    return filterConnectionTombstonesByVisibleProjects(parsed, visibleProjectIds);
  }

  private async readSnapshotFromIndexedDb(ownerUserId: string | null): Promise<string | null> {
    if (!ownerUserId) {
      return null;
    }

    const db = await openExistingDb('nanoflow-offline-snapshots');
    if (!db) return null;

    try {
      const row = await getByKey<{ data?: string }>(
        db,
        'snapshots',
        `${OFFLINE_SNAPSHOT_RECORD_PREFIX}${ownerUserId}`,
      );
      return typeof row?.data === 'string' ? row.data : null;
    } finally {
      db.close();
    }
  }

  private readOfflineSnapshotFromLocalStorage(ownerUserId: string | null): string | null {
    if (!ownerUserId) {
      return null;
    }

    return safeGetLocalStorage(`${OFFLINE_SNAPSHOT_STORAGE_KEY}.${ownerUserId}`);
  }

  private async readDockSnapshot(
    ownerUserId: string | null,
  ): Promise<{ localStorage: string | null; indexedDb: unknown | null } | undefined> {
    const db = await openExistingDb(DOCK_SNAPSHOT_IDB_DB_NAME);
    const scope = ownerUserId ?? 'anonymous';
    const currentIdbKey = `${DOCK_SNAPSHOT_IDB_KEY_PREFIX}.${scope}`;
    const currentLegacyKey = `${PARKING_CONFIG.DOCK_SNAPSHOT_STORAGE_KEY}.${scope}`;

    const currentIdbSnapshot = db
      ? await getByKey<unknown>(db, DOCK_SNAPSHOT_IDB_STORE_NAME, currentIdbKey)
      : null;

    if (db) {
      db.close();
    }

    const newestIndexedDb = pickNewerDockSnapshot(
      toDockSnapshotCandidate('idb-current', currentIdbSnapshot),
      null,
    );
    const newestLegacy = pickNewerDockSnapshot(
      toDockSnapshotCandidate('legacy-current', safeGetLocalStorage(currentLegacyKey)),
      null,
    );

    if (!newestIndexedDb && !newestLegacy) {
      return undefined;
    }

    return {
      localStorage: newestLegacy?.localStorageValue ?? null,
      indexedDb: newestIndexedDb?.snapshot ?? null,
    };
  }

  private async readLaunchSnapshot(
    ownerUserId: string | null,
  ): Promise<{ v1: string | null; v2: string | null } | undefined> {
    const v1 = this.readOwnerScopedLaunchSnapshot(LAUNCH_SNAPSHOT_STORAGE_KEY_V1, ownerUserId);
    const v2 = this.readOwnerScopedLaunchSnapshot(LAUNCH_SNAPSHOT_STORAGE_KEY_V2, ownerUserId);

    if (!v1 && !v2) {
      return undefined;
    }

    return { v1, v2 };
  }

  private readOwnerScopedLaunchSnapshot(storageKey: string, ownerUserId: string | null): string | null {
    const raw = safeGetLocalStorage(storageKey);
    if (!raw) {
      return null;
    }

    const parsed = safeParseJson(raw);
    if (!isLaunchSnapshotOwnedByCurrentUser(parsed, ownerUserId)) {
      return null;
    }

    return raw;
  }

  private async readParkedTaskCache(
    visibleProjectIds: Set<string>,
  ): Promise<{ entries: unknown[]; syncMetadata: Record<string, unknown> }> {
    const db = await openExistingDb(FOCUS_CONFIG.SYNC.IDB_NAME);
    if (!db) {
      return { entries: [], syncMetadata: {} };
    }

    try {
      const [entries, metadataRows] = await Promise.all([
        getAllFromStore(db, FOCUS_CONFIG.IDB_STORES.PARKED_TASKS),
        getAllFromStore<{ key: string; value: unknown }>(db, FOCUS_CONFIG.IDB_STORES.SYNC_METADATA),
      ]);

      const syncMetadata = Object.fromEntries(
        metadataRows
          .filter((row): row is { key: string; value: unknown } => !!row && typeof row.key === 'string')
          .map((row) => [row.key, row.value]),
      );

      const filteredEntries = entries.filter((entry) => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }

        const projectId = 'projectId' in entry ? entry.projectId : null;
        return typeof projectId === 'string' && visibleProjectIds.has(projectId);
      });

      return {
        entries: filteredEntries,
        syncMetadata: filteredEntries.length > 0 ? syncMetadata : {},
      };
    } finally {
      db.close();
    }
  }

  private async readRetryQueue(ownerUserId: string | null): Promise<unknown[]> {
    if (!ownerUserId) {
      return [];
    }

    const db = await openExistingDb('nanoflow-retry-queue');
    const items = db
      ? await (async () => {
          try {
            return await getAllFromStore(db, 'offline_mutation_queue');
          } finally {
            db.close();
          }
        })()
      : (safeParseJson(safeGetLocalStorage('nanoflow.retry-queue')) ?? []) as unknown[];

    return items.filter((item) => resolveRetryQueueItemOwner(item) === ownerUserId);
  }

  private async readActionQueue(ownerUserId: string | null): Promise<unknown> {
    if (!ownerUserId) {
      return null;
    }

    const localSnapshot = safeParseJson(
      readOwnerScopedLocalStorage(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, ownerUserId),
    );
    if (localSnapshot !== null) {
      return localSnapshot;
    }

    const db = await openExistingDb(ACTION_QUEUE_BACKUP_DB_NAME);
    if (!db) {
      return null;
    }

    try {
      const queueRecordId = `queue-backup:${ownerUserId}`;
      const record = await getByKey<{ actions?: unknown }>(db, ACTION_QUEUE_BACKUP_STORE_NAME, queueRecordId);
      return record?.actions ?? null;
    } finally {
      db.close();
    }
  }

  private async readDeadLetters(ownerUserId: string | null): Promise<unknown[]> {
    if (!ownerUserId) {
      return [];
    }

    return (safeParseJson(
      readOwnerScopedLocalStorage(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY, ownerUserId),
    ) ?? []) as unknown[];
  }
}
