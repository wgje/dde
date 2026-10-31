import { Injectable, inject } from '@angular/core';
import type { BackupData } from '../../supabase/functions/_shared/backup-utils';
import {
  DB_CONFIG,
  IndexedDBService,
  isProjectSyncCursor,
  type ProjectSyncCursor,
} from '../app/core/state/persistence';
import { SyncStateService, TombstoneService } from '../core-bridge';
import { DataSafetyAuditPersistence } from './data-safety-audit-persistence';
import type { DataSafetyAuditLogSnapshot } from './data-safety-audit-log';
import type { LwwDecision } from './data-safety-package';
import {
  buildDataSafetyMetadataRestorePlan,
  restoreDataSafetyMetadataFromBackup,
  type DataSafetyConnectionTombstoneSnapshot,
  type DataSafetyMetadataRestoreAdapter,
  type DataSafetyMetadataRestoreCounts,
  type DataSafetyMetadataRestorePlan,
  type DataSafetyMetadataRestoreState,
  type DataSafetyProjectCursorSnapshot,
  type DataSafetyTaskTombstoneSnapshot,
} from './import-backup-conversion.helpers';
import {
  CONNECTION_TOMBSTONES_STORAGE_KEY,
  TASK_TOMBSTONES_STORAGE_KEY,
  writeScopedConnectionTombstones,
  writeScopedTaskTombstones,
} from './data-safety-tombstone-storage.helpers';
import {
  DATA_SAFETY_RESTORE_MARKER_HEARTBEAT_MS,
  claimDataSafetyRestoreMarkerLease,
  createDataSafetyRestoreMarkerLease,
  hasSameDataSafetyRestoreMarkerIdentity,
  isDataSafetyRestoreMarkerActive,
  renewDataSafetyRestoreMarkerLeaseIdentity,
} from './data-safety-indexeddb-restore-marker-lease';

const AUDIT_STORAGE_KEY_PREFIX = 'nanoflow.data-safety-audit';
const RESTORE_MARKER_STORAGE_KEY_PREFIX = 'nanoflow.backup-metadata-restore-marker';
const RESTORE_MARKER_SCHEMA_VERSION = 1;
const BACKUP_METADATA_RESTORE_LOCK_NAME = 'nanoflow:backup-metadata-restore';
let fallbackMetadataRestoreLockHeld = false;

interface ProjectSyncCursorRecord {
  key: string;
  scope: 'project';
  userId: string | null;
  projectId: string;
  cursor: ProjectSyncCursor;
  committedAt: string;
}

interface BackupMetadataRestoreMarker {
  schemaVersion: typeof RESTORE_MARKER_SCHEMA_VERSION;
  ownerUserId: string;
  runId: string | null;
  createdAt: string;
  leaseExpiresAt: string | null;
  touchedProjectIds: string[];
  cursorRecords: ProjectSyncCursorRecord[];
  lastSyncTime: string | null;
  taskTombstonesRaw: string | null;
  connectionTombstonesRaw: string | null;
  auditRaw: string | null;
}

class BackupMetadataRestoreMarkerOwnershipLostError extends Error {
  constructor(cause?: unknown) {
    super(cause === undefined
      ? 'backup metadata restore marker ownership lost'
      : `backup metadata restore marker ownership lost: ${formatRestoreError(cause)}`);
    this.name = 'BackupMetadataRestoreMarkerOwnershipLostError';
  }
}

interface BackupMetadataRestoreMarkerHeartbeat {
  hasOwnership: () => boolean;
  stop: () => void;
}

interface BackupMetadataRestoreTargetContext {
  db: IDBDatabase;
  ownerUserId: string;
  target: DataSafetyMetadataRestoreState;
  touchedProjectIds: ReadonlySet<string>;
  marker: BackupMetadataRestoreMarker;
  markerHeartbeat: BackupMetadataRestoreMarkerHeartbeat;
  checkpoint: BackupMetadataRestoreCheckpoint;
}

export type BackupMetadataRestoreCheckpoint = () => Promise<void>;

const NOOP_RESTORE_CHECKPOINT: BackupMetadataRestoreCheckpoint = async () => undefined;

