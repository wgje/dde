import { FOCUS_CONFIG } from '../config/focus.config';
import { PARKING_CONFIG } from '../config/parking.config';
import { isProjectSyncCursor } from '../app/core/state/persistence';
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
  safeGetLocalStorage,
  safeParseJson,
} from './disaster-backup-browser-storage.helpers';
import { buildDisasterBackupDataSafetySnapshot } from './disaster-backup-data-safety.helpers';
import {
  parseLegacyRetryReviewStorageValue,
  ownerScopedLegacyRetryReviewStorageKey,
} from './legacy-retry-review-backup.helpers';
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
const RETRY_QUEUE_DB_NAME = 'nanoflow-retry-queue';
const RETRY_QUEUE_STORE_NAME = 'offline_mutation_queue';
const RETRY_QUEUE_STORAGE_KEY = 'nanoflow.retry-queue';
const RETRY_QUEUE_STORAGE_VERSION = 1;
const RETRY_QUEUE_UNKNOWN_OUTCOME_FENCE_PREFIX = 'nanoflow.retry-queue.pending-unknown-outcome.';

type UnknownRecord = Record<string, unknown>;
type RetryQueueExportSource = 'IndexedDB' | 'localStorage';

interface RetryQueueExportEntry {
  item: UnknownRecord;
  source: RetryQueueExportSource;
  identity: RetryQueueExportIdentity;
}

interface RetryQueueExportIdentity {
  id: string;
  operationId: string;
  ownerUserId: string;
  entityKey: string;
}

interface RetryQueueUnknownOutcomeBackupFence {
  schemaVersion: 1;
  ownerUserId: string;
  queueItemId: string;
  entityType: 'task' | 'project' | 'connection' | 'blackbox';
  operation: 'upsert' | 'delete';
  entityId: string;
  sourceUserId: string | null;
  operationId: string;
  lastFailure: {
    errorType: string;
    message: string;
    remoteOutcome: 'unknown';
    recordedAt: number;
  };
  createdAt: number;
}

export interface DisasterBackupLocalStateReaderDeps {
  conflictStorage: Pick<ConflictStorageService, 'getAllConflicts'>;
  externalSourceCache: Pick<ExternalSourceCacheService, 'loadPendingLinks'>;
  attachmentUploadOutbox: Pick<AttachmentUploadOutboxService, 'listPendingUploads'> | null;
  dataSafetyAuditPersistence: DataSafetyAuditPersistence;
  readSyncState?: () => {
    lastSyncTime: string | null;
    pendingCount: number;
  };
}

interface DisasterBackupLocalStateParts {
  indexedSnapshot: string | null;
  dockSnapshot: BackupLocalState['dockSnapshot'];
  launchSnapshot: BackupLocalState['launchSnapshot'];
  parkedTaskCache: BackupLocalState['parkedTaskCache'];
  retryQueue: unknown[];
  legacyRetryReview: unknown[];
  actionQueue: unknown;
  deadLetters: unknown[];
  conflicts: BackupLocalState['conflicts'];
  externalSourcePendingLinks: BackupLocalState['externalSourcePendingLinks'];
  attachmentUploadOutbox: BackupPendingAttachmentUpload[];
  projectCursors: unknown[];
}

export class DisasterBackupLocalStateReader {
  constructor(private readonly deps: DisasterBackupLocalStateReaderDeps) {}

  async readLocalState(
    ownerUserId: string | null,
    visibleProjectIds: Set<string>,
    snapshotOwnerUserId: string | null = ownerUserId,
  ): Promise<BackupLocalState> {
    const parts = await this.readLocalStateParts(
      ownerUserId,
      visibleProjectIds,
      snapshotOwnerUserId,
    );
    return this.buildLocalState(
      ownerUserId,
      visibleProjectIds,
      parts,
      snapshotOwnerUserId,
    );
  }

