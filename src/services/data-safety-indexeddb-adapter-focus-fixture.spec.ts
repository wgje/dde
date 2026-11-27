import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_CONFIG } from '../config/focus.config';
import { openIndexedDBAdaptive } from '../utils/indexeddb-open';
import {
  clearInterruptedRestoreParkedTaskCache,
  getAllStoreValues,
  putStoreValue,
  readInterruptedRestoreParkedTaskCache,
  seedInterruptedRestoreParkedTaskCache,
} from './data-safety-indexeddb-adapter.spec-helpers';

describe('interrupted Focus restore fixture version compatibility', () => {
  beforeEach(() => {
    // Isolate the synthetic schema from other no-isolate suites and their open handles.
    vi.stubGlobal('indexedDB', new IDBFactory());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([false, true])('seeds, reads and clears a repaired v4 Focus schema (alreadyRepaired=%s)', async alreadyRepaired => {
    const stores = FOCUS_CONFIG.IDB_STORES;
    const sentinel = { id: 'black-box-preserved', content: 'synthetic original bytes' };
    const initial = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(FOCUS_CONFIG.SYNC.IDB_NAME, FOCUS_CONFIG.SYNC.IDB_VERSION);
      request.onupgradeneeded = () => request.result.createObjectStore(stores.BLACK_BOX_ENTRIES, { keyPath: 'id' });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await putStoreValue(initial, stores.BLACK_BOX_ENTRIES, sentinel);
    initial.close();

    if (alreadyRepaired) {
      const repaired = await openIndexedDBAdaptive({
        dbName: FOCUS_CONFIG.SYNC.IDB_NAME,
        targetVersion: FOCUS_CONFIG.SYNC.IDB_VERSION,
        requiredStores: [stores.PARKED_TASKS, stores.SYNC_METADATA],
        ensureStores: db => {
          db.createObjectStore(stores.PARKED_TASKS, { keyPath: 'taskId' });
          db.createObjectStore(stores.SYNC_METADATA, { keyPath: 'key' });
        },
      });
      expect(repaired.version).toBe(5);
      repaired.close();
    }

    const entries = [{ taskId: 'parked-synthetic', ownerUserId: 'user-1', title: 'synthetic parked entry' }];
    const syncMetadata = { 'cursor:user-1': { updatedAt: '2026-11-27T00:00:00.000Z', id: 'parked-synthetic' } };
    await seedInterruptedRestoreParkedTaskCache(entries, syncMetadata);
    await expect(readInterruptedRestoreParkedTaskCache()).resolves.toEqual({ entries, syncMetadata });
    await clearInterruptedRestoreParkedTaskCache();
    await expect(readInterruptedRestoreParkedTaskCache()).resolves.toEqual({ entries: [], syncMetadata: {} });

    const result = await openIndexedDBAdaptive({
      dbName: FOCUS_CONFIG.SYNC.IDB_NAME,
      targetVersion: FOCUS_CONFIG.SYNC.IDB_VERSION,
      requiredStores: [stores.BLACK_BOX_ENTRIES, stores.PARKED_TASKS, stores.SYNC_METADATA],
    });
    try {
      expect(result.version).toBe(5);
      await expect(getAllStoreValues(result, stores.BLACK_BOX_ENTRIES)).resolves.toEqual([sentinel]);
    } finally {
      result.close();
    }
  });
});
