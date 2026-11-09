import type { DataSafetyExportPackage } from './data-safety-package';
import {
  CONFLICT_FALLBACK_KEY_PREFIX,
  getConflictFallbackKey,
  mergeConflictOperationEvidence,
  mergeConflictRecords,
  selectPreferredConflictRecord,
  toStoredConflictRecord,
  type ConflictRecord,
  type StoredConflictRecord,
} from './conflict-storage.helpers';
import { getConflictFallbackKeysForOwner } from './conflict-storage-fallback.helpers';
import {
  createConflictObjectStore,
  ensureConflictIndexes,
  migrateConflictObjectStore,
} from './conflict-storage-schema.helpers';
import { isRestorableConflictRecord } from './import-backup-conversion.helpers';

const CONFLICT_DB_NAME = 'nanoflow-conflicts';
const CONFLICT_DB_VERSION = 2;
const CONFLICT_STORE_NAME = 'conflicts';

type UnknownRecord = Record<string, unknown>;

export interface DataSafetyConflictRestoreSnapshot {
  indexedDbRecords: StoredConflictRecord[] | null;
  fallbackLocalStorageEntries: Record<string, string>;
}

export function collectConflictRestoreValidationErrors(pkg: DataSafetyExportPackage): string[] {
  const visibleProjectIds = new Set(pkg.localData.projects.map(project => project.id));
  return pkg.localState.conflicts.flatMap((conflict, index) => (
    validateConflictRecord(conflict, index, pkg.ownerUserId, visibleProjectIds)
  ));
}

export async function readConflictRestoreSnapshot(
  ownerUserId: string,
): Promise<DataSafetyConflictRestoreSnapshot> {
  const db = await openConflictDatabase();
  let indexedDbRecords: StoredConflictRecord[] | null = null;
  if (db) {
    try {
      indexedDbRecords = await readOwnerConflictRecords(db, ownerUserId);
    } finally {
      db.close();
    }
  }

  return {
    indexedDbRecords,
    fallbackLocalStorageEntries: readOwnerFallbackEntries(ownerUserId),
  };
}

export function projectConflictRestoreSnapshot(
  preImage: DataSafetyConflictRestoreSnapshot,
  incomingRecords: readonly ConflictRecord[],
  ownerUserId: string,
): DataSafetyConflictRestoreSnapshot {
  const indexedDbRecords = preImage.indexedDbRecords === null
    ? null
    : preImage.indexedDbRecords.map(record => ({ ...record }));
  const fallbackLocalStorageEntries = { ...preImage.fallbackLocalStorageEntries };

  for (const incomingRecord of incomingRecords) {
    if (incomingRecord.ownerUserId !== ownerUserId) {
      throw invalidConflictRestore('target record owner does not match restore owner');
    }

    const storedIdentity = toStoredConflictRecord(incomingRecord, ownerUserId);
    const existingIndexedRecord = indexedDbRecords?.find(record => (
      record.scopedId === storedIdentity.scopedId
    )) ?? null;
    const fallbackKey = getConflictFallbackKey(incomingRecord.projectId, ownerUserId);
    const fallbackRecord = parseFallbackConflictRecord(fallbackLocalStorageEntries[fallbackKey]);
    const recoveredRecord = mergeConflictRestoreStorageSources(
      existingIndexedRecord,
      fallbackRecord,
    );
    const mergedRecord = mergeConflictOperationEvidence(
      mergeConflictRecords(recoveredRecord, incomingRecord),
      existingIndexedRecord,
      fallbackRecord,
      incomingRecord,
    );

    if (indexedDbRecords !== null) {
      const nextStoredRecord = toStoredConflictRecord(mergedRecord, ownerUserId);
      const existingIndex = indexedDbRecords.findIndex(record => (
        record.scopedId === nextStoredRecord.scopedId
      ));
      if (existingIndex === -1) indexedDbRecords.push(nextStoredRecord);
      else indexedDbRecords[existingIndex] = nextStoredRecord;
      continue;
    }

    fallbackLocalStorageEntries[fallbackKey] = JSON.stringify(mergedRecord);
  }

  return {
    indexedDbRecords: indexedDbRecords?.sort((left, right) => (
      left.scopedId.localeCompare(right.scopedId)
    )) ?? null,
    fallbackLocalStorageEntries,
  };
}