  private async readLocalStateParts(
    ownerUserId: string | null,
    visibleProjectIds: Set<string>,
    snapshotOwnerUserId: string | null,
  ): Promise<DisasterBackupLocalStateParts> {
    const [
      indexedSnapshot,
      dockSnapshot,
      launchSnapshot,
      parkedTaskCache,
      retryQueue,
      legacyRetryReview,
      actionQueue,
      deadLetters,
      conflicts,
      externalSourcePendingLinks,
      attachmentUploadOutbox,
      projectCursors,
    ] = await Promise.all([
      this.readSnapshotFromIndexedDb(snapshotOwnerUserId),
      this.readDockSnapshot(snapshotOwnerUserId),
      this.readLaunchSnapshot(snapshotOwnerUserId),
      this.readParkedTaskCache(ownerUserId, visibleProjectIds),
      this.readRetryQueue(ownerUserId),
      this.readLegacyRetryReview(ownerUserId),
      this.readActionQueue(ownerUserId),
      this.readDeadLetters(ownerUserId),
      this.deps.conflictStorage.getAllConflicts(),
      this.deps.externalSourceCache.loadPendingLinks(),
      this.readAttachmentUploadOutbox(ownerUserId),
      this.readProjectCursors(ownerUserId, visibleProjectIds),
    ]);

    return {
      indexedSnapshot,
      dockSnapshot,
      launchSnapshot,
      parkedTaskCache,
      retryQueue,
      legacyRetryReview,
      actionQueue,
      deadLetters,
      conflicts,
      externalSourcePendingLinks,
      attachmentUploadOutbox,
      projectCursors,
    };
  }

