import type { BackupData } from '../../supabase/functions/_shared/backup-utils';
import { FOCUS_CONFIG } from '../config/focus.config';
import { PARKING_CONFIG } from '../config/parking.config';
import { openIndexedDBAdaptive } from '../utils/indexeddb-open';
import {
  isLaunchSnapshotOwnedByCurrentUser,
  toDockSnapshotCandidate,
} from './disaster-backup-local-state.helpers';
import { normalizeLaunchSnapshot } from './launch-snapshot-normalization.helpers';
import { del as deleteKeyvalValue, get as getKeyvalValue, set as setKeyvalValue } from 'idb-keyval';

type UnknownRecord = Record<string, unknown>;
type RestoreCheckpoint = () => Promise<void>;

const DOCK_SNAPSHOT_IDB_KEY_PREFIX = 'nanoflow.focus-session.v5';
const LAUNCH_SNAPSHOT_STORAGE_KEY_V1 = 'nanoflow.launch-snapshot.v1';
const LAUNCH_SNAPSHOT_STORAGE_KEY_V2 = 'nanoflow.launch-snapshot.v2';
const PARKING_SYNC_CURSOR_KEY = 'parking_last_sync_time';
const NOOP_RESTORE_CHECKPOINT: RestoreCheckpoint = async () => undefined;

export interface DockSnapshotRestoreSnapshot {
  present: boolean;
  localStorage: string | null;
  indexedDb: UnknownRecord | null;
}

export interface LaunchSnapshotRestoreSnapshot {
  present: boolean;
  v1: string | null;
  v2: string | null;
}

export interface ParkedTaskCacheRestoreSnapshot {
  present: boolean;
  entries: UnknownRecord[];
  syncMetadata: Record<string, unknown>;
}

export interface ProjectLocalStateRestoreSnapshot {
  dockSnapshotRestoreSnapshot?: DockSnapshotRestoreSnapshot;
  launchSnapshotRestoreSnapshot?: LaunchSnapshotRestoreSnapshot;
  parkedTaskCacheRestoreSnapshot?: ParkedTaskCacheRestoreSnapshot;
}

export async function readProjectLocalStateRestoreSnapshot(
  ownerUserId: string,
): Promise<Required<ProjectLocalStateRestoreSnapshot>> {
  const [
    dockSnapshotRestoreSnapshot,
    launchSnapshotRestoreSnapshot,
    parkedTaskCacheRestoreSnapshot,
  ] = await Promise.all([
    readDockSnapshotRestoreSnapshot(ownerUserId),
    readLaunchSnapshotRestoreSnapshot(ownerUserId),
    readParkedTaskCacheRestoreSnapshot(ownerUserId),
  ]);
  return {
    dockSnapshotRestoreSnapshot,
    launchSnapshotRestoreSnapshot,
    parkedTaskCacheRestoreSnapshot,
  };
}

export async function restoreDockSnapshotRestoreSnapshot(
  ownerUserId: string,
  snapshot: DockSnapshotRestoreSnapshot,
  checkpoint: RestoreCheckpoint = NOOP_RESTORE_CHECKPOINT,
): Promise<void> {
  await checkpoint();
  restoreLocalStorageValue(getDockSnapshotLocalStorageKey(ownerUserId), snapshot.localStorage);
  await checkpoint();
  if (snapshot.indexedDb === null) {
    await deleteKeyvalValue(getDockSnapshotIndexedDbKey(ownerUserId));
  } else {
    await setKeyvalValue(getDockSnapshotIndexedDbKey(ownerUserId), snapshot.indexedDb);
  }
  await checkpoint();
}

