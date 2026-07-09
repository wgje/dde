import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { clear } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../../services/auth.service';
import { LoggerService } from '../../../services/logger.service';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { ToastService } from '../../../services/toast.service';
import {
  createBrowserNetworkSuspendedError,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../../../utils/browser-network-suspension';
import { ExternalSourceCacheService } from './external-source-cache.service';
import { ExternalSourceLinkService } from './external-source-link.service';
import { registerExternalSourceLinkRefreshSpecs } from './external-source-link-refresh.spec-helpers';
import type { ExternalSourceLink } from './external-source.model';

function setVisibilityState(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    writable: true,
    configurable: true,
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe('ExternalSourceLinkService', () => {
  let upsertPayloads: unknown[];
  let upsertCallCount = 0;
  let selectCallCount = 0;
  let authUser = signal('00000000-0000-0000-0000-000000000001');
  let shouldFailUpsert = false;
  let upsertError: { code?: string; status?: number; message: string } | Error | null = null;
  let upsertErrorQueue: Array<{ code?: string; status?: number; message: string } | Error> = [];
  let selectError: Error | null = null;
  let remoteRows: unknown[] = [];
  let clientAsyncMock: ReturnType<typeof vi.fn>;
  let loggerCategoryMock: {
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await clear();
    vi.useRealTimers();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    upsertPayloads = [];
    upsertCallCount = 0;
    selectCallCount = 0;
    authUser = signal('00000000-0000-0000-0000-000000000001');
    shouldFailUpsert = false;
    upsertError = null;
    upsertErrorQueue = [];
    selectError = null;
    remoteRows = [];
    loggerCategoryMock = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const from = vi.fn((table: string) => ({
      select: vi.fn(() => {
        const query = {
          eq: vi.fn(() => query),
          order: vi.fn(() => query),
          range: vi.fn(async (fromIndex: number, toIndex: number) => {
            selectCallCount += 1;
            if (selectError) return { data: null, error: selectError };
            return { data: remoteRows.slice(fromIndex, toIndex + 1), error: null };
          }),
        };
        return query;
      }),
      upsert: vi.fn(async (payload: unknown) => {
        upsertCallCount += 1;
        const queuedError = upsertErrorQueue.shift();
        if (queuedError) return { error: queuedError };
        if (upsertError) return { error: upsertError };
        if (shouldFailUpsert) return { error: new Error('offline') };
        upsertPayloads.push({ table, payload });
        return { error: null };
      }),
    }));
    clientAsyncMock = vi.fn(async () => ({ from }));

    TestBed.configureTestingModule({
      providers: [
        ExternalSourceLinkService,
        { provide: AuthService, useValue: { currentUserId: authUser } },
        { provide: SupabaseClientService, useValue: { clientAsync: clientAsyncMock } },
        { provide: ToastService, useValue: { success: vi.fn(), info: vi.fn(), error: vi.fn() } },
        { provide: LoggerService, useValue: { category: () => loggerCategoryMock } },
      ],
    });
  });

  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    vi.useRealTimers();
  });

  it('creates a local-first SiYuan pointer with client uuid and standard deep link', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);

    const link = await service.bindSiyuanBlock('task-1', 'siyuan://blocks/20260426123456-abc1234');

    expect(link?.id).toMatch(/[0-9a-f-]{36}/);
    expect(link?.taskId).toBe('task-1');
    expect(link?.targetId).toBe('20260426123456-abc1234');
    expect(link?.uri).toBe('siyuan://blocks/20260426123456-abc1234?focus=1');
    expect(service.firstActiveLinkForTask('task-1')?.id).toBe(link?.id);
  });

  it('creates and queues a SiYuan pointer with Web Crypto fallback when crypto.randomUUID is unavailable', async () => {
    const originalCrypto = globalThis.crypto;
    let callCount = 0;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues: (array: Uint8Array) => {
          callCount += 1;
          array.fill(callCount);
          return array;
        },
      },
    });

    try {
      const service = TestBed.inject(ExternalSourceLinkService);
      const cache = TestBed.inject(ExternalSourceCacheService);

      const link = await service.bindSiyuanBlock('task-1', 'siyuan://blocks/20260426123456-abc1234');
      const pending = await cache.loadPendingLinks();

      expect(link?.id).toBe('01010101-0101-4101-8101-010101010101');
      expect(service.firstActiveLinkForTask('task-1')?.id).toBe(link?.id);
      expect(pending).toHaveLength(1);
      expect(pending[0].link.id).toBe(link?.id);
      expect(pending[0].operationId).toBe('02020202-0202-4202-8202-020202020202');
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it('sync payload contains pointer metadata but no preview body fields', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);

    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();

    expect(upsertPayloads).toHaveLength(1);
    const payload = upsertPayloads[0] as { table: string; payload: Record<string, unknown> };
    expect(payload.table).toBe('external_source_links');
    expect(payload.payload).toMatchObject({ task_id: 'task-1', target_id: '20260426123456-abc1234' });
    expect(payload.payload).not.toHaveProperty('content');
    expect(payload.payload).not.toHaveProperty('markdown');
    expect(payload.payload).not.toHaveProperty('kramdown');
    expect(payload.payload).not.toHaveProperty('plainText');
  });



  it('keeps failed pushes in a durable pending queue and flushes later', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    shouldFailUpsert = true;

    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();
    expect(upsertPayloads).toHaveLength(0);

    shouldFailUpsert = false;
    await service.flushPendingLinks();

    expect(upsertPayloads).toHaveLength(1);
  });

  it('keeps authenticated link pushes pending when the Supabase client is unavailable', async () => {
    clientAsyncMock.mockImplementation(async () => null);
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);

    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();

    const pending = await cache.loadPendingLinks();
    expect(pending).toHaveLength(1);
    expect(pending[0].link.targetId).toBe('20260426123456-abc1234');
    expect(pending[0].lastErrorCode).toBe('no-client');
  });

  it('recovers pending links from durable storage after service recreation and flushes them', async () => {
    clientAsyncMock.mockImplementation(async () => null);
    const firstService = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);

    const link = await firstService.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await firstService.flushPendingLinks();

    const pendingBeforeRecreation = await cache.loadPendingLinks();
    expect(pendingBeforeRecreation).toHaveLength(1);
    const operationId = pendingBeforeRecreation[0].operationId;
    expect(upsertPayloads).toHaveLength(0);

    clientAsyncMock.mockImplementation(async () => ({
      from: vi.fn((table: string) => ({
        select: vi.fn(() => {
          const query = {
            eq: vi.fn(() => query),
            order: vi.fn(() => query),
            range: vi.fn(async () => ({ data: [], error: null })),
          };
          return query;
        }),
        upsert: vi.fn(async (payload: unknown) => {
          upsertPayloads.push({ table, payload });
          return { error: null };
        }),
      })),
    }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ExternalSourceLinkService,
        { provide: AuthService, useValue: { currentUserId: authUser } },
        { provide: SupabaseClientService, useValue: { clientAsync: clientAsyncMock } },
        { provide: ToastService, useValue: { success: vi.fn(), info: vi.fn(), error: vi.fn() } },
        { provide: LoggerService, useValue: { category: () => loggerCategoryMock } },
      ],
    });
    const recreatedService = TestBed.inject(ExternalSourceLinkService);

    await recreatedService.flushPendingLinks();

    expect(upsertPayloads).toEqual([
      expect.objectContaining({
        table: 'external_source_links',
        payload: expect.objectContaining({
          id: link!.id,
          task_id: 'task-1',
          target_id: '20260426123456-abc1234',
          operation_id: operationId,
        }),
      }),
    ]);
    expect(await TestBed.inject(ExternalSourceCacheService).loadPendingLinks()).toEqual([]);
  });

  it('does not expose a new link in UI when durable pending enqueue fails', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);
    vi.spyOn(cache, 'upsertPendingLink').mockRejectedValueOnce(new Error('idb write failed'));

    await expect(service.bindSiyuanBlock('task-1', '20260426123456-abc1234')).rejects.toThrow('idb write failed');

    expect(service.firstActiveLinkForTask('task-1')).toBeNull();
    expect(await cache.loadLinks()).toHaveLength(0);
    expect(await cache.loadPendingLinks()).toHaveLength(0);
  });

  it('reloads local links when the current owner changes', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const first = await service.bindSiyuanBlock('task-a', '20260426123456-abc1234');
    expect(service.firstActiveLinkForTask('task-a')?.id).toBe(first?.id);

    authUser.set('00000000-0000-0000-0000-000000000002');
    await service.ensureLoaded();

    expect(service.firstActiveLinkForTask('task-a')).toBeNull();
  });

  it('ignores a late ensureLoaded result from a previous owner', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);
    const now = new Date().toISOString();
    const ownerALink: ExternalSourceLink = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      taskId: 'task-owner-a',
      sourceType: 'siyuan-block',
      targetId: '20260614000000-ownerA',
      uri: 'siyuan://blocks/20260614000000-ownerA?focus=1',
      sortOrder: 0,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const ownerBLink: ExternalSourceLink = {
      ...ownerALink,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      taskId: 'task-owner-b',
      targetId: '20260614000000-ownerB',
      uri: 'siyuan://blocks/20260614000000-ownerB?focus=1',
    };
    const ownerALocal = createDeferred<ExternalSourceLink[]>();
    vi.spyOn(cache, 'loadLinks')
      .mockImplementationOnce(() => ownerALocal.promise)
      .mockResolvedValueOnce([ownerBLink]);
    vi.spyOn(cache, 'saveLinks').mockResolvedValue(undefined);
    vi.spyOn(
      service as unknown as {
        pullRemoteLinks(): Promise<{ links: ExternalSourceLink[]; deferredBySuspension: boolean; failed: boolean }>;
      },
      'pullRemoteLinks',
    ).mockResolvedValue({ links: [], deferredBySuspension: false, failed: false });
    vi.spyOn(
      service as unknown as {
        pushLocalNewerLinks(localLinks: ExternalSourceLink[], remoteLinks: ExternalSourceLink[]): Promise<void>;
      },
      'pushLocalNewerLinks',
    ).mockResolvedValue(undefined);

    const ownerALoad = service.ensureLoaded();
    authUser.set('00000000-0000-0000-0000-000000000002');
    await service.ensureLoaded();

    expect(service.links().map(link => link.id)).toEqual([ownerBLink.id]);

    ownerALocal.resolve([ownerALink]);
    await ownerALoad;

    expect(service.links().map(link => link.id)).toEqual([ownerBLink.id]);
  });

  it('soft deletes links and hides them from active task anchors', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const link = await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');

    await service.removeLink(link!.id);

    expect(service.firstActiveLinkForTask('task-1')).toBeNull();
  });

  it('replaces a wrong SiYuan pointer in place and clears stale previews', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);
    const link = await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await cache.savePreview({
      linkId: link!.id,
      blockId: '20260426123456-abc1234',
      fetchedAt: new Date().toISOString(),
      fetchStatus: 'ready',
      excerpt: '旧块预览',
      truncated: false,
    });

    const replaced = await service.replaceSiyuanBlock(link!.id, '20260426123456-def5678');

    expect(replaced?.id).toBe(link!.id);
    expect(replaced?.targetId).toBe('20260426123456-def5678');
    expect(replaced?.uri).toBe('siyuan://blocks/20260426123456-def5678?focus=1');
    expect(replaced?.label).toBe('思源 2026…5678');
    expect(replaced?.hpath).toBeUndefined();
    expect(service.firstActiveLinkForTask('task-1')?.targetId).toBe('20260426123456-def5678');
    expect(await cache.getPreview(link!.id, '20260426123456-abc1234')).toBeNull();
  });

  it('switches to an existing matching SiYuan pointer instead of creating an active duplicate', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const first = await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    const second = await service.bindSiyuanBlock('task-1', '20260426123456-def5678');

    const result = await service.replaceSiyuanBlock(first!.id, '20260426123456-def5678');

    expect(result?.id).toBe(second!.id);
    expect(service.activeLinksForTask('task-1').map(link => link.id)).toEqual([second!.id]);
    expect(service.links().find(link => link.id === first!.id)?.deletedAt).toBeTruthy();
  });

  it('reconciles stale remote duplicate conflicts by switching to remote truth', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const first = await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();
    upsertPayloads = [];
    const now = new Date().toISOString();
    remoteRows = [
      {
        id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        user_id: '00000000-0000-0000-0000-000000000001',
        task_id: 'task-1',
        source_type: 'siyuan-block',
        target_id: '20260426123456-def5678',
        uri: 'siyuan://blocks/20260426123456-def5678?focus=1',
        label: '远端已有锚点',
        hpath: null,
        role: null,
        sort_order: 0,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      },
    ];
    upsertErrorQueue.push({ code: '23505', message: 'duplicate key value violates unique constraint' });

    await service.replaceSiyuanBlock(first!.id, '20260426123456-def5678');
    await service.flushPendingLinks();

    expect(service.activeLinksForTask('task-1').map(link => link.id)).toEqual([
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    ]);
    expect(service.links().find(link => link.id === first!.id)?.deletedAt).toBeTruthy();
    expect(upsertPayloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          id: first!.id,
          target_id: '20260426123456-def5678',
          deleted_at: expect.any(String),
        }),
      }),
    ]));
  });

  it('resolves unique-violation (23505) with a tombstone instead of looping forever', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);

    upsertErrorQueue.push({ code: '23505', message: 'duplicate key value violates unique constraint' });
    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();

    expect(await cache.loadPendingLinks()).toHaveLength(0);
    expect(await cache.loadDeadLetters()).toHaveLength(0);
  });

  it('keeps a tombstone pending when unique-conflict reconciliation fails', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);
    const link = await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();
    upsertErrorQueue.push(
      { code: '23505', message: 'duplicate key value violates unique constraint' },
      new Error('tombstone offline'),
    );

    await service.replaceSiyuanBlock(link!.id, '20260426123456-def5678');
    await service.flushPendingLinks();

    expect(service.firstActiveLinkForTask('task-1')).toBeNull();
    const pending = await cache.loadPendingLinks();
    expect(pending).toHaveLength(1);
    expect(pending[0].link.id).toBe(link!.id);
    expect(pending[0].link.targetId).toBe('20260426123456-def5678');
    expect(pending[0].link.deletedAt).toBeTruthy();
    expect(pending[0].retryCount).toBe(1);
  });

  it('keeps a tombstone pending when unique-conflict remote refresh fails', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);
    const link = await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();
    upsertErrorQueue.push({ code: '23505', message: 'duplicate key value violates unique constraint' });
    selectError = new Error('pull failed');

    await service.replaceSiyuanBlock(link!.id, '20260426123456-def5678');
    await service.flushPendingLinks();

    expect(service.firstActiveLinkForTask('task-1')).toBeNull();
    const pending = await cache.loadPendingLinks();
    expect(pending).toHaveLength(1);
    expect(pending[0].link.id).toBe(link!.id);
    expect(pending[0].link.deletedAt).toBeTruthy();
    expect(pending[0].retryCount).toBe(1);
  });

  it('pushLocalNewerLinks preserves tombstone pending after unique-conflict fallback', async () => {
    const service = TestBed.inject(ExternalSourceLinkService) as unknown as {
      pushLocalNewerLinks(localLinks: Array<Record<string, unknown>>, remoteLinks: Array<Record<string, unknown>>): Promise<void>;
    };
    const cache = TestBed.inject(ExternalSourceCacheService);
    const now = new Date().toISOString();
    const link = {
      id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      taskId: 'task-1',
      sourceType: 'siyuan-block' as const,
      targetId: '20260426123456-def5678',
      uri: 'siyuan://blocks/20260426123456-def5678?focus=1',
      sortOrder: 0,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    upsertErrorQueue.push(
      { code: '23505', message: 'duplicate key value violates unique constraint' },
      new Error('tombstone offline'),
    );

    await service.pushLocalNewerLinks([link], []);

    const pending = await cache.loadPendingLinks();
    expect(pending).toHaveLength(1);
    expect(pending[0].link.id).toBe(link.id);
    expect(pending[0].link.deletedAt).toBeTruthy();
    expect(pending[0].link.targetId).toBe('20260426123456-def5678');
  });

  it('pushLocalNewerLinks records a durable pending operation before successful direct push', async () => {
    const service = TestBed.inject(ExternalSourceLinkService) as unknown as {
      pushLocalNewerLinks(localLinks: Array<Record<string, unknown>>, remoteLinks: Array<Record<string, unknown>>): Promise<void>;
    };
    const cache = TestBed.inject(ExternalSourceCacheService);
    const upsertPendingSpy = vi.spyOn(cache, 'upsertPendingLink');
    const removePendingSpy = vi.spyOn(cache, 'removePendingLink');
    const now = new Date().toISOString();
    const link = {
      id: 'eeeeeeee-0000-4000-8000-000000000000',
      taskId: 'task-local-newer',
      sourceType: 'siyuan-block' as const,
      targetId: '20260426123456-abc1234',
      uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
      sortOrder: 0,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await service.pushLocalNewerLinks([link], []);

    const pendingEntry = await upsertPendingSpy.mock.results[0]?.value;
    const payload = upsertPayloads[0] as { payload: Record<string, unknown> };
    expect(upsertPendingSpy).toHaveBeenCalledWith(link, { resetRetryCount: false });
    expect(removePendingSpy).toHaveBeenCalledWith(link.id);
    expect(pendingEntry.operationId).toMatch(/[0-9a-f-]{36}/);
    expect(payload.payload.operation_id).toBe(pendingEntry.operationId);
    expect(await cache.loadPendingLinks()).toHaveLength(0);
  });

  it('keeps retry counter so transient failures eventually move to dead letter', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);

    shouldFailUpsert = true;
    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    for (let i = 0; i < 6; i++) await service.flushPendingLinks();

    expect(await cache.loadPendingLinks()).toHaveLength(0);
    const deadLetters = await cache.loadDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].retryCount).toBeGreaterThan(5);
  });

  it('dedupes concurrent ensureLoaded calls into a single in-flight promise', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const before = clientAsyncMock.mock.calls.length;

    await Promise.all([service.ensureLoaded(), service.ensureLoaded(), service.ensureLoaded()]);
    const after = clientAsyncMock.mock.calls.length;

    // 3 个 caller 只触发一次远端 pull（getClient 调用）；不再每次都重新 pullRemoteLinks。
    expect(after - before).toBe(1);
  });

  it('does not push local links when the initial remote pull fails', async () => {
    const cache = TestBed.inject(ExternalSourceCacheService);
    const now = new Date().toISOString();
    await cache.saveLinks([
      {
        id: '99999999-9999-4999-8999-999999999999',
        taskId: 'task-local',
        sourceType: 'siyuan-block',
        targetId: '20260426123456-abc1234',
        uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
        sortOrder: 0,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    selectError = new Error('pull failed');

    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();

    expect(service.firstActiveLinkForTask('task-local')?.id).toBe('99999999-9999-4999-8999-999999999999');
    expect(upsertCallCount).toBe(0);
  });

  it('drops links whose deletedAt is older than the tombstone retention window', async () => {
    // 本地 IndexedDB 中预置一个 30 天前已删除的 link 和一个活跃 link；
    // ensureLoaded 后过期墓碑应被 GC，活跃 link 保留。
    const userId = '00000000-0000-0000-0000-000000000001';
    const now = Date.now();
    const ancient = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(now).toISOString();
    const cache = TestBed.inject(ExternalSourceCacheService);
    void userId; // ownerId 由 auth mock 保证一致
    await cache.saveLinks([
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        taskId: 'task-old',
        sourceType: 'siyuan-block',
        targetId: '20250101120000-old0001',
        uri: 'siyuan://blocks/20250101120000-old0001?focus=1',
        sortOrder: 0,
        deletedAt: ancient,
        createdAt: ancient,
        updatedAt: ancient,
      },
      {
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        taskId: 'task-new',
        sourceType: 'siyuan-block',
        targetId: '20260426123456-new0001',
        uri: 'siyuan://blocks/20260426123456-new0001?focus=1',
        sortOrder: 0,
        deletedAt: null,
        createdAt: fresh,
        updatedAt: fresh,
      },
    ]);

    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();

    const ids = service.links().map((link) => link.id);
    expect(ids).not.toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(ids).toContain('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  registerExternalSourceLinkRefreshSpecs({
    clientAsyncMock: () => clientAsyncMock,
    getSelectCallCount: () => selectCallCount,
    getUpsertCallCount: () => upsertCallCount,
    setRemoteRows: (rows) => { remoteRows = rows; },
    setSelectError: (error) => { selectError = error; },
    setUpsertCallCount: (count) => { upsertCallCount = count; },
    setVisibilityState,
  });

  it('BrowserNetworkSuspendedError 不应消耗思源锚点 pending 的 retry budget', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);

    upsertError = createBrowserNetworkSuspendedError();
    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();

    const pending = await cache.loadPendingLinks();
    expect(upsertCallCount).toBeGreaterThan(0);
    expect(pending).toHaveLength(1);
    expect(pending[0].retryCount).toBe(0);
    expect(loggerCategoryMock.warn).not.toHaveBeenCalledWith(
      '推送思源锚点失败，已保留本机重试',
      expect.objectContaining({ errorCode: 'browser-network-suspended' }),
    );
  });

  it('suspension 延后 pushLocalNewerLinks 时应保留已有 pending retryCount', async () => {
    const service = TestBed.inject(ExternalSourceLinkService) as unknown as {
      pushLocalNewerLinks(localLinks: Array<Record<string, unknown>>, remoteLinks: Array<Record<string, unknown>>): Promise<void>;
    };
    const cache = TestBed.inject(ExternalSourceCacheService);
    const now = new Date().toISOString();
    const link = {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      taskId: 'task-1',
      sourceType: 'siyuan-block' as const,
      targetId: '20260426123456-abc1234',
      uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
      sortOrder: 0,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await cache.upsertPendingLink(link, { resetRetryCount: true });
    await cache.recordPendingFailure(link.id, 'offline');
    setVisibilityState('hidden');

    await service.pushLocalNewerLinks([link], []);

    const pending = await cache.loadPendingLinks();
    expect(pending).toHaveLength(1);
    expect(pending[0].retryCount).toBe(1);
  });

  it('continues opportunistic listener cleanup when one removeEventListener throws', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();
    const documentRemoveSpy = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw new Error('visibility cleanup failed');
      });
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');
    const internals = service as unknown as { opportunisticListenersBound: boolean };

    try {
      expect(() => TestBed.resetTestingModule()).not.toThrow();
      expect(windowRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function));
      expect(internals.opportunisticListenersBound).toBe(false);
    } finally {
      documentRemoveSpy.mockRestore();
      windowRemoveSpy.mockRestore();
    }
  });

  it('continues opportunistic listener cleanup when cleanup warning logging throws', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();
    const documentRemoveSpy = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw new Error('visibility cleanup failed');
      });
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');
    loggerCategoryMock.warn.mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });
    const internals = service as unknown as { opportunisticListenersBound: boolean };

    try {
      expect(() => TestBed.resetTestingModule()).not.toThrow();
      expect(windowRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function));
      expect(internals.opportunisticListenersBound).toBe(false);
      expect(loggerCategoryMock.warn).toHaveBeenCalledWith(
        '思源锚点 visibility 监听解绑失败，继续清理其他监听',
        expect.objectContaining({ message: 'visibility cleanup failed' }),
      );
    } finally {
      documentRemoveSpy.mockRestore();
      windowRemoveSpy.mockRestore();
    }
  });

  it('resume sync timer 注册失败时不应打穿恢复事件链路', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();
    const scheduleError = new Error('schedule resume sync failed');
    const setTimeoutSpy = vi
      .spyOn(window, 'setTimeout')
      .mockImplementation(() => {
        throw scheduleError;
      });

    try {
      expect(() => {
        (service as unknown as { scheduleResumeSync: (forceRefresh?: boolean) => void })
          .scheduleResumeSync(true);
      }).not.toThrow();

      expect(loggerCategoryMock.warn).toHaveBeenCalledWith(
        '思源锚点恢复 timer 注册失败，等待下一次恢复事件重试',
        expect.objectContaining({ message: 'schedule resume sync failed' }),
      );
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('destroy cleanup 清理 resume sync timer 失败时仍应完成销毁', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();
    const timerId = 456 as unknown as ReturnType<typeof window.setTimeout>;
    const setTimeoutSpy = vi
      .spyOn(window, 'setTimeout')
      .mockImplementation(() => timerId);
    const clearTimeoutSpy = vi
      .spyOn(window, 'clearTimeout')
      .mockImplementation(() => {
        throw new Error('clear resume sync failed');
      });

    try {
      (service as unknown as { scheduleResumeSync: (forceRefresh?: boolean) => void })
        .scheduleResumeSync(true);

      expect(() => TestBed.resetTestingModule()).not.toThrow();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
      expect(loggerCategoryMock.warn).toHaveBeenCalledWith(
        '思源锚点恢复 timer 清理失败，继续清理其他资源',
        expect.objectContaining({ message: 'clear resume sync failed' }),
      );
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});
