import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RetryQueueItem, RetryQueueService } from './retry-queue.service';
import {
  createRetryQueueServiceSpecHarness,
  type RetryQueueServiceSpecHarness,
} from './retry-queue-service.spec-fixture';
import { createTask } from './retry-queue-test-data.spec-helpers';

type FallbackSnapshot = object;
type RecoveryPlan = {
  snapshot: FallbackSnapshot;
  mergedItems: RetryQueueItem[];
  idbDigest: string;
};
type StorageInternals = {
  loadFromStorage(): Promise<void>;
  loadFromIdb(db: IDBDatabase): Promise<RetryQueueItem[] | null>;
  loadFromLocalStorage(): RetryQueueItem[];
  saveToLocalStorage(options?: { unresolvedIdbFallback?: boolean }): boolean;
  saveToIdb(db: IDBDatabase, capture?: { persistedDigest?: string }): Promise<boolean>;
  readIdbFallbackEnvelopeSnapshot(): FallbackSnapshot | null;
  computeRetryQueueItemDigest(items: unknown[]): string;
  settleSavedIdbFallback(
    db: IDBDatabase,
    snapshot: FallbackSnapshot | null,
    persistedDigest: string | undefined,
  ): Promise<void>;
  settleRecoveredIdbFallback(db: IDBDatabase, plan: RecoveryPlan): Promise<void>;
  markOwnerStorageLoadSucceeded(token: unknown): void;
  syncPendingCountToState(): void;
};

const harnesses: RetryQueueServiceSpecHarness[] = [];

