import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DB_CONFIG } from '../app/core/state/persistence/indexeddb.service';
import { restoreDataSafetyPackageToIndexedDb } from './data-safety-indexeddb-adapter';
import {
  buildDataSafetyExportPackage,
  type DataSafetyRetryQueueItem,
} from './data-safety-package';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';
import {
  cleanupDataSafetyAdapterStorage,
  connection,
  cursor,
  getAllStoreValues,
  meta,
  openRetryQueueDatabase,
  project,
  putStoreValue,
  resetDataSafetyAdapterStorage,
  task,
} from './data-safety-indexeddb-adapter.spec-helpers';

const RETRY_QUEUE_DB_NAME = 'nanoflow-retry-queue';
const RETRY_QUEUE_STORE_NAME = 'offline_mutation_queue';
const RESTORE_MARKER_KEY = 'nanoflow.data-safety-restore-marker.user-1';

type StoredRetryQueueItem = DataSafetyRetryQueueItem & {
  sourceUserId: string;
  projectId: string;
};

export function registerDataSafetyRetryQueueRaceSpecs(): void {
  describe('data-safety RetryQueue transaction races', () => {
    let db: IDBDatabase;
    let retryDb: IDBDatabase;

    beforeEach(async () => {
      db = await resetDataSafetyAdapterStorage();
      retryDb = await openRetryQueueDatabase();
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanupDataSafetyAdapterStorage(db, retryDb, null);
    });

    it('preserves another owner item queued after the restore read transaction', async () => {
      const restoredItem = retryItem('restored-owner-a', 'restored-owner-a', 'user-1');
      const concurrentOwnerBItem = retryItem('concurrent-owner-b', 'concurrent-owner-b', 'user-2');
      const waitForConcurrentWrite = enqueueOnRetryQueueRead(retryDb, 2, concurrentOwnerBItem);

      const result = await restoreDataSafetyPackageToIndexedDb(db, buildPackage([restoredItem]));
      await waitForConcurrentWrite();

      expect(result.success).toBe(true);
      await expect(retryQueueItems(retryDb)).resolves.toEqual(expect.arrayContaining([
        restoredItem,
        concurrentOwnerBItem,
      ]));
    });

    it('preserves another owner item queued before failed restore rollback', async () => {
      const previousOwnerAItem = retryItem('previous-owner-a', 'previous-owner-a', 'user-1');
      const restoredOwnerAItem = retryItem('restored-owner-a', 'restored-owner-a', 'user-1');
      const concurrentOwnerBItem = retryItem('concurrent-owner-b', 'concurrent-owner-b', 'user-2');
      await putStoreValue(retryDb, RETRY_QUEUE_STORE_NAME, previousOwnerAItem);
      const waitForConcurrentWrite = failActionQueueRestoreAfterEnqueue(
        retryDb,
        concurrentOwnerBItem,
      );

      const result = await restoreDataSafetyPackageToIndexedDb(
        db,
        buildPackage([restoredOwnerAItem], true),
      );
      await waitForConcurrentWrite();
      const items = await retryQueueItems(retryDb);

      expect(result.success).toBe(false);
      expect(items).toEqual(expect.arrayContaining([previousOwnerAItem, concurrentOwnerBItem]));
      expect(items).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: restoredOwnerAItem.id }),
      ]));
    });

    it('does not overwrite a newer operation when failed restore rollback sees the same id', async () => {
      const previousItem = retryItem('stable-local-id', 'previous-operation', 'user-1');
      const restoredItem = retryItem('restored-owner-a', 'restored-owner-a', 'user-1');
      const newerItem = retryItem('stable-local-id', 'newer-operation', 'user-1');
      await putStoreValue(retryDb, RETRY_QUEUE_STORE_NAME, previousItem);
      const waitForConcurrentWrite = failActionQueueRestoreAfterEnqueue(retryDb, newerItem);

      const result = await restoreDataSafetyPackageToIndexedDb(
        db,
        buildPackage([restoredItem], true),
      );
      await waitForConcurrentWrite();
      const items = await retryQueueItems(retryDb);

      expect(result.success).toBe(false);
      expect(items.find(item => item.id === previousItem.id)?.operationId).toBe(newerItem.operationId);
      expect(items).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: restoredItem.id }),
      ]));
    });

    it('stops destructive RetryQueue rollback after restore marker ownership changes', async () => {
      const previousItem = retryItem('previous-owner-a', 'previous-owner-a', 'user-1');
      const restoredItem = retryItem('restored-owner-a', 'restored-owner-a', 'user-1');
      await putStoreValue(retryDb, RETRY_QUEUE_STORE_NAME, previousItem);
      failActionQueueRestore();
      replaceMarkerOnRetryQueueRollback();

      const result = await restoreDataSafetyPackageToIndexedDb(
        db,
        buildPackage([restoredItem], true),
      );
      const items = await retryQueueItems(retryDb);
      const currentMarker = JSON.parse(localStorage.getItem(RESTORE_MARKER_KEY) ?? '{}') as {
        runId?: string;
      };

      expect(result.success).toBe(false);
      expect(result.errors.join('\n')).toContain('restore marker ownership lost');
      expect(items).toEqual(expect.arrayContaining([restoredItem]));
      expect(items).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: previousItem.id }),
      ]));
      expect(currentMarker.runId).toBe('newer-restore-run');
    });
  });
}