function mergeConflictRestoreStorageSources(
  indexedRecord: StoredConflictRecord | null,
  fallbackRecord: ConflictRecord | null,
): ConflictRecord | null {
  const preferredRecord = selectPreferredConflictRecord(indexedRecord, fallbackRecord);
  if (!indexedRecord || !fallbackRecord || !preferredRecord) {
    return preferredRecord;
  }

  const secondaryRecord = preferredRecord === indexedRecord ? fallbackRecord : indexedRecord;
  return mergeConflictOperationEvidence(
    mergeConflictRecords(secondaryRecord, preferredRecord),
    secondaryRecord,
    preferredRecord,
  );
}

function parseFallbackConflictRecord(rawValue: string | undefined): ConflictRecord | null {
  if (!rawValue) return null;
  try {
    return JSON.parse(rawValue) as ConflictRecord | null;
  } catch {
    return null;
  }
}

function invalidConflictRestore(reason: string): Error {
  return new Error(`conflict restore payload is invalid: ${reason}`);
}

export async function restoreConflicts(pkg: DataSafetyExportPackage): Promise<void> {
  const conflicts = readRestorableConflicts(pkg);
  const storedRecords = conflicts.map(conflict => toStoredConflictRecord(conflict, pkg.ownerUserId));
  const db = await openConflictDatabase();
  if (db) {
    try {
      await replaceOwnerConflictRecords(db, pkg.ownerUserId, storedRecords);
    } finally {
      db.close();
    }
    replaceOwnerFallbackEntries(pkg.ownerUserId, {});
    return;
  }

  replaceOwnerFallbackEntries(
    pkg.ownerUserId,
    Object.fromEntries(conflicts.map(conflict => [
      getConflictFallbackKey(conflict.projectId, pkg.ownerUserId, CONFLICT_FALLBACK_KEY_PREFIX),
      JSON.stringify(conflict),
    ])),
  );
}

export async function restoreConflictRestoreSnapshot(
  ownerUserId: string,
  snapshot: DataSafetyConflictRestoreSnapshot,
): Promise<void> {
  const db = await openConflictDatabase();
  if (snapshot.indexedDbRecords !== null) {
    if (!db) {
      throw new Error('IndexedDB unavailable for conflict rollback');
    }
    try {
      await replaceOwnerConflictRecords(db, ownerUserId, snapshot.indexedDbRecords);
    } finally {
      db.close();
    }
  } else {
    db?.close();
  }
  replaceOwnerFallbackEntries(ownerUserId, snapshot.fallbackLocalStorageEntries);
}

export function normalizeConflictRestoreSnapshot(
  value: unknown,
): DataSafetyConflictRestoreSnapshot | null {
  if (!isUnknownRecord(value)) return null;
  const indexedDbRecords = value['indexedDbRecords'];
  const fallbackEntries = value['fallbackLocalStorageEntries'];
  if (indexedDbRecords !== null
    && (!Array.isArray(indexedDbRecords) || !indexedDbRecords.every(isStoredConflictRecord))) {
    return null;
  }
  if (!isUnknownRecord(fallbackEntries)
    || Object.values(fallbackEntries).some(entry => typeof entry !== 'string')) {
    return null;
  }
  return {
    indexedDbRecords: indexedDbRecords === null ? null : indexedDbRecords,
    fallbackLocalStorageEntries: fallbackEntries as Record<string, string>,
  };
}

function readRestorableConflicts(pkg: DataSafetyExportPackage): ConflictRecord[] {
  const errors = collectConflictRestoreValidationErrors(pkg);
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
  return pkg.localState.conflicts as ConflictRecord[];
}

function validateConflictRecord(
  value: unknown,
  index: number,
  ownerUserId: string,
  visibleProjectIds: ReadonlySet<string>,
): string[] {
  const prefix = `localState.conflicts[${index}]`;
  if (isUnknownRecord(value)
    && typeof value['ownerUserId'] === 'string'
    && value['ownerUserId'] !== ownerUserId) {
    return [`${prefix}.ownerUserId does not match restore owner`];
  }
  if (!isRestorableConflictRecord(value, ownerUserId)) {
    return [`${prefix} is invalid`];
  }
  const errors: string[] = [];
  if (value.ownerUserId !== ownerUserId) {
    errors.push(`${prefix}.ownerUserId does not match restore owner`);
  }
  if (!visibleProjectIds.has(value.projectId)) {
    errors.push(`${prefix}.projectId is outside the package project scope`);
  }
  validateConflictProject(value.localProject, value.projectId, `${prefix}.localProject`, errors);
  if (value.remoteProject) {
    validateConflictProject(value.remoteProject, value.projectId, `${prefix}.remoteProject`, errors);
  }
  value.operationConflicts?.forEach((conflict, operationIndex) => {
    const operationPrefix = `${prefix}.operationConflicts[${operationIndex}]`;
    if (conflict.projectId !== value.projectId) {
      errors.push(`${operationPrefix}.projectId does not match conflict project`);
    }
    if (conflict.entityType === 'task') {
      if (!isUnknownRecord(conflict.localEntity) || typeof conflict.localEntity['content'] !== 'string') {
        errors.push(`${operationPrefix}.localEntity.content must be a string`);
      }
      if (conflict.remoteEntity
        && (!isUnknownRecord(conflict.remoteEntity) || typeof conflict.remoteEntity['content'] !== 'string')) {
        errors.push(`${operationPrefix}.remoteEntity.content must be a string`);
      }
    }
  });
  return errors;
}

