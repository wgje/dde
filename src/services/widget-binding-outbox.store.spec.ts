import { describe, expect, it, vi } from 'vitest';
import {
  WidgetBindingOutboxStore,
  type WidgetBindingOutboxOperation,
} from './widget-binding-outbox.store';

type DeferredRequest<T> = {
  result: T;
  error: DOMException | Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
};

const createRequest = <T>(result: T): DeferredRequest<T> => ({
  result,
  error: null,
  onsuccess: null,
  onerror: null,
});

const createWriteDb = (store: Record<string, unknown>) => {
  const tx: {
    objectStore: ReturnType<typeof vi.fn>;
    oncomplete: (() => void) | null;
    onerror: (() => void) | null;
    onabort: (() => void) | null;
    error: DOMException | Error | null;
  } = {
    objectStore: vi.fn(() => store),
    oncomplete: null,
    onerror: null,
    onabort: null,
    error: null,
  };

  return {
    db: {
      transaction: vi.fn(() => tx),
    } as unknown as IDBDatabase,
    tx,
  };
};

const createStore = (db: IDBDatabase | null) => new WidgetBindingOutboxStore({
  dbProvider: () => Promise.resolve(db),
  storeName: 'widget-binding-outbox',
});

const flushAsyncDbOpen = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('WidgetBindingOutboxStore', () => {
  it('persists revoke-all operations only after the IndexedDB transaction commits', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000101');
    const existingRequest = createRequest<WidgetBindingOutboxOperation[]>([]);
    const addRequest = createRequest<IDBValidKey>('00000000-0000-4000-8000-000000000101');
    const getAll = vi.fn(() => existingRequest);
    const add = vi.fn(() => addRequest);
    const { db, tx } = createWriteDb({ getAll, add });
    const outbox = createStore(db);

    const saving = outbox.enqueueRevokeAll();
    await flushAsyncDbOpen();
    existingRequest.onsuccess?.();
    addRequest.onsuccess?.();

    await expect(Promise.race([saving, Promise.resolve('not-yet-committed')]))
      .resolves.toBe('not-yet-committed');

    tx.oncomplete?.();

    await expect(saving).resolves.toEqual(expect.objectContaining({
      operationId: '00000000-0000-4000-8000-000000000101',
      type: 'revoke-all',
      attemptCount: 0,
    }));
    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      operationId: '00000000-0000-4000-8000-000000000101',
      type: 'revoke-all',
    }));
  });

  it('coalesces redundant pending revoke-all operations instead of creating duplicates', async () => {
    const existing: WidgetBindingOutboxOperation = {
      operationId: 'existing-revoke-all',
      type: 'revoke-all',
      createdAt: '2026-06-29T00:00:00.000Z',
      updatedAt: '2026-06-29T00:00:00.000Z',
      attemptCount: 1,
    };
    const existingRequest = createRequest<WidgetBindingOutboxOperation[]>([existing]);
    const add = vi.fn();
    const { db, tx } = createWriteDb({ getAll: vi.fn(() => existingRequest), add });
    const outbox = createStore(db);

    const saving = outbox.enqueueRevokeAll();
    await flushAsyncDbOpen();
    existingRequest.onsuccess?.();
    tx.oncomplete?.();

    await expect(saving).resolves.toBe(existing);
    expect(add).not.toHaveBeenCalled();
  });

  it('keeps revoke-all operations when delete transaction aborts after delete succeeds', async () => {
    const deleteRequest = createRequest<undefined>(undefined);
    const deleteEntry = vi.fn(() => deleteRequest);
    const { db, tx } = createWriteDb({ delete: deleteEntry });
    const outbox = createStore(db);

    const deleting = outbox.delete('queued-revoke-all');
    await flushAsyncDbOpen();
    deleteRequest.onsuccess?.();
    tx.error = new Error('delete transaction aborted');
    tx.onabort?.();

    await expect(deleting).rejects.toThrow('delete transaction aborted');
  });
});
