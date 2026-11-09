import {
  toStoredConflictRecord,
  type ConflictRecord,
} from './conflict-storage.helpers';

export interface ConflictStorageSchemaLogger {
  error(message: string, context?: unknown): void;
  info(message: string): void;
}

export function createConflictObjectStore(db: IDBDatabase, storeName: string): IDBObjectStore {
  const store = db.createObjectStore(storeName, { keyPath: 'scopedId' });
  ensureConflictIndexes(store);
  return store;
}

export function migrateConflictObjectStore(options: {
  db: IDBDatabase;
  existingStore: IDBObjectStore;
  logger: ConflictStorageSchemaLogger;
  storeName: string;
}): void {
  const { db, existingStore, logger, storeName } = options;
  const migrateRequest = existingStore.getAll();
  db.deleteObjectStore(storeName);
  const nextStore = createConflictObjectStore(db, storeName);

  migrateRequest.onsuccess = () => {
    const legacyRecords = (migrateRequest.result || []) as ConflictRecord[];
    legacyRecords.forEach(record => {
      nextStore.put(toStoredConflictRecord(record));
    });
  };

  migrateRequest.onerror = () => {
    logger.error('迁移 conflicts 存储失败', migrateRequest.error);
  };
  logger.info('升级 conflicts 存储到 owner-scoped 主键');
}

export function ensureConflictIndexes(store: IDBObjectStore): void {
  if (!store.indexNames.contains('ownerUserId')) {
    store.createIndex('ownerUserId', 'ownerUserId', { unique: false });
  }
  if (!store.indexNames.contains('conflictedAt')) {
    store.createIndex('conflictedAt', 'conflictedAt', { unique: false });
  }
}
