import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAllFromStore,
  getByKey,
  openExistingDb,
  readOwnerScopedLocalStorage,
  resolveRetryQueueItemOwner,
  safeGetLocalStorage,
  safeParseJson,
} from './disaster-backup-browser-storage.helpers';

interface FakeOpenRequest {
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onblocked: ((event: Event) => void) | null;
  onsuccess: ((event: Event) => void) | null;
  result: IDBDatabase | null;
  transaction: IDBTransaction | null;
  error: DOMException | null;
}

function createFakeOpenRequest(): FakeOpenRequest {
  return {
    onupgradeneeded: null,
    onerror: null,
    onblocked: null,
    onsuccess: null,
    result: null,
    transaction: null,
    error: null,
  };
}

function createDatabase(): IDBDatabase {
  return { close: vi.fn() } as unknown as IDBDatabase;
}

function installOpen(request: FakeOpenRequest): void {
  const open = vi.fn(() => request as unknown as IDBOpenDBRequest);
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: { open } as unknown as IDBFactory,
  });
}

function emitUpgrade(request: FakeOpenRequest, transaction: IDBTransaction): void {
  request.transaction = transaction;
  request.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent);
}

function emitBlocked(request: FakeOpenRequest): void {
  request.onblocked?.(new Event('blocked'));
}

function emitError(request: FakeOpenRequest): void {
  request.onerror?.(new Event('error'));
}

function emitSuccess(request: FakeOpenRequest, database: IDBDatabase): void {
  request.result = database;
  request.onsuccess?.(new Event('success'));
}

describe('disaster-backup-browser-storage helpers', () => {
  let originalIndexedDb: IDBFactory | undefined;

  beforeEach(() => {
    originalIndexedDb = globalThis.indexedDB;
  });

  afterEach(() => {
    if (originalIndexedDb === undefined) {
      Reflect.deleteProperty(globalThis, 'indexedDB');
    } else {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        writable: true,
        value: originalIndexedDb,
      });
    }
    vi.restoreAllMocks();
  });

  it('returns a normal opened database without closing it', async () => {
    const request = createFakeOpenRequest();
    installOpen(request);
    const database = createDatabase();

    const promise = openExistingDb('normal-db');
    emitSuccess(request, database);

    await expect(promise).resolves.toBe(database);
    expect(database.close).not.toHaveBeenCalled();
  });

  it('closes a late success result after blocked already resolved null', async () => {
    const request = createFakeOpenRequest();
    installOpen(request);
    const database = createDatabase();

    const promise = openExistingDb('blocked-db');
    emitBlocked(request);
    await expect(promise).resolves.toBeNull();

    emitSuccess(request, database);

    expect(database.close).toHaveBeenCalledTimes(1);
  });

  it('closes a late success result after error already resolved null', async () => {
    const request = createFakeOpenRequest();
    installOpen(request);
    const database = createDatabase();

    const promise = openExistingDb('error-db');
    emitError(request);
    await expect(promise).resolves.toBeNull();

    emitSuccess(request, database);

    expect(database.close).toHaveBeenCalledTimes(1);
  });

  it('aborts an upgrade and closes the database result when created during open', async () => {
    const request = createFakeOpenRequest();
    installOpen(request);
    const database = createDatabase();
    const transaction = { abort: vi.fn() } as unknown as IDBTransaction;

    const promise = openExistingDb('created-db');
    emitUpgrade(request, transaction);
    emitSuccess(request, database);

    await expect(promise).resolves.toBeNull();
    expect(transaction.abort).toHaveBeenCalledTimes(1);
    expect(database.close).toHaveBeenCalledTimes(1);
  });

  it('preserves the non-open helper exports', () => {
    expect(typeof getAllFromStore).toBe('function');
    expect(typeof getByKey).toBe('function');
    expect(typeof safeGetLocalStorage).toBe('function');
    expect(typeof safeParseJson).toBe('function');
    expect(typeof readOwnerScopedLocalStorage).toBe('function');
    expect(typeof resolveRetryQueueItemOwner).toBe('function');
  });
});