function buildPackage(retryQueue: StoredRetryQueueItem[], failActionQueue = false) {
  const actionQueue = failActionQueue
    ? [{
        id: 'action-that-triggers-rollback',
        operationId: createDerivedSyncOperationId('action-that-triggers-rollback', 'test'),
        entityType: 'task',
        entityId: task.id,
        type: 'update',
        payload: { taskId: task.id, projectId: project.id, task },
        retryCount: 0,
        timestamp: 1781539200000,
      }]
    : [];
  return buildDataSafetyExportPackage({
    exportedAt: '2026-06-16T00:00:00.000Z',
    ownerUserId: 'user-1',
    app: { appVersion: '1.0.0', syncProtocolVersion: 1, deploymentEpoch: 0 },
    localData: {
      projects: [project],
      tasks: [task],
      connections: [connection],
      syncCursors: [cursor],
      meta,
    },
    localState: {
      retryQueue,
      actionQueue,
      deadLetters: [],
      conflicts: [],
      taskTombstones: {},
      connectionTombstones: [],
    },
    syncSnapshot: {
      syncState: { lastSyncTime: meta.lastSyncTime, pendingCount: retryQueue.length },
      projectCursors: [{ projectId: project.id, userId: 'user-1', cursor: cursor.cursor }],
      queueCounts: { retryQueue: retryQueue.length, actionQueue: actionQueue.length, deadLetters: 0 },
    },
    replayLog: [],
    lastWriteExplain: null,
  });
}

function retryItem(id: string, operationSeed: string, ownerUserId: string): StoredRetryQueueItem {
  return {
    id,
    operationId: createDerivedSyncOperationId(operationSeed, 'test'),
    type: 'task',
    operation: 'upsert',
    data: { ...task, id: `${id}-task`, projectId: `${ownerUserId}-project` },
    retryCount: 0,
    createdAt: 1781539200000,
    sourceUserId: ownerUserId,
    projectId: `${ownerUserId}-project`,
  };
}

function enqueueOnRetryQueueRead(
  retryDb: IDBDatabase,
  targetRead: number,
  item: StoredRetryQueueItem,
): () => Promise<void> {
  const originalGetAll = IDBObjectStore.prototype.getAll;
  let readCount = 0;
  let pendingWrite: Promise<void> | null = null;
  vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (
    this: IDBObjectStore,
    query?: IDBValidKey | IDBKeyRange | null,
    count?: number,
  ) {
    const request = callGetAll(originalGetAll, this, query, count);
    if (this.name === RETRY_QUEUE_STORE_NAME && ++readCount === targetRead) {
      pendingWrite = putStoreValue(retryDb, RETRY_QUEUE_STORE_NAME, item);
    }
    return request;
  });
  return async () => {
    await pendingWrite;
    expect(pendingWrite).not.toBeNull();
  };
}

function callGetAll(
  originalGetAll: IDBObjectStore['getAll'],
  store: IDBObjectStore,
  query?: IDBValidKey | IDBKeyRange | null,
  count?: number,
): IDBRequest<IDBValidKey[]> {
  if (count !== undefined) return originalGetAll.call(store, query, count);
  if (query !== undefined) return originalGetAll.call(store, query);
  return originalGetAll.call(store);
}

function failActionQueueRestoreAfterEnqueue(
  retryDb: IDBDatabase,
  item: StoredRetryQueueItem,
): () => Promise<void> {
  let pendingWrite: Promise<void> | null = null;
  failActionQueueRestore(() => {
    pendingWrite = putStoreValue(retryDb, RETRY_QUEUE_STORE_NAME, item);
  });
  return async () => {
    await pendingWrite;
    expect(pendingWrite).not.toBeNull();
  };
}

function failActionQueueRestore(beforeFailure?: () => void): void {
  const originalSetItem = localStorage.setItem.bind(localStorage);
  let failed = false;
  vi.spyOn(localStorage, 'setItem').mockImplementation(function (
    this: typeof localStorage,
    key: string,
    value: string,
  ) {
    if (!failed && key === 'nanoflow.action-queue.user-1') {
      failed = true;
      beforeFailure?.();
      throw new Error('simulated action queue restore failure');
    }
    originalSetItem(key, value);
  });
}

function replaceMarkerOnRetryQueueRollback(): void {
  const originalTransaction = IDBDatabase.prototype.transaction;
  const originalSetItem = localStorage.setItem.bind(localStorage);
  let retryQueueWriteTransactions = 0;
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
    this: IDBDatabase,
    storeNames: string | Iterable<string>,
    mode?: IDBTransactionMode,
    options?: IDBTransactionOptions,
  ) {
    if (this.name === RETRY_QUEUE_DB_NAME
      && includesStore(storeNames, RETRY_QUEUE_STORE_NAME)
      && mode === 'readwrite'
      && ++retryQueueWriteTransactions === 2) {
      const marker = JSON.parse(localStorage.getItem(RESTORE_MARKER_KEY) ?? '{}') as object;
      originalSetItem(RESTORE_MARKER_KEY, JSON.stringify({
        ...marker,
        runId: 'newer-restore-run',
        createdAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
    }
    return callTransaction(originalTransaction, this, storeNames, mode, options);
  });
}

function callTransaction(
  originalTransaction: IDBDatabase['transaction'],
  db: IDBDatabase,
  storeNames: string | Iterable<string>,
  mode?: IDBTransactionMode,
  options?: IDBTransactionOptions,
): IDBTransaction {
  if (options !== undefined) return originalTransaction.call(db, storeNames, mode, options);
  if (mode !== undefined) return originalTransaction.call(db, storeNames, mode);
  return originalTransaction.call(db, storeNames);
}

function includesStore(storeNames: string | Iterable<string>, expected: string): boolean {
  return typeof storeNames === 'string'
    ? storeNames === expected
    : Array.from(storeNames).includes(expected);
}

function retryQueueItems(retryDb: IDBDatabase): Promise<StoredRetryQueueItem[]> {
  return getAllStoreValues<StoredRetryQueueItem>(retryDb, RETRY_QUEUE_STORE_NAME);
}
