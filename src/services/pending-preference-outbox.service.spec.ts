import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PendingPreferenceOutboxService as PendingPreferenceOutboxServiceType,
} from './pending-preference-outbox.service';

const idbKeyvalMocks = vi.hoisted(() => ({
  clear: vi.fn(),
  createStore: vi.fn(() => ({})),
  del: vi.fn(),
  get: vi.fn(),
  records: new Map<unknown, unknown>(),
  update: vi.fn(),
}));

vi.mock('idb-keyval', () => {
  return {
    clear: idbKeyvalMocks.clear,
    createStore: idbKeyvalMocks.createStore,
    del: idbKeyvalMocks.del,
    get: idbKeyvalMocks.get,
    update: idbKeyvalMocks.update,
  };
});

describe('PendingPreferenceOutboxService', () => {
  let service: PendingPreferenceOutboxServiceType;
  let serviceClass:
    typeof import('./pending-preference-outbox.service').PendingPreferenceOutboxService;

  beforeEach(async () => {
    vi.resetModules();
    resetIdbKeyvalMocks();
    const module = await import('./pending-preference-outbox.service');
    serviceClass = module.PendingPreferenceOutboxService;
    service = new serviceClass();
    await service.clearPendingPreferencesForTests();
    localStorage.clear();
  });

  it('persists pending preference records and removes them after durable enqueue recovery', async () => {
    await service.savePendingPreference({
      userId: 'user-1',
      preferences: {
        theme: 'ocean',
        colorMode: 'dark',
      },
      operationId: '00000000-0000-4000-8000-000000000001',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });

    await expect(service.readPendingPreference('user-1')).resolves.toEqual({
      userId: 'user-1',
      preferences: {
        theme: 'ocean',
        colorMode: 'dark',
      },
      operationId: '00000000-0000-4000-8000-000000000001',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });

    await service.removePendingPreference('user-1');

    await expect(service.readPendingPreference('user-1')).resolves.toBeNull();
  });

  it('recovers from the localStorage mirror when IndexedDB is unavailable', async () => {
    localStorage.setItem('nanoflow.pendingPreferenceOutbox.user-1', JSON.stringify({
      userId: 'user-1',
      preferences: {
        theme: 'forest',
        colorMode: 'system',
      },
      operationId: '00000000-0000-4000-8000-000000000002',
      updatedAt: '2026-06-15T00:01:00.000Z',
    }));

    await expect(service.readPendingPreference('user-1')).resolves.toEqual({
      userId: 'user-1',
      preferences: {
        theme: 'forest',
        colorMode: 'system',
      },
      operationId: '00000000-0000-4000-8000-000000000002',
      updatedAt: '2026-06-15T00:01:00.000Z',
    });
  });

  it('prefers a newer localStorage mirror over a stale IndexedDB pending preference', async () => {
    await service.savePendingPreference({
      userId: 'user-1',
      preferences: {
        theme: 'ocean',
        colorMode: 'dark',
      },
      operationId: '00000000-0000-4000-8000-000000000001',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    localStorage.setItem('nanoflow.pendingPreferenceOutbox.user-1', JSON.stringify({
      userId: 'user-1',
      preferences: {
        theme: 'forest',
        colorMode: 'system',
        lastBackupProofAt: '2026-06-15T01:00:00.000Z',
      },
      operationId: '00000000-0000-4000-8000-000000000002',
      updatedAt: '2026-06-15T00:01:00.000Z',
    }));

    await expect(service.readPendingPreference('user-1')).resolves.toEqual({
      userId: 'user-1',
      preferences: {
        theme: 'forest',
        colorMode: 'system',
        lastBackupProofAt: '2026-06-15T01:00:00.000Z',
      },
      operationId: '00000000-0000-4000-8000-000000000002',
      updatedAt: '2026-06-15T00:01:00.000Z',
    });
  });

  it('keeps a newer localStorage mirror when IndexedDB delete fails', async () => {
    await service.savePendingPreference({
      userId: 'user-1',
      preferences: {
        theme: 'ocean',
        colorMode: 'dark',
      },
      operationId: '00000000-0000-4000-8000-000000000001',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });

    localStorage.setItem('nanoflow.pendingPreferenceOutbox.user-1', JSON.stringify({
      userId: 'user-1',
      preferences: {
        theme: 'forest',
        colorMode: 'system',
        lastBackupProofAt: '2026-06-15T01:00:00.000Z',
      },
      operationId: '00000000-0000-4000-8000-000000000002',
      updatedAt: '2026-06-15T00:01:00.000Z',
    }));

    idbKeyvalMocks.del.mockRejectedValueOnce(new Error('idb delete unavailable'));

    await expect(service.removePendingPreference('user-1')).rejects.toThrow('idb delete unavailable');
    await expect(service.readPendingPreference('user-1')).resolves.toEqual({
      userId: 'user-1',
      preferences: {
        theme: 'forest',
        colorMode: 'system',
        lastBackupProofAt: '2026-06-15T01:00:00.000Z',
      },
      operationId: '00000000-0000-4000-8000-000000000002',
      updatedAt: '2026-06-15T00:01:00.000Z',
    });
  });

  it('retries transient localStorage mirror cleanup failures after durable delete succeeds', async () => {
    await service.savePendingPreference({
      userId: 'user-1',
      preferences: {
        theme: 'ocean',
        colorMode: 'dark',
      },
      operationId: '00000000-0000-4000-8000-000000000001',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const originalRemoveItem = localStorage.removeItem.bind(localStorage);
    const removeItemSpy = vi.spyOn(localStorage, 'removeItem')
      .mockImplementationOnce(() => {
        throw new Error('mirror remove unavailable');
      })
      .mockImplementation((key: string) => {
        return originalRemoveItem(key);
      });

    try {
      await expect(service.removePendingPreference('user-1')).resolves.toBeUndefined();

      expect(idbKeyvalMocks.del).toHaveBeenCalledWith('user-1', expect.anything());
      expect(removeItemSpy).toHaveBeenCalledTimes(2);
      await expect(service.readPendingPreference('user-1')).resolves.toBeNull();
    } finally {
      removeItemSpy.mockRestore();
    }
  });

  it('merges consecutive preference snapshots for the same user', async () => {
    await service.savePendingPreference({
      userId: 'user-1',
      preferences: {
        theme: 'ocean',
        colorMode: 'dark',
      },
      operationId: '00000000-0000-4000-8000-000000000001',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });

    await service.savePendingPreference({
      userId: 'user-1',
      preferences: {
        lastBackupProofAt: '2026-06-15T01:00:00.000Z',
      },
      operationId: '00000000-0000-4000-8000-000000000002',
      updatedAt: '2026-06-15T00:01:00.000Z',
    });

    await expect(service.readPendingPreference('user-1')).resolves.toEqual({
      userId: 'user-1',
      preferences: {
        theme: 'ocean',
        colorMode: 'dark',
        lastBackupProofAt: '2026-06-15T01:00:00.000Z',
      },
      operationId: '00000000-0000-4000-8000-000000000002',
      updatedAt: '2026-06-15T00:01:00.000Z',
    });
  });
});

function resetIdbKeyvalMocks(): void {
  idbKeyvalMocks.records.clear();
  idbKeyvalMocks.clear.mockClear();
  idbKeyvalMocks.createStore.mockClear();
  idbKeyvalMocks.del.mockClear();
  idbKeyvalMocks.get.mockClear();
  idbKeyvalMocks.update.mockClear();
  idbKeyvalMocks.clear.mockImplementation(async () => {
    idbKeyvalMocks.records.clear();
  });
  idbKeyvalMocks.del.mockImplementation(async (key: unknown) => {
    idbKeyvalMocks.records.delete(key);
  });
  idbKeyvalMocks.get.mockImplementation(async (key: unknown) =>
    idbKeyvalMocks.records.get(key));
  idbKeyvalMocks.update.mockImplementation(
    async (key: unknown, updater: (value: unknown) => unknown) => {
      const nextValue = updater(idbKeyvalMocks.records.get(key));
      if (typeof nextValue === 'undefined') {
        idbKeyvalMocks.records.delete(key);
        return;
      }
      idbKeyvalMocks.records.set(key, nextValue);
    },
  );
}
