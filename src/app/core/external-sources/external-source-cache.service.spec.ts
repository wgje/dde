import { Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ExternalSourceLink,
  PendingExternalSourceLink,
} from './external-source.model';

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
  let ownerUserId: string;
  let mockDel: ReturnType<typeof vi.fn>;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockKeys: ReturnType<typeof vi.fn>;
  let mockSet: ReturnType<typeof vi.fn>;
  let mockUpdate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();

    const idbKeyval = await import('idb-keyval');
    const authModule = await import('../../../services/auth.service');
    const module = await import('./external-source-cache.service');
    authServiceClass = authModule.AuthService;
    serviceClass = module.ExternalSourceCacheService;
    ownerUserId = 'owner-a';
    mockDel = vi.mocked(idbKeyval.del);
    mockGet = vi.mocked(idbKeyval.get);
    mockKeys = vi.mocked(idbKeyval.keys);
    mockSet = vi.mocked(idbKeyval.set);
    mockUpdate = vi.mocked(idbKeyval.update);
    mockDel.mockReset();
    mockGet.mockReset();
    mockKeys.mockReset();
    mockSet.mockReset();
    mockUpdate.mockReset();
    mockDel.mockResolvedValue(undefined);
    mockGet.mockResolvedValue(undefined);
    mockKeys.mockResolvedValue([]);
    mockSet.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
  }, 5_000);

  it('falls back to localStorage when IndexedDB pending enqueue fails and restores pending links', async () => {
    const service = createService();
    mockUpdate.mockRejectedValueOnce(new Error('indexeddb unavailable'));

    const pendingEntry = await service.upsertPendingLink(createLink({
      id: 'link-fallback',
      updatedAt: '2026-06-16T00:00:00.000Z',
    }));

    expect(pendingEntry).toMatchObject({ link: { id: 'link-fallback' }, retryCount: 0, syncState: 'pending_sync' });
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
    mockUpdate.mockRejectedValueOnce(new Error('settlement unavailable'));
    await expect(restoredService.removePendingLink(pending[0].link.id, pending[0].operationId)).rejects.toThrow();
    mockGet.mockRejectedValueOnce(new Error('indexeddb still unavailable'));
    await expect(restoredService.loadPendingLinks()).resolves.toEqual(pending);
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

  it('replaces and reads back pending links for the explicit owner without remapping identity', async () => {
    const service = createService();
    const restored: PendingExternalSourceLink = {
      link: createLink({ id: 'restored-link' }),
      operationId: '00000000-0000-4000-8000-000000000020',
      localCommittedAt: 20,
      syncState: 'pending_sync',
      retryCount: 2,
    };
    let indexedValue: PendingExternalSourceLink[] = [];
    mockSet.mockImplementationOnce(async (_key, value) => {
      indexedValue = value as PendingExternalSourceLink[];
    });

    await service.replacePendingLinksForOwner([restored], 'owner-a');
    ownerUserId = 'owner-b';
    mockGet.mockImplementationOnce(async () => indexedValue);

    await expect(service.loadPendingLinks('owner-a')).resolves.toEqual([restored]);
    expect(mockSet).toHaveBeenCalledWith('external-source-pending:owner-a', [restored]);
    expect(localStorage.getItem('nanoflow.externalSource.pending.owner-a')).not.toBeNull();
    expect(localStorage.getItem('nanoflow.externalSource.pending.owner-b')).toBeNull();
  });

  it('savePreview 应使用调用方捕获的 owner key', async () => {
    const service = createService();
    const savePreviewForOwner = service.savePreview.bind(service) as unknown as (
      cache: {
        linkId: string;
        blockId: string;
        plainText: string;
        excerpt: string;
        truncated: boolean;
        fetchedAt: string;
        fetchStatus: 'ready';
      },
      ownerUserId: string,
    ) => Promise<void>;

    await savePreviewForOwner({
      linkId: 'link-1',
      blockId: 'block-1',
      plainText: 'preview',
      excerpt: 'preview',
      truncated: false,
      fetchedAt: '2026-07-14T00:00:00.000Z',
      fetchStatus: 'ready',
    }, 'owner-a');

    expect(mockSet).toHaveBeenCalledWith(
      'siyuan-preview-cache:owner-a:link-1:block-1',
      expect.objectContaining({ linkId: 'link-1', blockId: 'block-1' }),
    );
  });

  it('deletePreviewsForLink 发生在 save await 期间时应拒绝并清理迟到写入', async () => {
    const setDeferred = createDeferred<void>();
    mockSet.mockReturnValueOnce(setDeferred.promise);
    const service = createService();
    const savePreviewWithGeneration = service.savePreview.bind(service) as unknown as (
      cache: {
        linkId: string;
        blockId: string;
        plainText: string;
        excerpt: string;
        truncated: boolean;
        fetchedAt: string;
        fetchStatus: 'ready';
      },
      ownerUserId: string,
      generation: number,
    ) => Promise<boolean>;

    const pendingSave = savePreviewWithGeneration({
      linkId: 'link-late',
      blockId: 'block-late',
      plainText: 'late preview',
      excerpt: 'late preview',
      truncated: false,
      fetchedAt: '2026-07-14T00:00:00.000Z',
      fetchStatus: 'ready',
    }, 'owner-a', 0);
    await vi.waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1));

    await service.deletePreviewsForLink('link-late');
    setDeferred.resolve();

    expect(await pendingSave).toBe(false);
    expect(mockDel).toHaveBeenCalledWith(
      'siyuan-preview-cache:owner-a:link-late:block-late',
    );
  });

  it('deletePreviewsForLink 应在 keys() 前捕获 owner，切换后只删除原 owner 的 link 缓存', async () => {
    const keysDeferred = createDeferred<IDBValidKey[]>();
    mockKeys.mockReturnValueOnce(keysDeferred.promise);
    const service = createService();

    const pending = service.deletePreviewsForLink('link-1');
    await vi.waitFor(() => expect(mockKeys).toHaveBeenCalledTimes(1));
    ownerUserId = 'owner-b';
    keysDeferred.resolve([
      'siyuan-preview-cache:owner-a:link-1:block-a',
      'siyuan-preview-cache:owner-b:link-1:block-b',
      'siyuan-preview-cache:owner-a:link-2:block-c',
    ]);

    await pending;

    expect(mockDel).toHaveBeenCalledTimes(1);
    expect(mockDel).toHaveBeenCalledWith('siyuan-preview-cache:owner-a:link-1:block-a');
    expect(mockDel).not.toHaveBeenCalledWith('siyuan-preview-cache:owner-b:link-1:block-b');
  });

  it('clearPreviewCache 应在 keys() 前捕获 owner，切换后清空原 owner 且保留新 owner', async () => {
    const keysDeferred = createDeferred<IDBValidKey[]>();
    mockKeys.mockReturnValueOnce(keysDeferred.promise);
    const service = createService();

    const pending = service.clearPreviewCache();
    await vi.waitFor(() => expect(mockKeys).toHaveBeenCalledTimes(1));
    ownerUserId = 'owner-b';
    keysDeferred.resolve([
      'siyuan-preview-cache:owner-a:link-1:block-a',
      'siyuan-preview-cache:owner-a:link-2:block-b',
      'siyuan-preview-cache:owner-b:link-3:block-c',
    ]);

    await pending;

    expect(mockDel).toHaveBeenCalledTimes(2);
    expect(mockDel).toHaveBeenCalledWith('siyuan-preview-cache:owner-a:link-1:block-a');
    expect(mockDel).toHaveBeenCalledWith('siyuan-preview-cache:owner-a:link-2:block-b');
    expect(mockDel).not.toHaveBeenCalledWith('siyuan-preview-cache:owner-b:link-3:block-c');
  });

  it('retains one operation for an exact retry and rotates it for changed payload', async () => {
    const service = createService();
    const original = createLink({ id: 'operation-link' });

    const first = await service.upsertPendingLink(original);
    const exactRetry = await service.upsertPendingLink({ ...original });
    const changed = await service.upsertPendingLink({
      ...original,
      targetId: '20260616000100-changed',
      uri: 'siyuan://blocks/20260616000100-changed?focus=1',
      updatedAt: '2026-06-16T00:01:00.000Z',
    });

    expect(exactRetry.operationId).toBe(first.operationId);
    expect(exactRetry.localCommittedAt).toBe(first.localCommittedAt);
    expect(changed.operationId).not.toBe(first.operationId);
    expect(changed.localCommittedAt).toBeGreaterThan(first.localCommittedAt);
  });

  it('does not remove a newer pending operation when an older acknowledgement arrives', async () => {
    const service = createService();
    const newer = pendingEntry('00000000-0000-4000-8000-000000000102', 102, {
      id: 'ack-link',
      updatedAt: '2026-06-16T00:01:00.000Z',
    });
    await service.replacePendingLinksForOwner([newer], ownerUserId);

    await expect(service.removePendingLink(
      newer.link.id,
      '00000000-0000-4000-8000-000000000101',
    )).resolves.toBe(false);
    await expect(service.loadPendingLinks()).resolves.toEqual([newer]);
    await expect(service.removePendingLink(newer.link.id, newer.operationId)).resolves.toBe(true);
    await expect(service.loadPendingLinks()).resolves.toEqual([]);
  });

  it('fails closed when removal cannot commit and stale IDB still contains A', async () => {
    const service = createService(), operation = pendingEntry(
      '00000000-0000-4000-8000-000000000103', 103, { id: 'rejected-remove' });
    await service.replacePendingLinksForOwner([operation], ownerUserId);
    mockGet.mockImplementation(async key => key === `external-source-pending:${ownerUserId}` ? [operation] : []);
    mockUpdate.mockRejectedValueOnce(new Error('remove did not commit'));
    await expect(service.removePendingLink(operation.link.id, operation.operationId)).rejects.toThrow('did not commit');
    await expect(service.loadPendingLinks()).resolves.toEqual([operation]);
  });

  it('does not increment or dead-letter newer B when late failure belongs to A', async () => {
    const service = createService();
    const older = { ...pendingEntry('00000000-0000-4000-8000-000000000201', 201, {
      id: 'failure-link',
    }), retryCount: 5 };
    const newer = pendingEntry('00000000-0000-4000-8000-000000000202', 202, {
      id: older.link.id,
      updatedAt: '2026-06-16T00:02:00.000Z',
    });
    await service.replacePendingLinksForOwner([older], ownerUserId);
    mockUpdate.mockImplementationOnce(async (_key, updater) => { updater([newer]); });

    await expect(service.recordPendingFailure(
      newer.link.id,
      older.operationId,
      'offline',
    )).resolves.toBe('stale');
    await expect(service.loadPendingLinks()).resolves.toEqual([newer]);
    await expect(service.loadDeadLetters()).resolves.toEqual([]);
  });

  it('does not duplicate A into pending and dead-letter when promotion cannot commit', async () => {
    const service = createService(), operation = {
      ...pendingEntry('00000000-0000-4000-8000-000000000203', 203, { id: 'rejected-dead-letter' }), retryCount: 5 };
    await service.replacePendingLinksForOwner([operation], ownerUserId);
    mockGet.mockImplementation(async key => key === `external-source-pending:${ownerUserId}` ? [operation] : []);
    mockUpdate.mockRejectedValueOnce(new Error('dead-letter did not commit'));
    await expect(service.recordPendingFailure(
      operation.link.id, operation.operationId, 'offline')).rejects.toThrow('did not commit');
    await expect(service.loadPendingLinks()).resolves.toEqual([operation]);
    await expect(service.loadDeadLetters()).resolves.toEqual([]);
  });

  it('CAS-replaces A with fresh tombstone C while exact tombstone retry retains C', async () => {
    const service = createService();
    const original = pendingEntry('00000000-0000-4000-8000-000000000301', 301, {
      id: 'tombstone-link',
    });
    await service.replacePendingLinksForOwner([original], ownerUserId);
    const tombstone = createLink({
      ...original.link,
      deletedAt: '2026-06-16T00:03:00.000Z',
      updatedAt: '2026-06-16T00:03:00.000Z',
    });

    const replaced = await service.replacePendingLinkForRetry(original.link.id, original.operationId, tombstone);
    expect(replaced?.operationId).not.toBe(original.operationId);
    const exactRetry = await service.replacePendingLinkForRetry(
      original.link.id,
      replaced!.operationId,
      { ...tombstone },
    );
    expect(exactRetry?.operationId).toBe(replaced?.operationId);
  });

  it('does not let late A retry transformation replace newer B', async () => {
    const service = createService();
    const newer = pendingEntry('00000000-0000-4000-8000-000000000402', 402, {
      id: 'retry-link',
      updatedAt: '2026-06-16T00:04:00.000Z',
    });
    await service.replacePendingLinksForOwner([newer], ownerUserId);

    await expect(service.replacePendingLinkForRetry(
      newer.link.id,
      '00000000-0000-4000-8000-000000000401',
      createLink({ ...newer.link, deletedAt: '2026-06-16T00:05:00.000Z' }),
    )).resolves.toBeNull();
    await expect(service.loadPendingLinks()).resolves.toEqual([newer]);
  });

  function createService() {
    return Injector.create({
      providers: [
        { provide: authServiceClass, useValue: { currentUserId: () => ownerUserId } },
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

function pendingEntry(
  operationId: string,
  localCommittedAt: number,
  link: Partial<ExternalSourceLink>,
): PendingExternalSourceLink {
  return {
    link: createLink(link),
    operationId,
    localCommittedAt,
    syncState: 'pending_sync',
    retryCount: 0,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