export async function restoreLaunchSnapshotRestoreSnapshot(
  ownerUserId: string,
  snapshot: LaunchSnapshotRestoreSnapshot,
  checkpoint: RestoreCheckpoint = NOOP_RESTORE_CHECKPOINT,
): Promise<void> {
  await checkpoint();
  assertLaunchSnapshotStorageMayWrite(ownerUserId, LAUNCH_SNAPSHOT_STORAGE_KEY_V1);
  assertLaunchSnapshotStorageMayWrite(ownerUserId, LAUNCH_SNAPSHOT_STORAGE_KEY_V2);
  restoreLocalStorageValue(LAUNCH_SNAPSHOT_STORAGE_KEY_V1, snapshot.v1);
  await checkpoint();
  restoreLocalStorageValue(LAUNCH_SNAPSHOT_STORAGE_KEY_V2, snapshot.v2);
  await checkpoint();
}

export async function restoreParkedTaskCacheRestoreSnapshot(
  ownerUserId: string,
  snapshot: ParkedTaskCacheRestoreSnapshot,
  checkpoint: RestoreCheckpoint = NOOP_RESTORE_CHECKPOINT,
): Promise<void> {
  if (typeof indexedDB === 'undefined') return;

  await checkpoint();
  const db = await openFocusModeRestoreDb();
  try {
    const tx = db.transaction(
      [FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, FOCUS_CONFIG.IDB_STORES.SYNC_METADATA],
      'readwrite',
    );
    replaceParkedTaskCache(tx, ownerUserId, snapshot);
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
  await checkpoint();
}

export function buildProjectLocalStateRestoreSnapshot(
  ownerUserId: string,
  localState: BackupData['localState'] | undefined,
): Required<ProjectLocalStateRestoreSnapshot> {
  const dockSnapshotRestoreSnapshot = buildDockSnapshotRestoreSnapshot(localState);
  const launchSnapshotRestoreSnapshot = buildLaunchSnapshotRestoreSnapshot(ownerUserId, localState);
  const parkedTaskCacheRestoreSnapshot = buildParkedTaskCacheRestoreSnapshot(ownerUserId, localState);
  return {
    dockSnapshotRestoreSnapshot,
    launchSnapshotRestoreSnapshot,
    parkedTaskCacheRestoreSnapshot,
  };
}

export function normalizeProjectLocalStateMarkerSnapshot(
  value: Record<string, unknown>,
  ownerUserId: string,
): ProjectLocalStateRestoreSnapshot | null {
  const dock = normalizeOptionalSnapshot(
    value['dockSnapshotRestoreSnapshot'],
    normalizeDockSnapshotRestoreSnapshot,
  );
  const launch = normalizeOptionalSnapshot(
    value['launchSnapshotRestoreSnapshot'],
    candidate => normalizeLaunchSnapshotRestoreSnapshot(candidate, ownerUserId),
  );
  const parked = normalizeOptionalSnapshot(
    value['parkedTaskCacheRestoreSnapshot'],
    candidate => normalizeParkedTaskCacheRestoreSnapshot(candidate, ownerUserId),
  );
  if (!dock.valid || !launch.valid || !parked.valid) return null;
  return {
    ...(dock.value ? { dockSnapshotRestoreSnapshot: dock.value } : {}),
    ...(launch.value ? { launchSnapshotRestoreSnapshot: launch.value } : {}),
    ...(parked.value ? { parkedTaskCacheRestoreSnapshot: parked.value } : {}),
  };
}

export function normalizeDockSnapshotRestoreSnapshot(
  value: unknown,
): DockSnapshotRestoreSnapshot | null {
  if (!isUnknownRecord(value)
    || typeof value['present'] !== 'boolean'
    || !isNullableString(value['localStorage'])
    || (value['indexedDb'] !== null && !isUnknownRecord(value['indexedDb']))) {
    return null;
  }
  if ((value['localStorage'] !== null && !toDockSnapshotCandidate('legacy-current', value['localStorage']))
    || (value['indexedDb'] !== null && !toDockSnapshotCandidate('idb-current', value['indexedDb']))) {
    return null;
  }
  const present = value['localStorage'] !== null || value['indexedDb'] !== null;
  if (value['present'] !== present) return null;
  return {
    present,
    localStorage: value['localStorage'],
    indexedDb: value['indexedDb'] === null ? null : { ...value['indexedDb'] },
  };
}

export function normalizeLaunchSnapshotRestoreSnapshot(
  value: unknown,
  ownerUserId: string,
): LaunchSnapshotRestoreSnapshot | null {
  if (!isUnknownRecord(value)
    || typeof value['present'] !== 'boolean'
    || !isNullableString(value['v1'])
    || !isNullableString(value['v2'])) {
    return null;
  }
  if ((value['v1'] !== null && !isValidLaunchSnapshotRaw(value['v1'], ownerUserId))
    || (value['v2'] !== null && !isValidLaunchSnapshotRaw(value['v2'], ownerUserId))) {
    return null;
  }
  const present = value['v1'] !== null || value['v2'] !== null;
  if (value['present'] !== present) return null;
  return { present, v1: value['v1'], v2: value['v2'] };
}

export function normalizeParkedTaskCacheRestoreSnapshot(
  value: unknown,
  ownerUserId: string,
): ParkedTaskCacheRestoreSnapshot | null {
  if (!isUnknownRecord(value)
    || typeof value['present'] !== 'boolean'
    || !Array.isArray(value['entries'])
    || !isUnknownRecord(value['syncMetadata'])) {
    return null;
  }
  const ownerCursorKey = ownerUserId ? getParkingSyncCursorKey(ownerUserId) : null;
  if (!value['entries'].every(entry => isParkedTaskCacheRestoreEntry(entry, ownerUserId))
    || !Object.keys(value['syncMetadata']).every(key => ownerCursorKey !== null && key === ownerCursorKey)) {
    return null;
  }
  const entries = sortParkedTaskCacheRestoreEntries(value['entries']);
  const syncMetadata = Object.fromEntries(
    Object.entries(value['syncMetadata']).sort(([left], [right]) => left.localeCompare(right)),
  );
  const present = entries.length > 0 || Object.keys(syncMetadata).length > 0;
  if (value['present'] !== present) return null;
  return { present, entries, syncMetadata };
}

function buildDockSnapshotRestoreSnapshot(
  localState: BackupData['localState'] | undefined,
): DockSnapshotRestoreSnapshot {
  const snapshot = normalizeDockSnapshotRestoreSnapshot({
    present: localState?.dockSnapshot?.localStorage != null || localState?.dockSnapshot?.indexedDb != null,
    localStorage: localState?.dockSnapshot?.localStorage ?? null,
    indexedDb: localState?.dockSnapshot?.indexedDb ?? null,
  });
  if (!snapshot) throw new Error('local backup UI restore dock snapshot backup is invalid');
  return snapshot;
}

function buildLaunchSnapshotRestoreSnapshot(
  ownerUserId: string,
  localState: BackupData['localState'] | undefined,
): LaunchSnapshotRestoreSnapshot {
  const snapshot = normalizeLaunchSnapshotRestoreSnapshot({
    present: localState?.launchSnapshot?.v1 != null || localState?.launchSnapshot?.v2 != null,
    v1: localState?.launchSnapshot?.v1 ?? null,
    v2: localState?.launchSnapshot?.v2 ?? null,
  }, ownerUserId);
  if (!snapshot) throw new Error('local backup UI restore launch snapshot backup is invalid');
  return snapshot;
}

function buildParkedTaskCacheRestoreSnapshot(
  ownerUserId: string,
  localState: BackupData['localState'] | undefined,
): ParkedTaskCacheRestoreSnapshot {
  const entries = localState?.parkedTaskCache?.entries ?? [];
  const syncMetadata = localState?.parkedTaskCache?.syncMetadata ?? {};
  const snapshot = normalizeParkedTaskCacheRestoreSnapshot({
    present: entries.length > 0 || Object.keys(syncMetadata).length > 0,
    entries,
    syncMetadata,
  }, ownerUserId);
  if (!snapshot) throw new Error('local backup UI restore parked task cache backup is invalid');
  return snapshot;
}

async function readDockSnapshotRestoreSnapshot(
  ownerUserId: string,
): Promise<DockSnapshotRestoreSnapshot> {
  const localStorageValue = readLocalStorageValue(getDockSnapshotLocalStorageKey(ownerUserId));
  const indexedDbValue = await getKeyvalValue<UnknownRecord | null>(
    getDockSnapshotIndexedDbKey(ownerUserId),
  ) ?? null;
  const snapshot = normalizeDockSnapshotRestoreSnapshot({
    present: localStorageValue !== null || indexedDbValue !== null,
    localStorage: localStorageValue,
    indexedDb: indexedDbValue,
  });
  if (!snapshot) throw new Error('local backup UI restore dock snapshot is invalid');
  return snapshot;
}

async function readLaunchSnapshotRestoreSnapshot(
  ownerUserId: string,
): Promise<LaunchSnapshotRestoreSnapshot> {
  const v1 = readOwnerScopedLaunchSnapshot(LAUNCH_SNAPSHOT_STORAGE_KEY_V1, ownerUserId);
  const v2 = readOwnerScopedLaunchSnapshot(LAUNCH_SNAPSHOT_STORAGE_KEY_V2, ownerUserId);
  const snapshot = normalizeLaunchSnapshotRestoreSnapshot({
    present: v1 !== null || v2 !== null,
    v1,
    v2,
  }, ownerUserId);
  if (!snapshot) throw new Error('local backup UI restore launch snapshot is invalid');
  return snapshot;
}

async function readParkedTaskCacheRestoreSnapshot(
  ownerUserId: string,
): Promise<ParkedTaskCacheRestoreSnapshot> {
  if (typeof indexedDB === 'undefined') {
    return { present: false, entries: [], syncMetadata: {} };
  }
  const db = await openFocusModeRestoreDb();
  try {
    return await readParkedTaskCacheFromDb(db, ownerUserId);
  } finally {
    db.close();
  }
}

async function readParkedTaskCacheFromDb(
  db: IDBDatabase,
  ownerUserId: string,
): Promise<ParkedTaskCacheRestoreSnapshot> {
  const [entries, metadataRows] = await Promise.all([
    getAllFromStore<UnknownRecord>(db, FOCUS_CONFIG.IDB_STORES.PARKED_TASKS),
    getAllFromStore<{ key: string; value: unknown }>(db, FOCUS_CONFIG.IDB_STORES.SYNC_METADATA),
  ]);
  const ownerRows = entries.filter(entry => entry['ownerUserId'] === ownerUserId);
  const ownerCursorKey = getParkingSyncCursorKey(ownerUserId);
  const syncMetadata = Object.fromEntries(
    metadataRows
      .filter((row): row is { key: string; value: unknown } => !!row && row.key === ownerCursorKey)
      .map(row => [row.key, row.value]),
  );
  const snapshot = normalizeParkedTaskCacheRestoreSnapshot({
    present: ownerRows.length > 0 || Object.keys(syncMetadata).length > 0,
    entries: ownerRows,
    syncMetadata,
  }, ownerUserId);
  if (!snapshot) throw new Error('local backup UI restore parked task cache is invalid');
  return snapshot;
}

function replaceParkedTaskCache(
  tx: IDBTransaction,
  ownerUserId: string,
  snapshot: ParkedTaskCacheRestoreSnapshot,
): void {
  const parkedStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS);
  const metadataStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA);
  const ownerCursorKey = getParkingSyncCursorKey(ownerUserId);
  const cursorRequest = parkedStore.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor) {
      const row = cursor.value as Partial<{ ownerUserId?: string }> | null;
      if (row?.ownerUserId === ownerUserId) cursor.delete();
      cursor.continue();
      return;
    }
    for (const entry of snapshot.entries) parkedStore.put(entry);
    metadataStore.delete(ownerCursorKey);
    for (const [key, value] of Object.entries(snapshot.syncMetadata)) {
      metadataStore.put({ key, value });
    }
  };
}