@Injectable({ providedIn: 'root' })
export class BackupDataSafetyMetadataRestoreService implements DataSafetyMetadataRestoreAdapter {
  private readonly indexedDB = inject(IndexedDBService);
  private readonly syncState = inject(SyncStateService);
  private readonly tombstones = inject(TombstoneService);
  private readonly auditPersistence = new DataSafetyAuditPersistence();

  async preview(backup: BackupData, ownerUserId: string): Promise<DataSafetyMetadataRestorePlan> {
    return withBackupMetadataRestoreLock(() => this.previewUnlocked(backup, ownerUserId));
  }

  private async previewUnlocked(
    backup: BackupData,
    ownerUserId: string,
  ): Promise<DataSafetyMetadataRestorePlan> {
    const visibleProjectIds = getVisibleProjectIds(backup, ownerUserId);
    const current = await this.readCurrentUnlocked(ownerUserId, visibleProjectIds);
    return buildDataSafetyMetadataRestorePlan(backup, ownerUserId, current);
  }

  async restore(
    backup: BackupData,
    ownerUserId: string,
  ): Promise<DataSafetyMetadataRestoreCounts> {
    return withBackupMetadataRestoreLock(() => restoreDataSafetyMetadataFromBackup(
      backup,
      ownerUserId,
      {
        readCurrent: (userId, visibleProjectIds) => (
          this.readCurrentUnlocked(userId, visibleProjectIds)
        ),
        replaceAtomically: (userId, target, rollbackState) => (
          this.replaceAtomicallyUnlocked(userId, target, rollbackState)
        ),
      },
    ));
  }

  async readCurrent(
    ownerUserId: string,
    visibleProjectIds: ReadonlySet<string>,
    checkpoint: BackupMetadataRestoreCheckpoint = NOOP_RESTORE_CHECKPOINT,
  ): Promise<DataSafetyMetadataRestoreState> {
    return withBackupMetadataRestoreLock(() => (
      this.readCurrentUnlocked(ownerUserId, visibleProjectIds, checkpoint)
    ));
  }

  private async readCurrentUnlocked(
    ownerUserId: string,
    visibleProjectIds: ReadonlySet<string>,
    checkpoint: BackupMetadataRestoreCheckpoint = NOOP_RESTORE_CHECKPOINT,
  ): Promise<DataSafetyMetadataRestoreState> {
    await checkpoint();
    await this.recoverInterruptedRestore(ownerUserId);
    await checkpoint();
    const db = await this.indexedDB.initDatabase();
    await checkpoint();
    const cursorRows = await readScopedCursorRows(db, ownerUserId, visibleProjectIds);
    await checkpoint();
    return {
      projectCursors: cursorRows
        .map(row => ({
          projectId: row.projectId,
          userId: ownerUserId,
          cursor: row.cursor,
        }))
        .sort((left, right) => left.projectId.localeCompare(right.projectId)),
      lastSyncTime: this.syncState.syncState().lastSyncTime,
      ...readCurrentAudit(ownerUserId),
      taskTombstones: readCurrentTaskTombstones(visibleProjectIds),
      connectionTombstones: readCurrentConnectionTombstones(visibleProjectIds),
    };
  }

  async replaceAtomically(
    ownerUserId: string,
    target: DataSafetyMetadataRestoreState,
    rollbackState: DataSafetyMetadataRestoreState,
    checkpoint: BackupMetadataRestoreCheckpoint = NOOP_RESTORE_CHECKPOINT,
  ): Promise<void> {
    return withBackupMetadataRestoreLock(() => (
      this.replaceAtomicallyUnlocked(ownerUserId, target, rollbackState, checkpoint)
    ));
  }

