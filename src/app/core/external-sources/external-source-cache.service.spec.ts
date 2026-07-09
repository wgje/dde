import { Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSourceLink } from './external-source.model';

vi.mock('idb-keyval', () => ({
  del: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue(undefined),
  keys: vi.fn().mockResolvedValue([]),
  set: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
}));

describe('ExternalSourceCacheService fallback storage', () => {
  let serviceClass: typeof import('./external-source-cache.service').ExternalSourceCacheService;
  let authServiceClass: typeof import('../../../services/auth.service').AuthService;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockUpdate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();

    const idbKeyval = await import('idb-keyval');
    const authModule = await import('../../../services/auth.service');
    const module = await import('./external-source-cache.service');
    authServiceClass = authModule.AuthService;
    serviceClass = module.ExternalSourceCacheService;
    mockGet = vi.mocked(idbKeyval.get);
    mockUpdate = vi.mocked(idbKeyval.update);
    mockGet.mockReset();
    mockUpdate.mockReset();
    mockGet.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
  }, 5_000);

  it('falls back to localStorage when IndexedDB pending enqueue fails and restores pending links', async () => {
    const service = createService();
    mockUpdate.mockRejectedValueOnce(new Error('indexeddb unavailable'));

    const pendingEntry = await service.upsertPendingLink(createLink({
      id: 'link-fallback',
      updatedAt: '2026-06-16T00:00:00.000Z',
    }));

    expect(pendingEntry).toEqual(expect.objectContaining({
      link: expect.objectContaining({ id: 'link-fallback' }),
      retryCount: 0,
      syncState: 'pending_sync',
    }));
    expect(pendingEntry.operationId).toMatch(/[0-9a-f-]{36}/);

    const restoredService = createService();
    mockGet.mockRejectedValueOnce(new Error('indexeddb still unavailable'));

    const pending = await restoredService.loadPendingLinks();

    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(expect.objectContaining({
      link: expect.objectContaining({ id: 'link-fallback' }),
      retryCount: 0,
      syncState: 'pending_sync',
    }));
    expect(pending[0].operationId).toMatch(/[0-9a-f-]{36}/);
  });

  it('prefers newer localStorage pending mirrors over stale IndexedDB pending links', async () => {
    const service = createService();
    const staleLink = createLink({
      id: 'link-stale',
      targetId: '20260616000000-stale00',
      updatedAt: '2026-06-16T00:00:00.000Z',
    });
    const newerLink = createLink({
      id: 'link-stale',
      targetId: '20260616000100-newer00',
      updatedAt: '2026-06-16T00:01:00.000Z',
    });
    mockGet.mockResolvedValueOnce([{
      link: staleLink,
      operationId: '00000000-0000-4000-8000-000000000001',
      localCommittedAt: 1,
      syncState: 'pending_sync',
      retryCount: 0,
    }]);
    mockUpdate.mockRejectedValueOnce(new Error('indexeddb unavailable'));
    await service.upsertPendingLink(newerLink);

    const pending = await service.loadPendingLinks();

    expect(pending).toHaveLength(1);
    expect(pending[0].link.targetId).toBe('20260616000100-newer00');
    expect(pending[0].operationId).toMatch(/[0-9a-f-]{36}/);
  });

  it('repairs legacy pending entries with non-UUID operation ids before replay', async () => {
    const service = createService();
    mockGet.mockResolvedValueOnce([{
      link: createLink({ id: 'legacy-link' }),
      operationId: 'legacy-operation-id',
      localCommittedAt: 1,
      syncState: 'pending_sync',
      retryCount: 0,
    }]);

    const pending = await service.loadPendingLinks();

    expect(pending).toHaveLength(1);
    expect(pending[0].operationId).not.toBe('legacy-operation-id');
    expect(pending[0].operationId).toMatch(/[0-9a-f-]{36}/);
  });

  it('mirrors the full IndexedDB pending queue after a successful pending upsert', async () => {
    const service = createService();
    const indexedOnlyLink = createLink({
      id: 'link-indexed-only',
      targetId: '20260616000000-indexed',
      updatedAt: '2026-06-16T00:00:00.000Z',
    });
    mockUpdate.mockImplementationOnce(async (_key, updater) => {
      updater([{
        link: indexedOnlyLink,
        operationId: '00000000-0000-4000-8000-000000000010',
        localCommittedAt: 1,
        syncState: 'pending_sync',
        retryCount: 0,
      }]);
    });

    await service.upsertPendingLink(createLink({
      id: 'link-new',
      targetId: '20260616000200-newlink',
      updatedAt: '2026-06-16T00:02:00.000Z',
    }));

    mockGet.mockRejectedValueOnce(new Error('indexeddb read failed'));
    const pending = await service.loadPendingLinks();

    expect(pending.map(entry => entry.link.id).sort()).toEqual([
      'link-indexed-only',
      'link-new',
    ]);
  });

  function createService() {
    return Injector.create({
      providers: [
        { provide: authServiceClass, useValue: { currentUserId: () => 'user-1' } },
        { provide: serviceClass, useClass: serviceClass },
      ],
    }).get(serviceClass);
  }
});

function createLink(overrides: Partial<ExternalSourceLink> = {}): ExternalSourceLink {
  const updatedAt = overrides.updatedAt ?? '2026-06-16T00:00:00.000Z';
  return {
    id: overrides.id ?? 'link-1',
    taskId: overrides.taskId ?? 'task-1',
    sourceType: 'siyuan-block',
    targetId: overrides.targetId ?? '20260616000000-abcdef0',
    uri: overrides.uri ?? 'siyuan://blocks/20260616000000-abcdef0?focus=1',
    sortOrder: overrides.sortOrder ?? 0,
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt,
  };
}