function validateConflictProject(
  value: unknown,
  projectId: string,
  prefix: string,
  errors: string[],
): void {
  if (!isUnknownRecord(value)
    || value['id'] !== projectId
    || !Array.isArray(value['tasks'])
    || !Array.isArray(value['connections'])) {
    errors.push(`${prefix} is invalid`);
    return;
  }
  value['tasks'].forEach((task, taskIndex) => {
    if (!isUnknownRecord(task) || typeof task['content'] !== 'string') {
      errors.push(`${prefix}.tasks[${taskIndex}].content must be a string`);
    }
  });
}

function openConflictDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CONFLICT_DB_NAME, CONFLICT_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const transaction = request.transaction;
      if (!transaction) return;
      if (!db.objectStoreNames.contains(CONFLICT_STORE_NAME)) {
        createConflictObjectStore(db, CONFLICT_STORE_NAME);
        return;
      }
      const store = transaction.objectStore(CONFLICT_STORE_NAME);
      if (event.oldVersion < 2 || store.keyPath !== 'scopedId') {
        migrateConflictObjectStore({
          db,
          existingStore: store,
          storeName: CONFLICT_STORE_NAME,
          logger: { error: () => undefined, info: () => undefined },
        });
        return;
      }
      ensureConflictIndexes(store);
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function readOwnerConflictRecords(
  db: IDBDatabase,
  ownerUserId: string,
): Promise<StoredConflictRecord[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFLICT_STORE_NAME, 'readonly');
    const request = tx.objectStore(CONFLICT_STORE_NAME).index('ownerUserId').getAll(ownerUserId);
    request.onsuccess = () => resolve((request.result ?? []) as StoredConflictRecord[]);
    request.onerror = () => reject(request.error);
  });
}

async function replaceOwnerConflictRecords(
  db: IDBDatabase,
  ownerUserId: string,
  target: StoredConflictRecord[],
): Promise<void> {
  const current = await readOwnerConflictRecords(db, ownerUserId);
  const tx = db.transaction(CONFLICT_STORE_NAME, 'readwrite');
  const store = tx.objectStore(CONFLICT_STORE_NAME);
  current.forEach(record => store.delete(record.scopedId));
  target.forEach(record => store.put(record));
  await waitForTransaction(tx);
}

function readOwnerFallbackEntries(ownerUserId: string): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  return Object.fromEntries(
    getConflictFallbackKeysForOwner(ownerUserId, CONFLICT_FALLBACK_KEY_PREFIX)
      .flatMap((key) => {
        const value = localStorage.getItem(key);
        return value === null ? [] : [[key, value]];
      }),
  );
}

function replaceOwnerFallbackEntries(
  ownerUserId: string,
  entries: Record<string, string>,
): void {
  if (typeof localStorage === 'undefined') {
    if (Object.keys(entries).length > 0) {
      throw new Error('localStorage unavailable for conflict restore');
    }
    return;
  }
  getConflictFallbackKeysForOwner(ownerUserId, CONFLICT_FALLBACK_KEY_PREFIX)
    .forEach(key => localStorage.removeItem(key));
  Object.entries(entries).forEach(([key, value]) => localStorage.setItem(key, value));
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('conflict transaction aborted'));
  });
}

function isStoredConflictRecord(value: unknown): value is StoredConflictRecord {
  return isUnknownRecord(value)
    && typeof value['scopedId'] === 'string'
    && typeof value['ownerUserId'] === 'string'
    && typeof value['projectId'] === 'string';
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
