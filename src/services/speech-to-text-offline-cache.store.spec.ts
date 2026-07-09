import { describe, expect, it, vi } from 'vitest';
import { SpeechToTextOfflineCacheStore } from './speech-to-text-offline-cache.store';
import type { OfflineAudioCacheEntry } from '../models/focus';

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

const createDb = (store: Record<string, unknown>, txOverrides: Record<string, unknown> = {}) => {
  const tx = {
    objectStore: vi.fn(() => store),
    ...txOverrides,
  };

  return {
    transaction: vi.fn(() => tx),
  } as unknown as IDBDatabase;
};

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

const createStore = (db: IDBDatabase | null) => new SpeechToTextOfflineCacheStore({
  dbProvider: () => db,
  storeName: 'offline-audio',
  unknownOwnerUserId: '__legacy_unknown_owner__',
});

describe('SpeechToTextOfflineCacheStore', () => {
  it('saves owned audio entries with stable owner metadata', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    const addRequest = createRequest<IDBValidKey>('audio-id');
    const add = vi.fn(() => addRequest);
    const { db, tx } = createWriteDb({ add });
    const cache = createStore(db);

    const saving = cache.save(new Blob(['audio'], { type: 'audio/webm' }), 'user-a');
    addRequest.onsuccess?.();
    tx.oncomplete?.();

    await expect(saving).resolves.toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      state: 'owned',
    });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      id: '00000000-0000-4000-8000-000000000001',
      ownerUserId: 'user-a',
      mimeType: 'audio/webm',
    }));
  });

  it('quarantines audio entries when no owner is available', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000002');
    const addRequest = createRequest<IDBValidKey>('audio-id');
    const add = vi.fn(() => addRequest);
    const { db, tx } = createWriteDb({ add });
    const cache = createStore(db);

    const saving = cache.save(new Blob(['audio']), null);
    addRequest.onsuccess?.();
    tx.oncomplete?.();

    await expect(saving).resolves.toEqual({
      id: '00000000-0000-4000-8000-000000000002',
      state: 'quarantined',
    });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      id: '00000000-0000-4000-8000-000000000002',
      ownerUserId: '__legacy_unknown_owner__',
    }));
  });

  it('rejects offline audio saves when the IndexedDB transaction aborts after add succeeds', async () => {
    const addRequest = createRequest<IDBValidKey>('audio-id');
    const add = vi.fn(() => addRequest);
    const { db, tx } = createWriteDb({ add });
    const cache = createStore(db);

    const saving = cache.save(new Blob(['audio'], { type: 'audio/webm' }), 'user-a');
    addRequest.onsuccess?.();
    tx.error = new Error('transaction aborted');
    tx.onabort?.();

    await expect(saving).rejects.toThrow('transaction aborted');
  });

  it('reads cached audio entries', async () => {
    const entries: OfflineAudioCacheEntry[] = [
      { id: 'audio-1', ownerUserId: 'user-a', blob: new Blob(['1']), createdAt: '2026-06-08T00:00:00.000Z', mimeType: 'audio/webm' },
    ];
    const getAllRequest = createRequest<OfflineAudioCacheEntry[]>(entries);
    const getAll = vi.fn(() => getAllRequest);
    const db = createDb({ getAll });
    const cache = createStore(db);

    const reading = cache.readAll();
    getAllRequest.onsuccess?.();

    await expect(reading).resolves.toEqual(entries);
  });

  it('deletes cached audio entries by id', async () => {
    const deleteRequest = createRequest<undefined>(undefined);
    const deleteEntry = vi.fn(() => deleteRequest);
    const { db, tx } = createWriteDb({ delete: deleteEntry });
    const cache = createStore(db);

    const deleting = cache.delete('audio-1');
    deleteRequest.onsuccess?.();
    tx.oncomplete?.();

    await expect(deleting).resolves.toBeUndefined();
    expect(deleteEntry).toHaveBeenCalledWith('audio-1');
  });

  it('rejects offline audio deletes when the IndexedDB transaction aborts after delete succeeds', async () => {
    const deleteRequest = createRequest<undefined>(undefined);
    const deleteEntry = vi.fn(() => deleteRequest);
    const { db, tx } = createWriteDb({ delete: deleteEntry });
    const cache = createStore(db);

    const deleting = cache.delete('audio-1');
    deleteRequest.onsuccess?.();
    tx.error = new Error('delete transaction aborted');
    tx.onabort?.();

    await expect(deleting).rejects.toThrow('delete transaction aborted');
  });

  it('counts only entries owned by the active user', async () => {
    const entries: OfflineAudioCacheEntry[] = [
      { id: 'audio-1', ownerUserId: 'user-a', blob: new Blob(['1']), createdAt: '2026-06-08T00:00:00.000Z', mimeType: 'audio/webm' },
      { id: 'audio-2', ownerUserId: 'user-b', blob: new Blob(['2']), createdAt: '2026-06-08T00:00:00.000Z', mimeType: 'audio/webm' },
      { id: 'audio-3', ownerUserId: 'user-a', blob: new Blob(['3']), createdAt: '2026-06-08T00:00:00.000Z', mimeType: 'audio/webm' },
    ];
    const getAllRequest = createRequest<OfflineAudioCacheEntry[]>(entries);
    const getAll = vi.fn(() => getAllRequest);
    const db = createDb({ getAll });
    const cache = createStore(db);

    const counting = cache.countOwnedBy('user-a');
    getAllRequest.onsuccess?.();

    await expect(counting).resolves.toBe(2);
  });

  it('migrates legacy entries without owner metadata to the unknown-owner quarantine', async () => {
    const entries = [
      { id: 'legacy-audio', blob: new Blob(['1']), createdAt: '2026-06-08T00:00:00.000Z', mimeType: 'audio/webm' },
      { id: 'owned-audio', ownerUserId: 'user-a', blob: new Blob(['2']), createdAt: '2026-06-08T00:00:00.000Z', mimeType: 'audio/webm' },
    ] as OfflineAudioCacheEntry[];
    const getAllRequest = createRequest<OfflineAudioCacheEntry[]>(entries);
    const put = vi.fn();
    const tx: {
      objectStore: ReturnType<typeof vi.fn>;
      oncomplete: (() => void) | null;
      onerror: (() => void) | null;
      error: DOMException | Error | null;
    } = {
      objectStore: vi.fn(() => ({ getAll: vi.fn(() => getAllRequest), put })),
      oncomplete: null,
      onerror: null,
      error: null,
    };
    const db = {
      transaction: vi.fn(() => tx),
    } as unknown as IDBDatabase;
    const cache = createStore(db);

    const migrating = cache.migrateLegacyOwners();
    getAllRequest.onsuccess?.();
    tx.oncomplete?.();

    await expect(migrating).resolves.toBe(1);
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      id: 'legacy-audio',
      ownerUserId: '__legacy_unknown_owner__',
    }));
  });
});