async function openFocusModeRestoreDb(): Promise<IDBDatabase> {
  return await openIndexedDBAdaptive({
    dbName: FOCUS_CONFIG.SYNC.IDB_NAME,
    targetVersion: FOCUS_CONFIG.SYNC.IDB_VERSION,
    requiredStores: [
      FOCUS_CONFIG.IDB_STORES.PARKED_TASKS,
      FOCUS_CONFIG.IDB_STORES.SYNC_METADATA,
    ],
    ensureStores: (db) => {
      if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS)) {
        db.createObjectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, { keyPath: 'taskId' });
      }
      if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA)) {
        db.createObjectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA, { keyPath: 'key' });
      }
    },
  });
}

function readOwnerScopedLaunchSnapshot(storageKey: string, ownerUserId: string): string | null {
  const raw = readLocalStorageValue(storageKey);
  if (raw === null) return null;
  const parsed = parseJsonObject(raw);
  if (!parsed || normalizeLaunchSnapshot(parsed) === null) {
    throw new Error(`local backup UI restore ${storageKey} snapshot is invalid`);
  }
  return isLaunchSnapshotOwnedByCurrentUser(parsed, ownerUserId) ? raw : null;
}

function assertLaunchSnapshotStorageMayWrite(ownerUserId: string, storageKey: string): void {
  const raw = readLocalStorageValue(storageKey);
  if (raw === null) return;
  const parsed = parseJsonObject(raw);
  if (!parsed || normalizeLaunchSnapshot(parsed) === null) {
    throw new Error(`local backup UI restore ${storageKey} snapshot is invalid`);
  }
  if (!isLaunchSnapshotOwnedByCurrentUser(parsed, ownerUserId)) {
    throw new Error(`local backup UI restore ${storageKey} belongs to another owner`);
  }
}

