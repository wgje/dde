import { AUTH_CONFIG } from '../config/auth.config';
import type { DataSafetyExportPackage } from './data-safety-package';

const OFFLINE_SNAPSHOT_DB_NAME = 'nanoflow-offline-snapshots';
const OFFLINE_SNAPSHOT_STORE_NAME = 'snapshots';
const OFFLINE_SNAPSHOT_STORAGE_KEY = 'nanoflow.offline-cache-v2';
const OFFLINE_SNAPSHOT_RECORD_PREFIX = 'offline-snapshot:';
const LEGACY_OFFLINE_SNAPSHOT_RECORD_ID = 'offline-snapshot';

type UnknownRecord = Record<string, unknown>;

export interface DataSafetyOfflineSnapshotRecord extends UnknownRecord {
  id: string;
}

export interface DataSafetyOfflineSnapshotRestoreSnapshot {
  scopedLocalStorageValue: string | null;
  scopedIndexedDbRecord: DataSafetyOfflineSnapshotRecord | null;
  legacyLocalStorageValue?: string | null;
  legacyIndexedDbRecord?: DataSafetyOfflineSnapshotRecord | null;
}

export function collectOfflineSnapshotRestoreValidationErrors(pkg: DataSafetyExportPackage): string[] {
  try {
    readCanonicalOfflineSnapshotPayload(pkg);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export async function readOfflineSnapshotRestoreSnapshot(
  ownerUserId: string,
): Promise<DataSafetyOfflineSnapshotRestoreSnapshot> {
  const db = await openOfflineSnapshotDatabase();
  try {
    const snapshot: DataSafetyOfflineSnapshotRestoreSnapshot = {
      scopedLocalStorageValue: readLocalStorageValue(getScopedStorageKey(ownerUserId)),
      scopedIndexedDbRecord: db
        ? await readSnapshotRecord(db, getScopedRecordId(ownerUserId))
        : null,
    };
    if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      snapshot.legacyLocalStorageValue = readLocalStorageValue(OFFLINE_SNAPSHOT_STORAGE_KEY);
      snapshot.legacyIndexedDbRecord = db
        ? await readSnapshotRecord(db, LEGACY_OFFLINE_SNAPSHOT_RECORD_ID)
        : null;
    }
    return snapshot;
  } finally {
    db?.close();
  }
}

export async function restoreOfflineSnapshot(pkg: DataSafetyExportPackage): Promise<void> {
  const canonicalPayload = readCanonicalOfflineSnapshotPayload(pkg);
  if (canonicalPayload === undefined) return;
  restoreLocalStorageValue(getScopedStorageKey(pkg.ownerUserId), canonicalPayload);
  if (pkg.ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
    restoreLocalStorageValue(OFFLINE_SNAPSHOT_STORAGE_KEY, null);
  }
  const db = await requireOfflineSnapshotDatabase();
  try {
    const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readwrite');
    const store = tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME);
    if (canonicalPayload === null) {
      store.delete(getScopedRecordId(pkg.ownerUserId));
    } else {
      store.put({
        id: getScopedRecordId(pkg.ownerUserId),
        ownerUserId: pkg.ownerUserId,
        data: canonicalPayload,
      });
    }
    if (pkg.ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      store.delete(LEGACY_OFFLINE_SNAPSHOT_RECORD_ID);
    }
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

export async function restoreOfflineSnapshotRestoreSnapshot(
  ownerUserId: string,
  snapshot: DataSafetyOfflineSnapshotRestoreSnapshot,
): Promise<void> {
  restoreLocalStorageValue(getScopedStorageKey(ownerUserId), snapshot.scopedLocalStorageValue);
  if (snapshot.legacyLocalStorageValue !== undefined) {
    restoreLocalStorageValue(OFFLINE_SNAPSHOT_STORAGE_KEY, snapshot.legacyLocalStorageValue);
  }
  const db = await requireOfflineSnapshotDatabase();
  try {
    const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readwrite');
    const store = tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME);
    restoreSnapshotRecord(store, getScopedRecordId(ownerUserId), snapshot.scopedIndexedDbRecord);
    if (snapshot.legacyIndexedDbRecord !== undefined) {
      restoreSnapshotRecord(store, LEGACY_OFFLINE_SNAPSHOT_RECORD_ID, snapshot.legacyIndexedDbRecord);
    }
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

export function normalizeOfflineSnapshotRestoreSnapshot(
  value: unknown,
): DataSafetyOfflineSnapshotRestoreSnapshot | null {
  if (!isUnknownRecord(value)
    || !isNullableString(value['scopedLocalStorageValue'])
    || !isNullableSnapshotRecord(value['scopedIndexedDbRecord'])) {
    return null;
  }
  if (value['legacyLocalStorageValue'] !== undefined
    && !isNullableString(value['legacyLocalStorageValue'])) {
    return null;
  }
  if (value['legacyIndexedDbRecord'] !== undefined
    && !isNullableSnapshotRecord(value['legacyIndexedDbRecord'])) {
    return null;
  }
  return {
    scopedLocalStorageValue: value['scopedLocalStorageValue'],
    scopedIndexedDbRecord: value['scopedIndexedDbRecord'],
    ...(value['legacyLocalStorageValue'] === undefined
      ? {}
      : { legacyLocalStorageValue: value['legacyLocalStorageValue'] }),
    ...(value['legacyIndexedDbRecord'] === undefined
      ? {}
      : { legacyIndexedDbRecord: value['legacyIndexedDbRecord'] }),
  };
}

function readCanonicalOfflineSnapshotPayload(pkg: DataSafetyExportPackage): string | null | undefined {
  const value = pkg.localState.offlineSnapshots;
  if (value === undefined || value === null) return undefined;
  if (!isUnknownRecord(value)) {
    throw new Error('localState.offlineSnapshots must be an object');
  }
  const keys = Object.keys(value);
  const unknownKeys = keys.filter(key => key !== 'localStorage' && key !== 'indexedDb');
  if (unknownKeys.length > 0) {
    throw new Error(`localState.offlineSnapshots contains unsupported key(s): ${unknownKeys.join(', ')}`);
  }
  const hasLocalStorage = Object.prototype.hasOwnProperty.call(value, 'localStorage');
  const hasIndexedDb = Object.prototype.hasOwnProperty.call(value, 'indexedDb');
  if (!hasLocalStorage && !hasIndexedDb) return undefined;
  const localStorageValue = value['localStorage'];
  const indexedDbValue = value['indexedDb'];
  if (hasLocalStorage && !isNullableString(localStorageValue)) {
    throw new Error('localState.offlineSnapshots.localStorage must be a string or null');
  }
  if (hasIndexedDb && !isNullableString(indexedDbValue)) {
    throw new Error('localState.offlineSnapshots.indexedDb must be a string or null');
  }
  if (typeof localStorageValue === 'string'
    && typeof indexedDbValue === 'string'
    && localStorageValue !== indexedDbValue) {
    throw new Error('localState.offlineSnapshots mirrors differ');
  }
  const canonicalPayload = typeof localStorageValue === 'string'
    ? localStorageValue
    : typeof indexedDbValue === 'string'
      ? indexedDbValue
      : null;
  return canonicalPayload === null
    ? null
    : validateAndNormalizeOfflineSnapshotPayload(canonicalPayload, pkg);
}

function validateAndNormalizeOfflineSnapshotPayload(
  raw: string,
  pkg: DataSafetyExportPackage,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('localState.offlineSnapshots payload is invalid JSON');
  }
  if (!isUnknownRecord(parsed) || !Array.isArray(parsed['projects'])) {
    throw new Error('localState.offlineSnapshots payload must contain projects');
  }
  const ownerUserId = parsed['ownerUserId'];
  if (ownerUserId !== pkg.ownerUserId) {
    if (!(ownerUserId === undefined && pkg.ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID)) {
      throw new Error('localState.offlineSnapshots.ownerUserId does not match restore owner');
    }
    parsed['ownerUserId'] = pkg.ownerUserId;
  }
  if (typeof parsed['savedAt'] !== 'string' || Number.isNaN(Date.parse(parsed['savedAt']))) {
    throw new Error('localState.offlineSnapshots.savedAt must be an ISO timestamp');
  }
  const visibleProjectIds = new Set(pkg.localData.projects.map(project => project.id));
  parsed['projects'].forEach((project, projectIndex) => {
    const prefix = `localState.offlineSnapshots.projects[${projectIndex}]`;
    if (!isUnknownRecord(project)
      || typeof project['id'] !== 'string'
      || !visibleProjectIds.has(project['id'])
      || !Array.isArray(project['tasks'])
      || !Array.isArray(project['connections'])) {
      throw new Error(`${prefix} is invalid or outside the package project scope`);
    }
    project['tasks'].forEach((task, taskIndex) => {
      if (!isUnknownRecord(task) || typeof task['content'] !== 'string') {
        throw new Error(`${prefix}.tasks[${taskIndex}].content must be a string`);
      }
    });
  });
  return JSON.stringify(parsed);
}

function openOfflineSnapshotDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_SNAPSHOT_DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE_NAME)) {
        request.result.createObjectStore(OFFLINE_SNAPSHOT_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function requireOfflineSnapshotDatabase(): Promise<IDBDatabase> {
  const db = await openOfflineSnapshotDatabase();
  if (!db) throw new Error('IndexedDB unavailable for offline snapshot restore');
  return db;
}

function readSnapshotRecord(
  db: IDBDatabase,
  id: string,
): Promise<DataSafetyOfflineSnapshotRecord | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readonly');
    const request = tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME).get(id);
    request.onsuccess = () => resolve((request.result as DataSafetyOfflineSnapshotRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

function restoreSnapshotRecord(
  store: IDBObjectStore,
  id: string,
  record: DataSafetyOfflineSnapshotRecord | null,
): void {
  if (record === null) {
    store.delete(id);
    return;
  }
  store.put(record);
}

function readLocalStorageValue(key: string): string | null {
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
}

function restoreLocalStorageValue(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') {
    if (value !== null) throw new Error('localStorage unavailable for offline snapshot restore');
    return;
  }
  if (value === null) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, value);
}

function getScopedStorageKey(ownerUserId: string): string {
  return `${OFFLINE_SNAPSHOT_STORAGE_KEY}.${ownerUserId}`;
}

function getScopedRecordId(ownerUserId: string): string {
  return `${OFFLINE_SNAPSHOT_RECORD_PREFIX}${ownerUserId}`;
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('offline snapshot transaction aborted'));
  });
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isNullableSnapshotRecord(value: unknown): value is DataSafetyOfflineSnapshotRecord | null {
  return value === null || (isUnknownRecord(value) && typeof value['id'] === 'string');
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