  private async replaceAtomicallyUnlocked(
    ownerUserId: string,
    target: DataSafetyMetadataRestoreState,
    rollbackState: DataSafetyMetadataRestoreState,
    checkpoint: BackupMetadataRestoreCheckpoint = NOOP_RESTORE_CHECKPOINT,
  ): Promise<void> {
    await checkpoint();
    await this.recoverInterruptedRestore(ownerUserId);
    await checkpoint();
    const db = await this.indexedDB.initDatabase();
    await checkpoint();
    const touchedProjectIds = collectTouchedProjectIds(target, rollbackState);
    await checkpoint();
    const marker = await this.captureRestoreMarker(db, ownerUserId, touchedProjectIds);
    writeRestoreMarker(marker);
    const markerHeartbeat = startRestoreMarkerHeartbeat(marker);

    try {
      await this.applyRestoreTarget({
        db,
        ownerUserId,
        target,
        touchedProjectIds,
        marker,
        markerHeartbeat,
        checkpoint,
      });
    } catch (error) {
      if (error instanceof BackupMetadataRestoreMarkerOwnershipLostError) throw error;
      if (!ownsRestoreMarker(marker)) {
        throw new BackupMetadataRestoreMarkerOwnershipLostError(error);
      }
      const rollbackErrors = await this.rollbackRestore(db, marker);
      if (rollbackErrors.length > 0) {
        throw new Error(
          `${formatRestoreError(error)}; metadata rollback failed: ${rollbackErrors.join('; ')}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      markerHeartbeat.stop();
    }
  }

  private async applyRestoreTarget(
    context: BackupMetadataRestoreTargetContext,
  ): Promise<void> {
    const {
      db, ownerUserId, target, touchedProjectIds, marker, markerHeartbeat, checkpoint,
    } = context;
    await checkpoint();
    writeScopedTaskTombstones(target.taskTombstones, touchedProjectIds);
    await checkpoint();
    writeScopedConnectionTombstones(target.connectionTombstones, touchedProjectIds);
    await checkpoint();
    if (!this.auditPersistence.save(ownerUserId, toAuditLogSnapshot(target))) {
      throw new Error('data-safety audit persistence failed');
    }
    await checkpoint();
    await replaceScopedCursorRows(db, ownerUserId, touchedProjectIds, target.projectCursors);
    await checkpoint();
    if (!markerHeartbeat.hasOwnership()) {
      throw new BackupMetadataRestoreMarkerOwnershipLostError();
    }
    this.syncState.setLastSyncTime(target.lastSyncTime);
    await checkpoint();
    if (!markerHeartbeat.hasOwnership()) {
      throw new BackupMetadataRestoreMarkerOwnershipLostError();
    }
    this.tombstones.reloadLocalTombstonesFromStorage();
    await checkpoint();
    if (!clearRestoreMarker(marker)) {
      throw new BackupMetadataRestoreMarkerOwnershipLostError();
    }
  }

  private async captureRestoreMarker(
    db: IDBDatabase,
    ownerUserId: string,
    touchedProjectIds: ReadonlySet<string>,
  ): Promise<BackupMetadataRestoreMarker> {
    const cursorRecords = await readScopedCursorRows(db, ownerUserId, touchedProjectIds);
    return {
      schemaVersion: RESTORE_MARKER_SCHEMA_VERSION,
      ...createDataSafetyRestoreMarkerLease(ownerUserId),
      touchedProjectIds: Array.from(touchedProjectIds).sort(),
      cursorRecords,
      lastSyncTime: this.syncState.syncState().lastSyncTime,
      taskTombstonesRaw: readStorageValue(TASK_TOMBSTONES_STORAGE_KEY),
      connectionTombstonesRaw: readStorageValue(CONNECTION_TOMBSTONES_STORAGE_KEY),
      auditRaw: readStorageValue(getAuditStorageKey(ownerUserId)),
    };
  }

  private async recoverInterruptedRestore(ownerUserId: string): Promise<void> {
    let marker = readRestoreMarker(ownerUserId);
    if (!marker) return;
    if (isDataSafetyRestoreMarkerActive(marker)) {
      throw new Error('backup metadata restore already in progress');
    }
    marker = claimExpiredRestoreMarker(marker);
    if (!marker) throw new BackupMetadataRestoreMarkerOwnershipLostError();
    const markerHeartbeat = startRestoreMarkerHeartbeat(marker);
    try {
      const db = await this.indexedDB.initDatabase();
      const errors = await this.rollbackRestore(db, marker);
      if (errors.length > 0) {
        throw new Error(`interrupted metadata restore recovery failed: ${errors.join('; ')}`);
      }
    } finally {
      markerHeartbeat.stop();
    }
  }

  private async rollbackRestore(
    db: IDBDatabase,
    marker: BackupMetadataRestoreMarker,
  ): Promise<string[]> {
    const errors: string[] = [];
    const touchedProjectIds = new Set(marker.touchedProjectIds);
    if (!ensureRestoreMarkerOwnership(errors, marker)) return errors;
    await attemptRollback(errors, 'sync cursors', async () => {
      await replaceScopedCursorRows(
        db,
        marker.ownerUserId,
        touchedProjectIds,
        marker.cursorRecords.map(record => ({
          projectId: record.projectId,
          userId: marker.ownerUserId,
          cursor: record.cursor,
        })),
        marker.cursorRecords,
      );
    });
    if (!ensureRestoreMarkerOwnership(errors, marker)) return errors;
    await attemptRollback(errors, 'task tombstones', () => {
      restoreScopedTaskTombstones(marker.taskTombstonesRaw, touchedProjectIds);
    });
    if (!ensureRestoreMarkerOwnership(errors, marker)) return errors;
    await attemptRollback(errors, 'connection tombstones', () => {
      restoreScopedConnectionTombstones(marker.connectionTombstonesRaw, touchedProjectIds);
    });
    if (!ensureRestoreMarkerOwnership(errors, marker)) return errors;
    await attemptRollback(errors, 'data-safety audit', () => {
      restoreStorageValue(getAuditStorageKey(marker.ownerUserId), marker.auditRaw);
    });
    if (!ensureRestoreMarkerOwnership(errors, marker)) return errors;
    await attemptRollback(errors, 'lastSyncTime', () => {
      this.syncState.setLastSyncTime(marker.lastSyncTime);
    });
    if (!ensureRestoreMarkerOwnership(errors, marker)) return errors;
    await attemptRollback(errors, 'tombstone reload', () => {
      this.tombstones.reloadLocalTombstonesFromStorage();
    });
    if (!ensureRestoreMarkerOwnership(errors, marker)) return errors;
    if (errors.length === 0) {
      await attemptRollback(errors, 'restore marker clear', () => {
        if (!clearRestoreMarker(marker)) {
          throw new BackupMetadataRestoreMarkerOwnershipLostError();
        }
      });
    }
    return errors;
  }
}

interface BackupMetadataLockManager {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: Lock | null) => T | Promise<T>,
  ): Promise<T>;
}

async function withBackupMetadataRestoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined'
    ? null
    : (navigator as Navigator & { locks?: BackupMetadataLockManager }).locks ?? null;
  if (locks) {
    return locks.request(
      BACKUP_METADATA_RESTORE_LOCK_NAME,
      { mode: 'exclusive', ifAvailable: true },
      lock => {
        if (!lock) throw new Error('backup metadata restore lock unavailable');
        return operation();
      },
    );
  }
  if (fallbackMetadataRestoreLockHeld) {
    throw new Error('backup metadata restore lock unavailable');
  }
  fallbackMetadataRestoreLockHeld = true;
  try {
    return await operation();
  } finally {
    fallbackMetadataRestoreLockHeld = false;
  }
}

function getVisibleProjectIds(backup: BackupData, ownerUserId: string): Set<string> {
  return new Set(
    (backup.projects ?? [])
      .filter(project => project.userId === ownerUserId)
      .map(project => project.id),
  );
}

function collectTouchedProjectIds(
  target: DataSafetyMetadataRestoreState,
  rollbackState: DataSafetyMetadataRestoreState,
): Set<string> {
  return new Set([
    ...target.projectCursors.map(entry => entry.projectId),
    ...rollbackState.projectCursors.map(entry => entry.projectId),
    ...Object.keys(target.taskTombstones),
    ...Object.keys(rollbackState.taskTombstones),
    ...target.connectionTombstones.map(entry => entry.projectId),
    ...rollbackState.connectionTombstones.map(entry => entry.projectId),
  ]);
}

function toAuditLogSnapshot(
  state: Pick<DataSafetyMetadataRestoreState, 'replayLog' | 'lastWriteExplain'>,
): DataSafetyAuditLogSnapshot {
  return {
    replayLog: state.replayLog.map(entry => ({
      ...entry,
      lww: {
        ...entry.lww,
        decision: normalizeLwwDecision(entry.lww.decision),
      },
    })),
    lastWriteExplain: state.lastWriteExplain
      ? {
          ...state.lastWriteExplain,
          lwwDecision: {
            ...state.lastWriteExplain.lwwDecision,
            decision: normalizeLwwDecision(state.lastWriteExplain.lwwDecision.decision),
          },
        }
      : null,
  };
}

function normalizeLwwDecision(decision: string): LwwDecision {
  switch (decision) {
    case 'local-applied':
    case 'remote-kept':
    case 'idempotent-replay':
    case 'blocked':
    case 'unknown':
      return decision;
    default:
      return 'unknown';
  }
}

function readCurrentAudit(ownerUserId: string): Pick<
  DataSafetyMetadataRestoreState,
  'replayLog' | 'lastWriteExplain'
> {
  const raw = readStorageValue(getAuditStorageKey(ownerUserId));
  if (raw !== null) {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('current data-safety audit state is invalid');
    }
  }
  const snapshot: DataSafetyAuditLogSnapshot = new DataSafetyAuditPersistence().load(ownerUserId);
  return snapshot;
}

function readCurrentTaskTombstones(
  visibleProjectIds: ReadonlySet<string>,
): DataSafetyTaskTombstoneSnapshot {
  const parsed = parseStorageJson(TASK_TOMBSTONES_STORAGE_KEY, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('current task tombstone state is invalid');
  }

  const result: DataSafetyTaskTombstoneSnapshot = {};
  for (const [projectId, value] of Object.entries(parsed)) {
    if (!visibleProjectIds.has(projectId)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`current task tombstones for ${projectId} are invalid`);
    }
    const entries: Record<string, number> = {};
    for (const [taskId, timestamp] of Object.entries(value)) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        throw new Error(`current task tombstone ${projectId}/${taskId} is invalid`);
      }
      entries[taskId] = timestamp;
    }
    result[projectId] = entries;
  }
  return result;
}

function readCurrentConnectionTombstones(
  visibleProjectIds: ReadonlySet<string>,
): DataSafetyConnectionTombstoneSnapshot[] {
  const parsed = parseStorageJson(CONNECTION_TOMBSTONES_STORAGE_KEY, []);
  if (!Array.isArray(parsed)) {
    throw new Error('current connection tombstone state is invalid');
  }

  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const projectId = record['projectId'];
    if (typeof projectId !== 'string' || !visibleProjectIds.has(projectId)) return [];
    const connectionId = record['connectionId'] ?? record['id'];
    const timestamp = record['timestamp'];
    if (typeof connectionId !== 'string'
      || !connectionId
      || typeof timestamp !== 'number'
      || !Number.isFinite(timestamp)) {
      throw new Error(`current connection tombstone for ${projectId} is invalid`);
    }
    return [{ projectId, connectionId, timestamp }];
  });
}

async function readScopedCursorRows(
  db: IDBDatabase,
  ownerUserId: string,
  projectIds: ReadonlySet<string>,
): Promise<ProjectSyncCursorRecord[]> {
  let transaction: IDBTransaction;
  try {
    transaction = db.transaction(DB_CONFIG.stores.syncCursors, 'readonly');
  } catch (error) {
    return Promise.reject(error);
  }
  const store = transaction.objectStore(DB_CONFIG.stores.syncCursors);
  const rows = await Promise.all(Array.from(projectIds)
    .sort()
    .map(projectId => readScopedCursorRow(store, ownerUserId, projectId)));
  return rows.filter((row): row is ProjectSyncCursorRecord => row !== null);
}

function readScopedCursorRow(
  store: IDBObjectStore,
  ownerUserId: string,
  projectId: string,
): Promise<ProjectSyncCursorRecord | null> {
  const key = projectCursorKey(ownerUserId, projectId);
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result === undefined) {
        resolve(null);
        return;
      }
      if (!isCanonicalProjectCursorRecord(request.result, key, ownerUserId, projectId)) {
        reject(new Error(`sync cursor record ${key} is invalid`));
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error(`Failed to read sync cursor ${key}`));
  });
}

async function replaceScopedCursorRows(
  db: IDBDatabase,
  ownerUserId: string,
  touchedProjectIds: ReadonlySet<string>,
  target: DataSafetyProjectCursorSnapshot[],
  exactRecords?: ProjectSyncCursorRecord[],
): Promise<void> {
  let transaction: IDBTransaction;
  try {
    transaction = db.transaction(DB_CONFIG.stores.syncCursors, 'readwrite');
  } catch (error) {
    return Promise.reject(error);
  }
  await new Promise<void>((resolve, reject) => {
    const store = transaction.objectStore(DB_CONFIG.stores.syncCursors);
    for (const projectId of touchedProjectIds) {
      store.delete(projectCursorKey(ownerUserId, projectId));
    }
    const committedAt = new Date().toISOString();
    const records = exactRecords ?? target.map(entry => ({
      key: projectCursorKey(ownerUserId, entry.projectId),
      scope: 'project' as const,
      userId: ownerUserId,
      projectId: entry.projectId,
      cursor: entry.cursor,
      committedAt,
    }));
    for (const record of records) store.put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Failed to replace sync cursors'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Sync cursor replacement aborted'));
  });
}

function isCanonicalProjectCursorRecord(
  value: unknown,
  expectedKey: string,
  ownerUserId: string,
  projectId: string,
): value is ProjectSyncCursorRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const cursor = record['cursor'];
  const committedAt = record['committedAt'];
  return record['scope'] === 'project'
    && record['key'] === expectedKey
    && record['userId'] === ownerUserId
    && record['projectId'] === projectId
    && typeof committedAt === 'string'
    && Number.isFinite(Date.parse(committedAt))
    && isProjectSyncCursor(cursor)
    && typeof cursor.updatedAt === 'string'
    && Number.isFinite(Date.parse(cursor.updatedAt));
}

function projectCursorKey(ownerUserId: string, projectId: string): string {
  return `project:${ownerUserId || 'anonymous'}:${projectId}`;
}

function writeRestoreMarker(marker: BackupMetadataRestoreMarker): void {
  localStorage.setItem(getRestoreMarkerStorageKey(marker.ownerUserId), JSON.stringify(marker));
}

function readRestoreMarker(ownerUserId: string): BackupMetadataRestoreMarker | null {
  const raw = readStorageValue(getRestoreMarkerStorageKey(ownerUserId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('backup metadata restore marker is invalid');
  }
  const marker = normalizeRestoreMarker(parsed, ownerUserId);
  if (!marker) {
    throw new Error('backup metadata restore marker is invalid');
  }
  return marker;
}

function ownsRestoreMarker(marker: BackupMetadataRestoreMarker): boolean {
  const currentMarker = readRestoreMarker(marker.ownerUserId);
  return currentMarker !== null
    && hasSameDataSafetyRestoreMarkerIdentity(currentMarker, marker);
}

function claimExpiredRestoreMarker(
  marker: BackupMetadataRestoreMarker,
): BackupMetadataRestoreMarker | null {
  if (isDataSafetyRestoreMarkerActive(marker) || !ownsRestoreMarker(marker)) return null;
  const claimedMarker = claimDataSafetyRestoreMarkerLease(marker);
  writeRestoreMarker(claimedMarker);
  return ownsRestoreMarker(claimedMarker) ? claimedMarker : null;
}

function ensureRestoreMarkerOwnership(
  errors: string[],
  marker: BackupMetadataRestoreMarker,
): boolean {
  if (ownsRestoreMarker(marker)) return true;
  errors.push('backup metadata restore marker ownership lost; rollback skipped');
  return false;
}

function renewRestoreMarkerLease(marker: BackupMetadataRestoreMarker): boolean {
  if (!ownsRestoreMarker(marker)) return false;
  const renewedMarker = renewDataSafetyRestoreMarkerLeaseIdentity(marker);
  writeRestoreMarker(renewedMarker);
  return ownsRestoreMarker(renewedMarker);
}

function startRestoreMarkerHeartbeat(
  marker: BackupMetadataRestoreMarker,
): BackupMetadataRestoreMarkerHeartbeat {
  let ownershipLost = false;
  const refresh = (): boolean => {
    try {
      ownershipLost ||= !renewRestoreMarkerLease(marker);
    } catch {
      ownershipLost = true;
    }
    return !ownershipLost;
  };
  const timer = setInterval(refresh, DATA_SAFETY_RESTORE_MARKER_HEARTBEAT_MS);
  return { hasOwnership: refresh, stop: () => clearInterval(timer) };
}

function clearRestoreMarker(marker: BackupMetadataRestoreMarker): boolean {
  if (!ownsRestoreMarker(marker)) return false;
  localStorage.removeItem(getRestoreMarkerStorageKey(marker.ownerUserId));
  return true;
}

function normalizeRestoreMarker(
  value: unknown,
  ownerUserId: string,
): BackupMetadataRestoreMarker | null {
  if (!hasValidRestoreMarkerSnapshot(value, ownerUserId)) return null;
  const identity = normalizeRestoreMarkerIdentity(value);
  if (!identity) return null;
  return {
    ...value,
    ...identity,
  } as unknown as BackupMetadataRestoreMarker;
}

function hasValidRestoreMarkerSnapshot(
  value: unknown,
  ownerUserId: string,
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record['schemaVersion'] === RESTORE_MARKER_SCHEMA_VERSION
    && record['ownerUserId'] === ownerUserId
    && typeof record['createdAt'] === 'string'
    && Array.isArray(record['touchedProjectIds'])
    && Array.isArray(record['cursorRecords'])
    && (typeof record['lastSyncTime'] === 'string' || record['lastSyncTime'] === null)
    && (typeof record['taskTombstonesRaw'] === 'string' || record['taskTombstonesRaw'] === null)
    && (typeof record['connectionTombstonesRaw'] === 'string' || record['connectionTombstonesRaw'] === null)
    && (typeof record['auditRaw'] === 'string' || record['auditRaw'] === null);
}

function normalizeRestoreMarkerIdentity(
  record: Record<string, unknown>,
): Pick<BackupMetadataRestoreMarker, 'runId' | 'leaseExpiresAt'> | null {
  const runId = record['runId'];
  const leaseExpiresAt = record['leaseExpiresAt'];
  const hasRunIdentity = runId !== undefined || leaseExpiresAt !== undefined;
  if (hasRunIdentity && (
    typeof runId !== 'string'
    || runId.length === 0
    || typeof leaseExpiresAt !== 'string'
    || !Number.isFinite(Date.parse(leaseExpiresAt))
  )) {
    return null;
  }
  return {
    runId: hasRunIdentity ? runId : null,
    leaseExpiresAt: hasRunIdentity ? leaseExpiresAt : null,
  } as Pick<BackupMetadataRestoreMarker, 'runId' | 'leaseExpiresAt'>;
}

function getAuditStorageKey(ownerUserId: string): string {
  return `${AUDIT_STORAGE_KEY_PREFIX}.${ownerUserId}`;
}

function getRestoreMarkerStorageKey(ownerUserId: string): string {
  return `${RESTORE_MARKER_STORAGE_KEY_PREFIX}.${ownerUserId}`;
}

function readStorageValue(key: string): string | null {
  return localStorage.getItem(key);
}

function restoreStorageValue(key: string, value: string | null): void {
  if (value === null) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, value);
}

function restoreScopedTaskTombstones(
  rawPreImage: string | null,
  touchedProjectIds: ReadonlySet<string>,
): void {
  const preImage = parseTaskTombstoneObject(
    rawPreImage,
    'backup metadata task tombstone pre-image',
  );
  const restored: DataSafetyTaskTombstoneSnapshot = Object.create(null) as DataSafetyTaskTombstoneSnapshot;
  for (const projectId of touchedProjectIds) {
    if (!Object.prototype.hasOwnProperty.call(preImage, projectId)) continue;
    const value = preImage[projectId];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`backup metadata task tombstones for ${projectId} are invalid`);
    }
    const entries: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const [taskId, timestamp] of Object.entries(value)) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        throw new Error(`backup metadata task tombstone ${projectId}/${taskId} is invalid`);
      }
      entries[taskId] = timestamp;
    }
    restored[projectId] = entries;
  }

  const currentRaw = readStorageValue(TASK_TOMBSTONES_STORAGE_KEY);
  if (currentRaw === rawPreImage) {
    restoreStorageValue(TASK_TOMBSTONES_STORAGE_KEY, rawPreImage);
    return;
  }

  const current = parseTaskTombstoneObject(currentRaw, 'current task tombstone state');
  const merged = Object.assign(
    Object.create(null) as Record<string, unknown>,
    current,
  );
  for (const projectId of touchedProjectIds) delete merged[projectId];
  for (const projectId of touchedProjectIds) {
    if (Object.prototype.hasOwnProperty.call(restored, projectId)) {
      merged[projectId] = restored[projectId];
    }
  }

  if (rawPreImage === null && Object.keys(merged).length === 0) {
    localStorage.removeItem(TASK_TOMBSTONES_STORAGE_KEY);
    return;
  }
  localStorage.setItem(TASK_TOMBSTONES_STORAGE_KEY, JSON.stringify(merged));
}

function restoreScopedConnectionTombstones(
  rawPreImage: string | null,
  touchedProjectIds: ReadonlySet<string>,
): void {
  const preImage = parseConnectionTombstoneArray(
    rawPreImage,
    'backup metadata connection tombstone pre-image',
  );
  for (const entry of preImage) {
    const projectId = getConnectionTombstoneProjectId(entry);
    if (projectId === null || !touchedProjectIds.has(projectId)) continue;
    const record = entry as Record<string, unknown>;
    const connectionId = record['connectionId'] ?? record['id'];
    if (typeof connectionId !== 'string' || connectionId.length === 0
      || typeof record['timestamp'] !== 'number'
      || !Number.isFinite(record['timestamp'])) {
      throw new Error(`backup metadata connection tombstone for ${projectId} is invalid`);
    }
  }

  const currentRaw = readStorageValue(CONNECTION_TOMBSTONES_STORAGE_KEY);
  if (currentRaw === rawPreImage) {
    restoreStorageValue(CONNECTION_TOMBSTONES_STORAGE_KEY, rawPreImage);
    return;
  }

  const current = parseConnectionTombstoneArray(currentRaw, 'current connection tombstone state');
  const restored = [
    ...current.filter(entry => {
      const projectId = getConnectionTombstoneProjectId(entry);
      return projectId === null || !touchedProjectIds.has(projectId);
    }),
    ...preImage.filter(entry => {
      const projectId = getConnectionTombstoneProjectId(entry);
      return projectId !== null && touchedProjectIds.has(projectId);
    }),
  ];

  if (rawPreImage === null && restored.length === 0) {
    localStorage.removeItem(CONNECTION_TOMBSTONES_STORAGE_KEY);
    return;
  }
  localStorage.setItem(CONNECTION_TOMBSTONES_STORAGE_KEY, JSON.stringify(restored));
}

function parseTaskTombstoneObject(raw: string | null, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = raw === null ? {} : JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} is invalid`);
  }
  return parsed as Record<string, unknown>;
}

function parseConnectionTombstoneArray(raw: string | null, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = raw === null ? [] : JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function getConnectionTombstoneProjectId(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const projectId = (entry as Record<string, unknown>)['projectId'];
  return typeof projectId === 'string' ? projectId : null;
}

function parseStorageJson(key: string, fallback: unknown): unknown {
  const raw = readStorageValue(key);
  return raw === null ? fallback : JSON.parse(raw);
}

async function attemptRollback(
  errors: string[],
  label: string,
  operation: () => void | Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(`${label}: ${formatRestoreError(error)}`);
  }
}

function formatRestoreError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
