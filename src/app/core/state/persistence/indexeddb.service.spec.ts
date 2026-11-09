import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../../../../test-setup.mocks';
import { IndexedDBService } from './indexeddb.service';

function createDeferredTransactionStoreHarness() {
  const request = {
    error: null as DOMException | null,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
  };
  const store = {
    clear: vi.fn(() => request),
    delete: vi.fn(() => request),
    put: vi.fn(() => request),
  };
  const transaction = {
    error: null as DOMException | null,
    objectStore: vi.fn(() => store),
    onabort: null as (() => void) | null,
    oncomplete: null as (() => void) | null,
    onerror: null as (() => void) | null,
  };
  const db = {
    transaction: vi.fn(() => transaction),
  } as unknown as IDBDatabase;

  return { db, request, store, transaction };
}

function raceWithNextMacrotask(promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
  return Promise.race([
    promise.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<'pending'>((resolve) => {
      setTimeout(() => resolve('pending'), 0);
    }),
  ]);
}

describe('IndexedDBService base operations', () => {
  let service: IndexedDBService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        IndexedDBService,
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => ({
              debug: vi.fn(),
              error: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
            })),
          },
        },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
      ],
    });

    service = TestBed.inject(IndexedDBService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('waits for transaction completion before resolving deleteFromStore', async () => {
    const { db, request, transaction } = createDeferredTransactionStoreHarness();

    const deletePromise = service.deleteFromStore(db, 'tasks', 'task-1');
    request.onsuccess?.();

    await expect(raceWithNextMacrotask(deletePromise)).resolves.toBe('pending');

    transaction.oncomplete?.();

    await expect(deletePromise).resolves.toBeUndefined();
  });

  it('waits for transaction completion before resolving clearStore', async () => {
    const { db, request, transaction } = createDeferredTransactionStoreHarness();

    const clearPromise = service.clearStore(db, 'tasks');
    request.onsuccess?.();

    await expect(raceWithNextMacrotask(clearPromise)).resolves.toBe('pending');

    transaction.oncomplete?.();

    await expect(clearPromise).resolves.toBeUndefined();
  });

  it('rejects deleteFromStore when the transaction aborts after request success', async () => {
    const { db, request, transaction } = createDeferredTransactionStoreHarness();
    transaction.error = new DOMException('delete transaction aborted');

    const deletePromise = service.deleteFromStore(db, 'tasks', 'task-1');
    request.onsuccess?.();
    transaction.onabort?.();

    await expect(raceWithNextMacrotask(deletePromise)).resolves.toBe('rejected');
  });

  it('rejects clearStore when the transaction aborts after request success', async () => {
    const { db, request, transaction } = createDeferredTransactionStoreHarness();
    transaction.error = new DOMException('clear transaction aborted');

    const clearPromise = service.clearStore(db, 'tasks');
    request.onsuccess?.();
    transaction.onabort?.();

    await expect(raceWithNextMacrotask(clearPromise)).resolves.toBe('rejected');
  });

  it('rejects putToStore when the transaction aborts after request success', async () => {
    const { db, request, transaction } = createDeferredTransactionStoreHarness();
    transaction.error = new DOMException('put transaction aborted');

    const putPromise = service.putToStore(db, 'tasks', { id: 'task-1' });
    request.onsuccess?.();
    transaction.onabort?.();

    await expect(raceWithNextMacrotask(putPromise)).resolves.toBe('rejected');
  });

  it('rejects batchDeleteFromStore when the transaction aborts after request success', async () => {
    const { db, request, transaction } = createDeferredTransactionStoreHarness();
    transaction.error = new DOMException('batch delete transaction aborted');

    const batchDeletePromise = service.batchDeleteFromStore(db, 'tasks', ['task-1']);
    request.onsuccess?.();
    transaction.onabort?.();

    await expect(raceWithNextMacrotask(batchDeletePromise)).resolves.toBe('rejected');
  });
});