function isParkedTaskCacheRestoreEntry(value: unknown, ownerUserId: string): value is UnknownRecord {
  return isUnknownRecord(value)
    && value['ownerUserId'] === ownerUserId
    && typeof value['taskId'] === 'string'
    && typeof value['projectId'] === 'string'
    && typeof value['updatedAt'] === 'string'
    && isUnknownRecord(value['task'])
    && typeof value['task']['id'] === 'string'
    && typeof value['task']['content'] === 'string';
}

function sortParkedTaskCacheRestoreEntries(entries: unknown[]): UnknownRecord[] {
  return entries
    .map(entry => ({ ...(entry as UnknownRecord) }))
    .sort((left, right) => String(left['taskId']).localeCompare(String(right['taskId'])));
}

function isValidLaunchSnapshotRaw(raw: string, ownerUserId: string): boolean {
  const parsed = parseJsonObject(raw);
  return !!parsed
    && normalizeLaunchSnapshot(parsed) !== null
    && isLaunchSnapshotOwnedByCurrentUser(parsed, ownerUserId);
}

function getDockSnapshotIndexedDbKey(ownerUserId: string): string {
  return `${DOCK_SNAPSHOT_IDB_KEY_PREFIX}.${ownerUserId || 'anonymous'}`;
}

function getDockSnapshotLocalStorageKey(ownerUserId: string): string {
  return `${PARKING_CONFIG.DOCK_SNAPSHOT_STORAGE_KEY}.${ownerUserId || 'anonymous'}`;
}

function getParkingSyncCursorKey(ownerUserId: string): string {
  return `${PARKING_SYNC_CURSOR_KEY}:${encodeURIComponent(ownerUserId)}`;
}

function parseJsonObject(raw: string): UnknownRecord | null {
  let value: unknown = null;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  return isUnknownRecord(value) ? value : null;
}

function normalizeOptionalSnapshot<T>(
  value: unknown,
  normalize: (candidate: unknown) => T | null,
): { valid: boolean; value?: T } {
  if (value === undefined) return { valid: true };
  const normalized = normalize(value);
  return normalized ? { valid: true, value: normalized } : { valid: false };
}

function getAllFromStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve((request.result ?? []) as T[]);
    request.onerror = () => reject(request.error);
  });
}

function readLocalStorageValue(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(key);
}

function restoreLocalStorageValue(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (value === null) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, value);
  }
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