  private buildLocalState(
    ownerUserId: string | null,
    visibleProjectIds: Set<string>,
    parts: DisasterBackupLocalStateParts,
    snapshotOwnerUserId: string | null,
  ): BackupLocalState {
    return {
      offlineSnapshot: {
        localStorage: this.readOfflineSnapshotFromLocalStorage(snapshotOwnerUserId),
        indexedDb: parts.indexedSnapshot,
      },
      dockSnapshot: parts.dockSnapshot,
      launchSnapshot: parts.launchSnapshot,
      parkedTaskCache: parts.parkedTaskCache,
      retryQueue: parts.retryQueue,
      legacyRetryReview: parts.legacyRetryReview,
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
        syncState: this.deps.readSyncState?.() ?? null,
        projectCursors: parts.projectCursors,
        dataSafetyAuditPersistence: this.deps.dataSafetyAuditPersistence,
      }),
    };
  }

  private async readProjectCursors(
    ownerUserId: string | null,
    visibleProjectIds: Set<string>,
  ): Promise<unknown[]> {
    if (!ownerUserId || visibleProjectIds.size === 0) {
      return [];
    }

    const db = await openExistingDb('nanoflow-store-cache');
    if (!db) return [];

    try {
      if (!db.objectStoreNames.contains('sync_cursors')) {
        return [];
      }

      const cursors: unknown[] = [];
      for (const projectId of [...visibleProjectIds].sort()) {
        const key = `project:${ownerUserId}:${projectId}`;
        const row = await getByKey<unknown>(db, 'sync_cursors', key);
        if (row === null) continue;
        if (!isCanonicalProjectCursorRecord(row, key, ownerUserId, projectId)) {
          throw new Error(`sync cursor record ${key} is invalid`);
        }
        cursors.push({ projectId, userId: ownerUserId, cursor: row['cursor'] });
      }
      return cursors;
    } finally {
      db.close();
    }
  }

  private async readAttachmentUploadOutbox(
    ownerUserId: string | null,
  ): Promise<BackupPendingAttachmentUpload[]> {
    if (!this.deps.attachmentUploadOutbox || !ownerUserId) {
      return [];
    }

    const pendingUploads = await this.deps.attachmentUploadOutbox.listPendingUploads(ownerUserId);
    return Promise.all(pendingUploads.map(async (upload) => ({
      ownerUserId: upload.ownerUserId,
      operationId: upload.operationId,
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
    const parsed = readTombstoneLocalStorage('nanoflow.local-tombstones', {});
    return filterTaskTombstonesByVisibleProjects(parsed, visibleProjectIds);
  }

  private readConnectionTombstones(visibleProjectIds: Set<string>): unknown[] {
    const parsed = readTombstoneLocalStorage('nanoflow.local-connection-tombstones', []);
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
    ownerUserId: string | null,
    visibleProjectIds: Set<string>,
  ): Promise<{ entries: unknown[]; syncMetadata: Record<string, unknown> }> {
    if (!ownerUserId) {
      return { entries: [], syncMetadata: {} };
    }

    const db = await openExistingDb(FOCUS_CONFIG.SYNC.IDB_NAME);
    if (!db) {
      return { entries: [], syncMetadata: {} };
    }

    try {
      const [entries, metadataRows] = await Promise.all([
        getAllFromStore(db, FOCUS_CONFIG.IDB_STORES.PARKED_TASKS),
        getAllFromStore<{ key: string; value: unknown }>(db, FOCUS_CONFIG.IDB_STORES.SYNC_METADATA),
      ]);

      const ownerCursorKey = `parking_last_sync_time:${encodeURIComponent(ownerUserId)}`;
      const syncMetadata = Object.fromEntries(
        metadataRows
          .filter((row): row is { key: string; value: unknown } =>
            !!row && row.key === ownerCursorKey)
          .map((row) => [row.key, row.value]),
      );

      const filteredEntries = entries.flatMap((entry) => {
        if (!isUnknownRecord(entry)) throw new Error('parked task cache contains an invalid owner');
        const entryOwnerUserId = nonEmptyString(entry['ownerUserId']);
        if (!entryOwnerUserId) throw new Error('parked task cache contains an invalid owner');
        if (entryOwnerUserId !== ownerUserId) return [];

        const projectId = nonEmptyString(entry['projectId']);
        if (!projectId) throw new Error('parked task cache contains an invalid project');
        if (!visibleProjectIds.has(projectId)) return [];

        const task = isUnknownRecord(entry['task']) ? entry['task'] : null;
        const taskId = nonEmptyString(entry['taskId']);
        const taskEntityId = task ? nonEmptyString(task['id']) : null;
        const updatedAt = nonEmptyString(entry['updatedAt']);
        if (!task || !taskEntityId || typeof task['content'] !== 'string'
          || taskId !== `${encodeURIComponent(ownerUserId)}:${taskEntityId}`
          || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) {
          throw new Error('parked task cache contains an invalid visible entry');
        }
        return [entry];
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

    const fallbackItems = parseRetryQueueLocalStorageItems(
      readRetryQueueLocalStorageValue(),
    );
    const db = await openExistingDb(RETRY_QUEUE_DB_NAME);
    const indexedDbItems = db
      ? await (async () => {
          try {
            return await getAllFromStore(db, RETRY_QUEUE_STORE_NAME);
          } finally {
            db.close();
          }
        })()
      : [];

    const items = mergeRetryQueueExportItems(indexedDbItems, fallbackItems, ownerUserId);
    return applyRetryQueueUnknownOutcomeFences(items, ownerUserId);
  }

  private readLegacyRetryReview(ownerUserId: string | null): unknown[] {
    if (!ownerUserId || typeof localStorage === 'undefined') {
      return [];
    }

    const key = ownerScopedLegacyRetryReviewStorageKey(ownerUserId);
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch (error) {
      throw new Error(`Legacy Retry Review read failed for ${key}: ${formatError(error)}`);
    }
    return parseLegacyRetryReviewStorageValue(raw, ownerUserId);
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

function readRetryQueueLocalStorageValue(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(RETRY_QUEUE_STORAGE_KEY);
  } catch (error) {
    throw new Error(`RetryQueue localStorage read failed: ${formatError(error)}`);
  }
}

function readTombstoneLocalStorage(key: string, absentValue: unknown): unknown {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch (error) {
    throw new Error(`Tombstone localStorage read failed for ${key}: ${formatError(error)}`);
  }
  if (raw === null) return absentValue;

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Tombstone localStorage contains invalid JSON for ${key}: ${formatError(error)}`);
  }
}

function parseRetryQueueLocalStorageItems(raw: string | null): UnknownRecord[] {
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`RetryQueue localStorage is invalid JSON: ${formatError(error)}`);
  }

  let items: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (isUnknownRecord(parsed) && Array.isArray(parsed['items'])) {
    if (parsed['version'] !== RETRY_QUEUE_STORAGE_VERSION) {
      throw new Error(`RetryQueue localStorage has unsupported version: ${String(parsed['version'])}`);
    }
    items = parsed['items'];
  }
  if (!items) {
    throw new Error('RetryQueue localStorage has invalid shape');
  }
  if (items.some(item => !isUnknownRecord(item))) {
    throw new Error('RetryQueue localStorage contains invalid item(s)');
  }
  return items as UnknownRecord[];
}

function applyRetryQueueUnknownOutcomeFences(
  queueItems: UnknownRecord[],
  ownerUserId: string,
): UnknownRecord[] {
  const fences = readRetryQueueUnknownOutcomeBackupFences(ownerUserId);
  if (fences.length === 0) return queueItems;

  const exportItems = queueItems.map(item => ({ ...item }));
  for (const fence of fences) {
    const item = exportItems.find(candidate => matchesRetryQueueUnknownOutcomeBackupFence(candidate, fence));
    if (!item) {
      throw new Error('RetryQueue pending unknown-outcome fence has no matching owner-scoped backup item');
    }
    item['lastFailure'] = { ...fence.lastFailure };
  }
  return exportItems;
}

function readRetryQueueUnknownOutcomeBackupFences(
  ownerUserId: string,
): RetryQueueUnknownOutcomeBackupFence[] {
  const key = `${RETRY_QUEUE_UNKNOWN_OUTCOME_FENCE_PREFIX}${encodeURIComponent(ownerUserId)}`;
  const latestByIdentity = new Map<string, RetryQueueUnknownOutcomeBackupFence>();

  for (const storageKind of ['local', 'session'] as const) {
    let storage: Storage | undefined;
    try {
      storage = storageKind === 'local'
        ? globalThis.localStorage
        : globalThis.sessionStorage;
    } catch (error) {
      throw new Error(`RetryQueue pending unknown-outcome ${storageKind}Storage access failed: ${formatError(error)}`);
    }
    if (typeof storage === 'undefined') continue;

    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch (error) {
      throw new Error(`RetryQueue pending unknown-outcome ${storageKind}Storage read failed: ${formatError(error)}`);
    }
    if (raw === null) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`RetryQueue pending unknown-outcome ${storageKind}Storage has invalid JSON: ${formatError(error)}`);
    }
    if (!isRetryQueueUnknownOutcomeBackupFence(parsed)
      || parsed.ownerUserId !== ownerUserId) {
      throw new Error(`RetryQueue pending unknown-outcome ${storageKind}Storage has an invalid fence`);
    }

    const identity = JSON.stringify([parsed.queueItemId, parsed.operationId]);
    const existing = latestByIdentity.get(identity);
    if (!existing || parsed.lastFailure.recordedAt > existing.lastFailure.recordedAt) {
      latestByIdentity.set(identity, parsed);
    }
  }

  return Array.from(latestByIdentity.values());
}

function isRetryQueueUnknownOutcomeBackupFence(
  value: unknown,
): value is RetryQueueUnknownOutcomeBackupFence {
  if (!isUnknownRecord(value) || !isUnknownRecord(value['lastFailure'])) return false;
  const lastFailure = value['lastFailure'];
  return value['schemaVersion'] === 1
    && typeof value['ownerUserId'] === 'string' && value['ownerUserId'].length > 0
    && typeof value['queueItemId'] === 'string' && value['queueItemId'].length > 0
    && (value['entityType'] === 'task'
      || value['entityType'] === 'project'
      || value['entityType'] === 'connection'
      || value['entityType'] === 'blackbox')
    && (value['operation'] === 'upsert' || value['operation'] === 'delete')
    && typeof value['entityId'] === 'string' && value['entityId'].length > 0
    && (value['sourceUserId'] === null
      || (typeof value['sourceUserId'] === 'string' && value['sourceUserId'].length > 0))
    && typeof value['operationId'] === 'string' && value['operationId'].length > 0
    && Number.isFinite(value['createdAt'])
    && typeof lastFailure['errorType'] === 'string'
    && typeof lastFailure['message'] === 'string'
    && lastFailure['remoteOutcome'] === 'unknown'
    && Number.isFinite(lastFailure['recordedAt']);
}

function matchesRetryQueueUnknownOutcomeBackupFence(
  item: UnknownRecord,
  fence: RetryQueueUnknownOutcomeBackupFence,
): boolean {
  const data = item['data'];
  return item['id'] === fence.queueItemId
    && item['type'] === fence.entityType
    && item['operation'] === fence.operation
    && isUnknownRecord(data)
    && data['id'] === fence.entityId
    && (item['sourceUserId'] ?? null) === fence.sourceUserId
    && item['operationId'] === fence.operationId;
}

function mergeRetryQueueExportItems(
  indexedDbItems: unknown[],
  fallbackItems: UnknownRecord[],
  ownerUserId: string,
): UnknownRecord[] {
  const merged: RetryQueueExportEntry[] = [];
  const byId = new Map<string, RetryQueueExportEntry>();
  const byOperationId = new Map<string, RetryQueueExportEntry>();
  const byEntity = new Map<string, RetryQueueExportEntry>();

  appendRetryQueueExportItems(
    merged,
    byId,
    byOperationId,
    byEntity,
    indexedDbItems,
    'IndexedDB',
  );
  appendRetryQueueExportItems(
    merged,
    byId,
    byOperationId,
    byEntity,
    fallbackItems,
    'localStorage',
  );

  return merged
    .filter(entry => entry.identity.ownerUserId === ownerUserId)
    .map(entry => entry.item)
    .sort(compareRetryQueueItems);
}

function appendRetryQueueExportItems(
  merged: RetryQueueExportEntry[],
  byId: Map<string, RetryQueueExportEntry>,
  byOperationId: Map<string, RetryQueueExportEntry>,
  byEntity: Map<string, RetryQueueExportEntry>,
  items: unknown[],
  source: RetryQueueExportSource,
): void {
  for (const item of items) {
    if (!isUnknownRecord(item)) {
      throw new Error(`RetryQueue ${source} contains invalid item(s)`);
    }
    const identity = readRetryQueueExportIdentity(item, source);
    const idMatch = byId.get(identity.id);
    const operationIdMatch = byOperationId.get(identity.operationId);
    const entityMatch = byEntity.get(identity.entityKey);
    const existing = idMatch ?? operationIdMatch ?? entityMatch;
    if (existing) {
      if ((idMatch && idMatch !== existing)
        || (operationIdMatch && operationIdMatch !== existing)
        || (entityMatch && entityMatch !== existing)
        || !sameRetryQueueExportIdentity(existing.identity, identity)) {
        throwRetryQueueExportDivergence(item, existing, source);
      }

      const winner = selectRetryQueueExportWinner(existing.item, item);
      if (!winner) throwRetryQueueExportDivergence(item, existing, source);
      if (winner === item) {
        existing.item = item;
        existing.source = source;
      }
      continue;
    }

    const entry = { item, source, identity };
    merged.push(entry);
    byId.set(identity.id, entry);
    byOperationId.set(identity.operationId, entry);
    byEntity.set(identity.entityKey, entry);
  }
}

function readRetryQueueExportIdentity(
  item: UnknownRecord,
  source: RetryQueueExportSource,
): RetryQueueExportIdentity {
  const id = requireRetryQueueString(item, 'id', source);
  const operationId = requireRetryQueueString(item, 'operationId', source);
  const ownerUserId = requireRetryQueueString(item, 'sourceUserId', source);
  const type = requireRetryQueueString(item, 'type', source);
  requireRetryQueueString(item, 'operation', source);
  const data = item['data'];
  if (!isUnknownRecord(data)) {
    throw new Error(`RetryQueue ${source} item ${id} has invalid data`);
  }
  const entityId = requireRetryQueueString(data, 'id', source, `item ${id} data`);
  if (!Number.isInteger(item['retryCount']) || (item['retryCount'] as number) < 0) {
    throw new Error(`RetryQueue ${source} item ${id} has invalid retryCount`);
  }
  if (typeof item['createdAt'] !== 'number' || !Number.isFinite(item['createdAt'])) {
    throw new Error(`RetryQueue ${source} item ${id} has invalid createdAt`);
  }
  return {
    id,
    operationId,
    ownerUserId,
    entityKey: `${ownerUserId}\u0000${type}\u0000${entityId}`,
  };
}

function requireRetryQueueString(
  item: UnknownRecord,
  field: string,
  source: RetryQueueExportSource,
  label = 'item',
): string {
  const value = nonEmptyString(item[field]);
  if (!value) {
    throw new Error(`RetryQueue ${source} ${label} requires non-empty ${field}`);
  }
  return value;
}

function sameRetryQueueExportIdentity(
  left: RetryQueueExportIdentity,
  right: RetryQueueExportIdentity,
): boolean {
  return left.id === right.id
    && left.operationId === right.operationId
    && left.ownerUserId === right.ownerUserId
    && left.entityKey === right.entityKey;
}

function selectRetryQueueExportWinner(
  existing: UnknownRecord,
  incoming: UnknownRecord,
): UnknownRecord | null {
  if (canonicalRetryQueueExportItem(existing) === canonicalRetryQueueExportItem(incoming)) {
    return existing;
  }
  if (canonicalRetryQueueExportItem(existing, true) !== canonicalRetryQueueExportItem(incoming, true)) {
    return null;
  }

  const existingRetryCount = existing['retryCount'] as number;
  const incomingRetryCount = incoming['retryCount'] as number;
  if (existingRetryCount !== incomingRetryCount) {
    return incomingRetryCount > existingRetryCount ? incoming : existing;
  }
  const existingFailureAt = retryQueueFailureRecordedAt(existing);
  const incomingFailureAt = retryQueueFailureRecordedAt(incoming);
  if (existingFailureAt !== incomingFailureAt) {
    return incomingFailureAt > existingFailureAt ? incoming : existing;
  }
  return null;
}

function retryQueueFailureRecordedAt(item: UnknownRecord): number {
  const failure = item['lastFailure'];
  return isUnknownRecord(failure)
    && typeof failure['recordedAt'] === 'number'
    && Number.isFinite(failure['recordedAt'])
    ? failure['recordedAt']
    : -1;
}

function isCanonicalProjectCursorRecord(
  value: unknown,
  expectedKey: string,
  ownerUserId: string,
  projectId: string,
): value is UnknownRecord {
  if (!isUnknownRecord(value)) return false;
  const committedAt = value['committedAt'];
  const cursor = value['cursor'];
  return value['key'] === expectedKey
    && value['scope'] === 'project'
    && value['userId'] === ownerUserId
    && value['projectId'] === projectId
    && typeof committedAt === 'string'
    && Number.isFinite(Date.parse(committedAt))
    && isProjectSyncCursor(cursor)
    && Number.isFinite(Date.parse(cursor.updatedAt));
}

function canonicalRetryQueueExportItem(item: UnknownRecord, omitRetryState = false): string {
  const comparable: UnknownRecord = { ...item };
  if (omitRetryState) {
    delete comparable['retryCount'];
    delete comparable['lastFailure'];
  }
  if (item['type'] === 'task' && isUnknownRecord(item['data'])) {
    const data = { ...item['data'] };
    delete data['displayId'];
    comparable['data'] = data;
  }
  return stableStringify(comparable);
}

function throwRetryQueueExportDivergence(
  item: UnknownRecord,
  existing: RetryQueueExportEntry,
  source: RetryQueueExportSource,
): never {
  const id = nonEmptyString(item['id']) ?? 'missing-id';
  const operationId = nonEmptyString(item['operationId']) ?? 'missing-operationId';
  throw new Error(
    `RetryQueue export divergence for id ${id}, operationId ${operationId} between ${existing.source} and ${source}`,
  );
}

function compareRetryQueueItems(left: UnknownRecord, right: UnknownRecord): number {
  const createdAtComparison = numericSortValue(left['createdAt']) - numericSortValue(right['createdAt']);
  if (createdAtComparison !== 0) return createdAtComparison;

  const idComparison = compareStrings(nonEmptyString(left['id']) ?? '', nonEmptyString(right['id']) ?? '');
  if (idComparison !== 0) return idComparison;
  const operationIdComparison = compareStrings(
    nonEmptyString(left['operationId']) ?? '',
    nonEmptyString(right['operationId']) ?? '',
  );
  return operationIdComparison !== 0
    ? operationIdComparison
    : compareStrings(canonicalRetryQueueExportItem(left), canonicalRetryQueueExportItem(right));
}

function numericSortValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : Number.MAX_SAFE_INTEGER;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }
  if (isUnknownRecord(value)) {
    return `{${Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
