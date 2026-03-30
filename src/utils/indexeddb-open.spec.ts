import { describe, expect, it } from 'vitest';
import { openIndexedDBAdaptive } from './indexeddb-open';

function createDbName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function openRawDB(
  dbName: string,
  version?: number,
  onUpgrade?: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(dbName) : indexedDB.open(dbName, version);
    request.onupgradeneeded = () => onUpgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unknown IndexedDB error'));
  });
}

function deleteRawDB(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Failed to delete IndexedDB ${dbName}`));
    request.onblocked = () => reject(new Error(`Delete blocked for IndexedDB ${dbName}`));
  });
}

describe('openIndexedDBAdaptive', () => {
  it('reuses existing higher version without downgrade open', async () => {
    const dbName = createDbName('idb-adaptive-existing');

    try {
      const existingDb = await openRawDB(dbName, 3, db => {
        if (!db.objectStoreNames.contains('black_box_entries')) {
          db.createObjectStore('black_box_entries', { keyPath: 'id' });
        }
      });
      existingDb.close();

      const db = await openIndexedDBAdaptive({
        dbName,
        targetVersion: 2,
        requiredStores: ['black_box_entries'],
      });

      expect(db.version).toBe(3);
      expect(db.objectStoreNames.contains('black_box_entries')).toBe(true);
      db.close();
    } finally {
      await deleteRawDB(dbName);
    }
  });

  it('creates latest schema for a fresh database', async () => {
    const dbName = createDbName('idb-adaptive-fresh');

    try {
      const db = await openIndexedDBAdaptive({
        dbName,
        targetVersion: 3,
        requiredStores: ['black_box_entries', 'sync_metadata'],
        ensureStores: upgraded => {
          if (!upgraded.objectStoreNames.contains('black_box_entries')) {
            upgraded.createObjectStore('black_box_entries', { keyPath: 'id' });
          }
          if (!upgraded.objectStoreNames.contains('sync_metadata')) {
            upgraded.createObjectStore('sync_metadata', { keyPath: 'key' });
          }
        },
      });

      expect(db.version).toBe(3);
      expect(db.objectStoreNames.contains('black_box_entries')).toBe(true);
      expect(db.objectStoreNames.contains('sync_metadata')).toBe(true);
      db.close();
    } finally {
      await deleteRawDB(dbName);
    }
  });

  it('repairs missing stores by bumping schema version', async () => {
    const dbName = createDbName('idb-adaptive-repair');

    try {
      const existingDb = await openRawDB(dbName, 3, db => {
        if (!db.objectStoreNames.contains('black_box_entries')) {
          db.createObjectStore('black_box_entries', { keyPath: 'id' });
        }
      });
      existingDb.close();

      const db = await openIndexedDBAdaptive({
        dbName,
        targetVersion: 3,
        requiredStores: ['black_box_entries', 'sync_metadata'],
        ensureStores: upgraded => {
          if (!upgraded.objectStoreNames.contains('sync_metadata')) {
            upgraded.createObjectStore('sync_metadata', { keyPath: 'key' });
          }
        },
      });

      expect(db.version).toBe(4);
      expect(db.objectStoreNames.contains('black_box_entries')).toBe(true);
      expect(db.objectStoreNames.contains('sync_metadata')).toBe(true);
      db.close();
    } finally {
      await deleteRawDB(dbName);
    }
  });

  it('repairs missing indexes when schemaNeedsUpgrade reports stale store shape', async () => {
    const dbName = createDbName('idb-adaptive-index-repair');

    try {
      const existingDb = await openRawDB(dbName, 2, db => {
        if (!db.objectStoreNames.contains('tasks')) {
          const store = db.createObjectStore('tasks', { keyPath: 'id' });
          store.createIndex('projectId', 'projectId', { unique: false });
        }
      });
      existingDb.close();

      const db = await openIndexedDBAdaptive({
        dbName,
        targetVersion: 2,
        requiredStores: ['tasks'],
        schemaNeedsUpgrade: openedDb => {
          const tx = openedDb.transaction('tasks', 'readonly');
          return !tx.objectStore('tasks').indexNames.contains('projectId_updatedAt');
        },
        ensureStores: (_db, transaction) => {
          const store = transaction?.objectStore('tasks');
          if (store && !store.indexNames.contains('projectId_updatedAt')) {
            store.createIndex('projectId_updatedAt', ['projectId', 'updatedAt'], { unique: false });
          }
        },
      });

      expect(db.version).toBe(3);
      const tx = db.transaction('tasks', 'readonly');
      expect(tx.objectStore('tasks').indexNames.contains('projectId_updatedAt')).toBe(true);
      db.close();
    } finally {
      await deleteRawDB(dbName);
    }
  });
});