describe('RetryQueue IndexedDB read settlement', () => {
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await harness.teardown();
    }
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it.each(['abort', 'error'] as const)(
    'waits for transaction completion and treats transaction %s as unavailable',
    async outcome => {
      const harness = ownHarness();
      const storage = getStorageInternals(harness.service);
      const read = createControlledReadDatabase();
      const dirty = createStoredItem('dirty-read', 'not-a-uuid');
      const result = storage.loadFromIdb(read.db);
      read.succeed([dirty]);
      expect(await promiseSettled(result)).toBe(false);
      expect(read.readwriteTransactions()).toBe(0);
      expect(read.deleteKey).not.toHaveBeenCalled();
      read[outcome]();
      await expect(result).resolves.toBeNull();
      read.complete();
      read.succeed([dirty]);
      expect(read.readwriteTransactions()).toBe(0);
      expect(read.deleteKey).not.toHaveBeenCalled();
    },
  );

  it('settles a successful readonly transaction once and ignores late events', async () => {
    const harness = ownHarness();
    const storage = getStorageInternals(harness.service);
    const read = createControlledReadDatabase();
    const item = createStoredItem('complete-read', 'invalid-on-complete');
    const result = storage.loadFromIdb(read.db);
    read.succeed([item]);
    expect(await promiseSettled(result)).toBe(false);
    read.complete();
    await expect(result).resolves.toEqual([]);
    expect(read.deleteKey).toHaveBeenCalledWith(item.id);
    expect(read.readwriteTransactions()).toBe(1);
    read.abort();
    read.error();
    read.failRequest();
  });

  it('falls back only after abort and preserves the fallback envelope byte-exact', async () => {
    const fallbackItem = createStoredItem('abort-fallback');
    const envelope = JSON.stringify({ version: 1, items: [fallbackItem], savedAt: 73 });
    localStorage.setItem('nanoflow.retry-queue', envelope);
    const read = createControlledReadDatabase();
    const harness = await createManualLoadHarness(read.db, false);
    const storage = getStorageInternals(harness.service);
    const markSucceeded = vi.spyOn(storage, 'markOwnerStorageLoadSucceeded');
    const syncPending = vi.spyOn(storage, 'syncPendingCountToState');
    const load = storage.loadFromStorage();
    await flushMicrotasks();
    read.succeed([]);
    expect(await promiseSettled(load)).toBe(false);
    expect(harness.service.getItems()).toEqual([]);
    expect(markSucceeded).not.toHaveBeenCalled();
    expect(syncPending).not.toHaveBeenCalled();
    read.abort();
    await load;
    expect(harness.service.getItems()).toEqual([fallbackItem]);
    expect(markSucceeded).toHaveBeenCalledOnce();
    expect(syncPending).toHaveBeenCalledOnce();
    expect(localStorage.getItem('nanoflow.retry-queue')).toBe(envelope);
  });

  it('publishes authoritative empty only on complete and skips localStorage fallback', async () => {
    const fallbackItem = createStoredItem('complete-empty-fallback');
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [fallbackItem],
      savedAt: 81,
    }));
    const read = createControlledReadDatabase();
    const harness = await createManualLoadHarness(read.db, false);
    const storage = getStorageInternals(harness.service);
    const fallback = vi.spyOn(storage, 'loadFromLocalStorage');
    const markSucceeded = vi.spyOn(storage, 'markOwnerStorageLoadSucceeded');
    const load = storage.loadFromStorage();
    await flushMicrotasks();
    read.succeed([]);
    expect(markSucceeded).not.toHaveBeenCalled();
    read.complete();
    await load;
    expect(harness.service.getItems()).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
    expect(markSucceeded).toHaveBeenCalledOnce();
  });

  it('publishes nothing when the owner drifts between request success and complete', async () => {
    const read = createControlledReadDatabase();
    const harness = await createManualLoadHarness(read.db);
    const storage = getStorageInternals(harness.service);
    const markSucceeded = vi.spyOn(storage, 'markOwnerStorageLoadSucceeded');
    const syncPending = vi.spyOn(storage, 'syncPendingCountToState');
    const load = storage.loadFromStorage();
    await flushMicrotasks();
    read.succeed([createStoredItem('owner-a')]);
    harness.authServiceMock.currentUserId.mockReturnValue('owner-b');
    read.complete();
    await load;
    expect(harness.service.getItems()).toEqual([]);
    expect(markSucceeded).not.toHaveBeenCalled();
    expect(syncPending).not.toHaveBeenCalled();
  });

  it.each(['current write', 'recovery promotion'] as const)(
    'preserves fallback proof when %s readback aborts after request success',
    async phase => {
      const harness = ownHarness();
      const proof = prepareFallbackProof(harness.service, `${phase}-abort`);
      const read = createControlledReadDatabase();
      const settlement = phase === 'current write'
        ? proof.storage.settleSavedIdbFallback(read.db, proof.snapshot, proof.digest)
        : startRecoverySettlement(proof, read.db);
      await flushMicrotasks();
      read.succeed(proof.items);
      await flushMicrotasks();
      expect(await promiseSettled(settlement)).toBe(false);
      expect(localStorage.getItem('nanoflow.retry-queue')).toBe(proof.raw);
      read.abort();
      await settlement;
      expect(localStorage.getItem('nanoflow.retry-queue')).toBe(proof.raw);
    },
  );

  it('clears only a matching proof after complete and preserves a concurrent replacement', async () => {
    const harness = ownHarness();
    const matching = prepareFallbackProof(harness.service, 'matching-proof');
    const matchingRead = createControlledReadDatabase();
    const matchingSettlement = matching.storage.settleSavedIdbFallback(
      matchingRead.db, matching.snapshot, matching.digest,
    );
    matchingRead.succeed(matching.items);
    await flushMicrotasks();
    expect(localStorage.getItem('nanoflow.retry-queue')).toBe(matching.raw);
    matchingRead.complete();
    await matchingSettlement;
    expect(readEnvelope()).not.toHaveProperty('idbFallbackProof');

    expect(matching.storage.saveToLocalStorage({ unresolvedIdbFallback: true })).toBe(true);
    const oldSnapshot = matching.storage.readIdbFallbackEnvelopeSnapshot();
    if (!oldSnapshot) throw new Error('Expected old fallback proof snapshot');
    const oldItems = harness.service.getItems();
    const oldDigest = matching.storage.computeRetryQueueItemDigest(oldItems);
    const replacementRead = createControlledReadDatabase();
    const replacementSettlement = matching.storage.settleSavedIdbFallback(
      replacementRead.db, oldSnapshot, oldDigest,
    );
    replacementRead.succeed(oldItems);
    harness.service.add('task', 'upsert', createTask('replacement-proof'), 'p-replacement');
    expect(matching.storage.saveToLocalStorage({ unresolvedIdbFallback: true })).toBe(true);
    const replacementRaw = localStorage.getItem('nanoflow.retry-queue');
    replacementRead.complete();
    await replacementSettlement;
    expect(localStorage.getItem('nanoflow.retry-queue')).toBe(replacementRaw);
    expect(readEnvelope()).toHaveProperty('idbFallbackProof');
  });
});

function ownHarness(options: Parameters<typeof createRetryQueueServiceSpecHarness>[0] = {}) {
  const harness = createRetryQueueServiceSpecHarness(options);
  harnesses.push(harness);
  return harness;
}

async function createManualLoadHarness(
  db: IDBDatabase,
  clearLocalStorage = true,
): Promise<RetryQueueServiceSpecHarness> {
  const harness = ownHarness({ clearLocalStorage });
  await flushMicrotasks();
  harness.loadFromStorageSpy.mockRestore();
  harness.initDbSpy.mockResolvedValue(db);
  return harness;
}

function getStorageInternals(service: RetryQueueService): StorageInternals {
  return service as unknown as StorageInternals;
}

function createStoredItem(label: string, dataId: string = crypto.randomUUID()): RetryQueueItem {
  return {
    id: crypto.randomUUID(),
    type: 'task',
    operation: 'upsert',
    data: { ...createTask(label), id: dataId },
    projectId: `p-${label}`,
    retryCount: 0,
    createdAt: Date.now(),
    sourceUserId: 'test-user',
    operationId: crypto.randomUUID(),
  };
}

function createControlledReadDatabase() {
  const request = {
    result: [] as RetryQueueItem[],
    onsuccess: null as IDBRequest<RetryQueueItem[]>['onsuccess'],
    onerror: null as IDBRequest<RetryQueueItem[]>['onerror'],
  };
  const readStore = { getAll: () => request } as unknown as IDBObjectStore;
  const deleteKey = vi.fn();
  const deleteStore = { delete: deleteKey } as unknown as IDBObjectStore;
  const readTransaction = {
    oncomplete: null as IDBTransaction['oncomplete'],
    onabort: null as IDBTransaction['onabort'],
    onerror: null as IDBTransaction['onerror'],
    objectStore: () => readStore,
  };
  const deleteTransaction = { objectStore: () => deleteStore } as unknown as IDBTransaction;
  const transaction = vi.fn((_store: string, mode?: IDBTransactionMode) => (
    mode === 'readwrite' ? deleteTransaction : readTransaction as unknown as IDBTransaction
  ));
  const db = { transaction } as unknown as IDBDatabase;
  const fireRequest = (handler: IDBRequest<RetryQueueItem[]>['onsuccess'], type: string) =>
    handler?.call(request as unknown as IDBRequest<RetryQueueItem[]>, new Event(type));
  const fireTransaction = (handler: IDBTransaction['oncomplete'], type: string) =>
    handler?.call(readTransaction as unknown as IDBTransaction, new Event(type));
  return {
    db,
    deleteKey,
    succeed: (items: RetryQueueItem[]) => {
      request.result = items;
      fireRequest(request.onsuccess, 'success');
    },
    failRequest: () => fireRequest(request.onerror, 'error'),
    complete: () => fireTransaction(readTransaction.oncomplete, 'complete'),
    abort: () => fireTransaction(readTransaction.onabort, 'abort'),
    error: () => fireTransaction(readTransaction.onerror, 'error'),
    readwriteTransactions: () => transaction.mock.calls.filter(([, mode]) => mode === 'readwrite').length,
  };
}

function prepareFallbackProof(service: RetryQueueService, label: string) {
  service.add('task', 'upsert', createTask(label), `p-${label}`);
  const storage = getStorageInternals(service);
  expect(storage.saveToLocalStorage({ unresolvedIdbFallback: true })).toBe(true);
  const snapshot = storage.readIdbFallbackEnvelopeSnapshot();
  if (!snapshot) throw new Error('Expected fallback proof snapshot');
  const items = service.getItems();
  const digest = storage.computeRetryQueueItemDigest(items);
  const raw = localStorage.getItem('nanoflow.retry-queue');
  if (!raw) throw new Error('Expected fallback envelope');
  return { storage, snapshot, items, digest, raw };
}

async function startRecoverySettlement(
  proof: ReturnType<typeof prepareFallbackProof>,
  db: IDBDatabase,
): Promise<void> {
  vi.spyOn(proof.storage, 'saveToIdb').mockImplementation(async (_db, capture) => {
    if (capture) capture.persistedDigest = proof.digest;
    return true;
  });
  await proof.storage.settleRecoveredIdbFallback(db, {
    snapshot: proof.snapshot,
    mergedItems: proof.items,
    idbDigest: 'stale-idb-digest',
  });
}

async function promiseSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await flushMicrotasks();
  return settled;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function readEnvelope(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as Record<string, unknown>;
}
