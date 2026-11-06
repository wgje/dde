import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { clear } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../../services/auth.service';
import { LoggerService } from '../../../services/logger.service';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { ToastService } from '../../../services/toast.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../utils/browser-network-suspension';
import { ExternalSourceCacheService } from './external-source-cache.service';
import { ExternalSourceLinkService } from './external-source-link.service';
import { registerExternalSourceLinkRefreshSpecs } from './external-source-link-refresh.spec-helpers';
import { registerExternalSourceLinkResumeSyncSpecs } from './external-source-link-resume-sync.spec-helpers';
import { ExternalSourceLinkStore } from './external-source-link.store';
import type { ExternalSourceLink } from './external-source.model';
function setVisibilityState(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, writable: true, configurable: true });
}
function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve; reject = promiseReject;
  });
  return { promise, reject, resolve };
}
function externalSourceLink(overrides: Partial<ExternalSourceLink> = {}): ExternalSourceLink {
  const targetId = overrides.targetId ?? '20260426123456-abc1234';
  const createdAt = overrides.createdAt ?? '2026-06-08T00:00:00.000Z';
  return {
    id: overrides.id ?? '00000000-0000-4000-8000-000000000000',
    taskId: overrides.taskId ?? 'task-1', sourceType: 'siyuan-block', targetId,
    uri: overrides.uri ?? `siyuan://blocks/${targetId}?focus=1`, label: overrides.label,
    hpath: overrides.hpath, role: overrides.role, sortOrder: overrides.sortOrder ?? 0,
    deletedAt: overrides.deletedAt ?? null, createdAt, updatedAt: overrides.updatedAt ?? createdAt,
  };
}
type UpsertError = { code?: string; status?: number; message: string } | Error;
type UpsertResult = { error: UpsertError | null };
const SECOND_OWNER_ID = '00000000-0000-0000-0000-000000000002';
describe('ExternalSourceLinkService', () => {
  let upsertPayloads: unknown[];
  let upsertAttempts: Array<{ table: string; payload: unknown }>;
  let upsertCallCount = 0;
  let selectCallCount = 0;
  let selectRangeCallCount = 0;
  let selectCursorValues: Array<string | null> = [];
  let authUser = signal('00000000-0000-0000-0000-000000000001');
  let authFence = signal('auth-fence-a');
  let shouldFailUpsert = false;
  let upsertError: UpsertError | null = null;
  let upsertErrorQueue: UpsertError[] = [];
  let selectError: Error | null = null;
  let remoteRows: unknown[] = [];
  let deferredUpsertCall: { index: number; gate: ReturnType<typeof createDeferred<UpsertResult>> } | null;
  let clientAsyncMock: ReturnType<typeof vi.fn>;
  let loggerCategoryMock: Record<'warn' | 'info' | 'debug' | 'error', ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    await clear();
    vi.useRealTimers();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    upsertPayloads = [];
    upsertAttempts = [];
    upsertCallCount = 0;
    selectCallCount = 0;
    selectRangeCallCount = 0;
    selectCursorValues = [];
    authUser = signal('00000000-0000-0000-0000-000000000001');
    authFence = signal('auth-fence-a');
    shouldFailUpsert = false;
    upsertError = null;
    upsertErrorQueue = [];
    deferredUpsertCall = null;
    selectError = null;
    remoteRows = [];
    loggerCategoryMock = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const from = vi.fn((table: string) => ({
      select: vi.fn(() => {
        let idCursor: string | null = null;
        const query = {
          eq: vi.fn(() => query),
          gt: vi.fn((column: string, value: string) => {
            if (column === 'id') idCursor = value;
            return query;
          }),
          order: vi.fn(() => query),
          range: vi.fn(async (fromIndex: number, toIndex: number) => {
            selectCallCount += 1;
            selectRangeCallCount += 1;
            if (selectError) return { data: null, error: selectError };
            return { data: remoteRows.slice(fromIndex, toIndex + 1), error: null };
          }),
          limit: vi.fn(async (count: number) => {
            selectCallCount += 1;
            selectCursorValues.push(idCursor);
            if (selectError) return { data: null, error: selectError };
            const orderedRows = [...remoteRows].sort((left, right) =>
              String((left as { id?: unknown }).id ?? '')
                .localeCompare(String((right as { id?: unknown }).id ?? '')),
            );
            const visibleRows = idCursor === null
              ? orderedRows
              : orderedRows.filter(row =>
                String((row as { id?: unknown }).id ?? '') > idCursor!,
              );
            return { data: visibleRows.slice(0, count), error: null };
          }),
        };
        return query;
      }),
      upsert: vi.fn(async (payload: unknown) => {
        upsertCallCount += 1;
        upsertAttempts.push({ table, payload });
        if (deferredUpsertCall?.index === upsertCallCount) {
          const gate = deferredUpsertCall.gate;
          deferredUpsertCall = null;
          return gate.promise;
        }
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
        { provide: AuthService, useValue: {
          currentUserId: authUser,
          captureAuthIdentityFence: () => authFence(),
        } },
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
        { provide: AuthService, useValue: {
          currentUserId: authUser,
          captureAuthIdentityFence: () => authFence(),
        } },
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
  it('aborts an import when the owner changes across an await boundary', async () => {
    clientAsyncMock.mockImplementation(async () => null);
    const cache = TestBed.inject(ExternalSourceCacheService), ownerALoad = createDeferred<ExternalSourceLink[]>();
    vi.spyOn(cache, 'loadLinks').mockImplementationOnce(() => ownerALoad.promise);
    const service = TestBed.inject(ExternalSourceLinkService);
    const commitProject = vi.fn().mockResolvedValue(undefined);
    const importPromise = service.importPointers([externalSourceLink()], commitProject);
    authUser.set('00000000-0000-0000-0000-000000000002');
    ownerALoad.resolve([]);
    await expect(importPromise).rejects.toThrow(/owner changed/i);
    expect(commitProject).not.toHaveBeenCalled();
    expect(service.links()).toEqual([]);
    for (const ownerId of ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002']) {
      authUser.set(ownerId);
      expect(await Promise.all([cache.loadLinks(), cache.loadPendingLinks()])).toEqual([[], []]);
    }
  });
  it('does not flush staged import links until the project commit succeeds', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();
    await service.flushPendingLinks();
    upsertCallCount = 0; upsertPayloads = [];
    const commitGate = createDeferred<void>();
    const commitProject = vi.fn(() => commitGate.promise);
    const importPromise = service.importPointers([externalSourceLink()], commitProject);
    await vi.waitFor(() => expect(commitProject).toHaveBeenCalledTimes(1));
    const flushPromise = service.flushPendingLinks();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(upsertCallCount).toBe(0);
    commitGate.resolve();
    await Promise.all([importPromise, flushPromise]);
    expect(upsertCallCount).toBe(1);
    expect(upsertPayloads[0]).toEqual(expect.objectContaining({
      payload: expect.objectContaining({ id: '00000000-0000-4000-8000-000000000000' }),
    }));
  });
  it('restores a duplicate link ID snapshot when the second write fails and preserves a concurrent operation', async () => {
    clientAsyncMock.mockImplementation(async () => null);
    const cache = TestBed.inject(ExternalSourceCacheService), store = TestBed.inject(ExternalSourceLinkStore);
    const existing = externalSourceLink({ id: '11111111-1111-4111-8111-111111111111', targetId: '20260608110000-aaaaaaa', label: 'existing' });
    await cache.saveLinks([existing]);
    const existingPending = await cache.upsertPendingLink(existing, { resetRetryCount: true });
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();
    const first = externalSourceLink({ ...existing, targetId: '20260608110200-ccccccc', label: 'first duplicate', updatedAt: '2026-06-08T00:01:00.000Z', uri: undefined });
    const second = externalSourceLink({ ...existing, targetId: '20260608110300-ddddddd', label: 'second duplicate', updatedAt: '2026-06-08T00:02:00.000Z', uri: undefined });
    const concurrent = externalSourceLink({ id: '22222222-2222-4222-8222-222222222222', targetId: '20260608110400-eeeeeee', label: 'concurrent' });
    const originalSaveLinks = cache.saveLinks.bind(cache);
    let saveCallCount = 0, concurrentPending: Awaited<ReturnType<ExternalSourceCacheService['upsertPendingLink']>> | undefined;
    vi.spyOn(cache, 'saveLinks').mockImplementation(async (links, userId) => {
      if (++saveCallCount === 2) {
        const concurrentLinks = [...await cache.loadLinks(userId), concurrent];
        concurrentPending = await cache.upsertPendingLink(concurrent, { resetRetryCount: true });
        await originalSaveLinks(concurrentLinks, userId);
        store.replaceAll(concurrentLinks);
        throw new Error('second duplicate persist failed');
      }
      await originalSaveLinks(links, userId);
    });
    await expect(service.importPointers([first, second])).rejects.toThrow('second duplicate persist failed');
    const localById = new Map((await cache.loadLinks()).map(link => [link.id, link])), storeById = new Map(service.links().map(link => [link.id, link]));
    const pendingById = new Map((await cache.loadPendingLinks()).map(entry => [entry.link.id, entry]));
    expect([localById.get(existing.id), storeById.get(existing.id)]).toEqual([existing, existing]);
    expect([localById.get(concurrent.id), storeById.get(concurrent.id)]).toEqual([concurrent, concurrent]);
    expect(pendingById.get(existing.id)).toEqual(existingPending);
    expect(pendingById.get(concurrent.id)).toEqual(concurrentPending);
  });
  it('rolls back the imported link batch when the project commit callback fails', async () => {
    clientAsyncMock.mockImplementation(async () => null);
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);
    const links = [
      externalSourceLink({ id: '55555555-5555-4555-8555-555555555555',
        taskId: 'task-project-failure-1', targetId: '20260608110600-ggggggg' }),
      externalSourceLink({ id: '66666666-6666-4666-8666-666666666666',
        taskId: 'task-project-failure-2', targetId: '20260608110700-hhhhhhh', sortOrder: 1 }),
    ];
    const commitProject = vi.fn().mockRejectedValue(new Error('project persist failed'));
    await expect(service.importPointers(links, commitProject)).rejects.toThrow('project persist failed');
    expect(commitProject).toHaveBeenCalledTimes(1);
    expect(await cache.loadLinks()).toEqual([]);
    expect(service.links()).toEqual([]);
    expect(await cache.loadPendingLinks()).toEqual([]);
  });

  it('reloads local links when the current owner changes', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const first = await service.bindSiyuanBlock('task-a', '20260426123456-abc1234');
    expect(service.firstActiveLinkForTask('task-a')?.id).toBe(first?.id);

    authUser.set('00000000-0000-0000-0000-000000000002');
    await service.ensureLoaded();

    expect(service.firstActiveLinkForTask('task-a')).toBeNull();
  });

  it('hides the previous owner links immediately when auth changes', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.bindSiyuanBlock('task-a', '20260426123456-abc1234');
    expect(service.links()).toHaveLength(1);

    authUser.set(SECOND_OWNER_ID);
    authFence.set('auth-fence-b');

    expect(service.links()).toEqual([]);
    expect(service.activeLinks()).toEqual([]);
    expect(service.firstActiveLinkForTask('task-a')).toBeNull();
    await service.ensureLoaded();
    expect(service.links()).toEqual([]);
  });

  it('keeps a local mutation in its captured owner bucket across an auth switch', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);
    await service.ensureLoaded();

    const pendingWritten = createDeferred<void>();
    const continueMutation = createDeferred<void>();
    const originalUpsertPendingLink = cache.upsertPendingLink.bind(cache);
    vi.spyOn(cache, 'upsertPendingLink').mockImplementation(async (...args) => {
      const pending = await originalUpsertPendingLink(...args);
      pendingWritten.resolve();
      await continueMutation.promise;
      return pending;
    });

    const bindPromise = service.bindSiyuanBlock('task-owner-a', '20260426123456-abc1234');
    await pendingWritten.promise;
    authUser.set(SECOND_OWNER_ID);
    authFence.set('auth-fence-b');
    continueMutation.resolve();

    await expect(bindPromise).resolves.toBeNull();
    const ownerAPending = await cache.loadPendingLinks('00000000-0000-0000-0000-000000000001');
    expect(ownerAPending).toHaveLength(1);
    expect(await cache.loadLinks('00000000-0000-0000-0000-000000000001'))
      .toEqual([ownerAPending[0].link]);
    expect(await cache.loadPendingLinks(SECOND_OWNER_ID)).toEqual([]);
    expect(await cache.loadLinks(SECOND_OWNER_ID)).toEqual([]);
    expect(service.links()).toEqual([]);
  });

  it('ignores a late ensureLoaded result from a previous owner', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);
    const now = new Date().toISOString();
    const ownerALink = externalSourceLink({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      taskId: 'task-owner-a', targetId: '20260614000000-ownerA', createdAt: now, updatedAt: now });
    const ownerBLink = externalSourceLink({ ...ownerALink, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      taskId: 'task-owner-b', targetId: '20260614000000-ownerB', uri: undefined });
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
      pushLocalNewerLinks(localLinks: ExternalSourceLink[], remoteLinks: ExternalSourceLink[]): Promise<void>;
    };
    const cache = TestBed.inject(ExternalSourceCacheService);
    const now = new Date().toISOString();
    const link = externalSourceLink({ id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      targetId: '20260426123456-def5678', createdAt: now, updatedAt: now });
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
      pushLocalNewerLinks(localLinks: ExternalSourceLink[], remoteLinks: ExternalSourceLink[]): Promise<void>;
    };
    const cache = TestBed.inject(ExternalSourceCacheService);
    const upsertPendingSpy = vi.spyOn(cache, 'upsertPendingLink');
    const removePendingSpy = vi.spyOn(cache, 'removePendingLink');
    const now = new Date().toISOString();
    const link = externalSourceLink({ id: 'eeeeeeee-0000-4000-8000-000000000000',
      taskId: 'task-local-newer', createdAt: now, updatedAt: now });

    await service.pushLocalNewerLinks([link], []);

    const pendingEntry = await upsertPendingSpy.mock.results[0]?.value;
    const payload = upsertPayloads[0] as { payload: Record<string, unknown> };
    expect(upsertPendingSpy).toHaveBeenCalledWith(link, { resetRetryCount: false }, authUser());
    expect(removePendingSpy).toHaveBeenCalledWith(link.id, pendingEntry.operationId, authUser());
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
  it('lets a changed owner wait for the active flight and then flush its own bucket once', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);
    const ownerA = authUser();
    const linkA = externalSourceLink({ id: 'aaaaaaaa-0000-4000-8000-000000000001', taskId: 'task-a' });
    const linkB = externalSourceLink({ id: 'bbbbbbbb-0000-4000-8000-000000000002', taskId: 'task-b' });
    await cache.upsertPendingLink(linkA);
    const gate = createDeferred<UpsertResult>();
    deferredUpsertCall = { index: 1, gate };
    const flushA = service.flushPendingLinks();
    await vi.waitFor(() => expect(upsertCallCount).toBe(1));
    authUser.set(SECOND_OWNER_ID); authFence.set('auth-fence-b');
    await cache.upsertPendingLink(linkB);
    const flushB = service.flushPendingLinks();
    gate.resolve({ error: null });
    await Promise.all([flushA, flushB]);
    expect((await cache.loadPendingLinks(ownerA)).map(entry => entry.link.id)).toEqual([linkA.id]);
    expect(await cache.loadPendingLinks(SECOND_OWNER_ID)).toHaveLength(0);
    expect(upsertAttempts.map(attempt => (attempt.payload as { user_id: string }).user_id))
      .toEqual([ownerA, SECOND_OWNER_ID]);
  });
  it('does not settle a failed A request after A to B to A session changes', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);
    const ownerA = authUser();
    const link = externalSourceLink({ id: 'aaaaaaaa-0000-4000-8000-000000000003' });
    await cache.upsertPendingLink(link);
    const gate = createDeferred<UpsertResult>();
    deferredUpsertCall = { index: 1, gate };
    const flush = service.flushPendingLinks();
    await vi.waitFor(() => expect(upsertCallCount).toBe(1));
    authUser.set(SECOND_OWNER_ID); authFence.set('auth-fence-b');
    authUser.set(ownerA); authFence.set('auth-fence-a-relogin');
    gate.resolve({ error: new Error('offline') });
    await flush;
    expect((await cache.loadPendingLinks(ownerA))[0]).toMatchObject(
      { retryCount: 0, link: { id: link.id, targetId: link.targetId, deletedAt: null } });
    expect(loggerCategoryMock.warn).not.toHaveBeenCalled();
  });
  it('keeps 23505 tombstone settlement out of a newly current owner view', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);
    const ownerA = authUser();
    const link = externalSourceLink({ id: 'aaaaaaaa-0000-4000-8000-000000000004' });
    await cache.upsertPendingLink(link);
    upsertErrorQueue.push({ code: '23505', message: 'duplicate' });
    const gate = createDeferred<UpsertResult>();
    deferredUpsertCall = { index: 2, gate };
    const deletePreview = vi.spyOn(cache, 'deletePreviewsForLink');
    const toastInfo = vi.mocked(TestBed.inject(ToastService).info);
    const flush = service.flushPendingLinks();
    await vi.waitFor(() => expect(upsertCallCount).toBe(2));
    authUser.set(SECOND_OWNER_ID); authFence.set('auth-fence-b');
    gate.resolve({ error: null });
    await flush;
    expect((await cache.loadPendingLinks(ownerA))[0]).toMatchObject(
      { retryCount: 0, link: { id: link.id, targetId: link.targetId, deletedAt: null } });
    expect(await cache.loadLinks(SECOND_OWNER_ID)).toEqual([]);
    expect(deletePreview).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
    expect(selectCallCount).toBe(0);
  });
  it('keeps pushLocalNewerLinks settlement in its captured owner bucket', async () => {
    const service = TestBed.inject(ExternalSourceLinkService) as unknown as {
      pushLocalNewerLinks(local: ExternalSourceLink[], remote: ExternalSourceLink[]): Promise<void>;
    };
    const cache = TestBed.inject(ExternalSourceCacheService);
    const ownerA = authUser();
    const linkA = externalSourceLink({ id: 'aaaaaaaa-0000-4000-8000-000000000005', taskId: 'task-a' });
    const linkB = externalSourceLink({ ...linkA, taskId: 'task-b', targetId: '20260426123456-bbb0002' });
    const gate = createDeferred<UpsertResult>();
    deferredUpsertCall = { index: 1, gate };
    const push = service.pushLocalNewerLinks([linkA], []);
    await vi.waitFor(() => expect(upsertCallCount).toBe(1));
    authUser.set(SECOND_OWNER_ID); authFence.set('auth-fence-b');
    await cache.upsertPendingLink(linkB);
    gate.resolve({ error: null });
    await push;
    expect((await cache.loadPendingLinks(ownerA))[0]).toMatchObject(
      { retryCount: 0, link: { id: linkA.id, taskId: linkA.taskId } });
    expect((await cache.loadPendingLinks(SECOND_OWNER_ID))[0]).toMatchObject(
      { retryCount: 0, link: { id: linkB.id, taskId: linkB.taskId } });
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
    await cache.saveLinks([externalSourceLink({ id: '99999999-9999-4999-8999-999999999999',
      taskId: 'task-local', createdAt: now, updatedAt: now })]);
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
      externalSourceLink({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', taskId: 'task-old',
        targetId: '20250101120000-old0001', deletedAt: ancient, createdAt: ancient, updatedAt: ancient }),
      externalSourceLink({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', taskId: 'task-new',
        targetId: '20260426123456-new0001', createdAt: fresh, updatedAt: fresh }),
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
    getSelectRangeCallCount: () => selectRangeCallCount,
    getSelectCursorValues: () => selectCursorValues,
    getUpsertCallCount: () => upsertCallCount,
    setRemoteRows: (rows) => { remoteRows = rows; },
    setSelectError: (error) => { selectError = error; },
    setUpsertCallCount: (count) => { upsertCallCount = count; },
    setVisibilityState,
  });

  registerExternalSourceLinkResumeSyncSpecs({
    service: () => TestBed.inject(ExternalSourceLinkService),
    cache: () => TestBed.inject(ExternalSourceCacheService),
    createLink: externalSourceLink,
    getUpsertCallCount: () => upsertCallCount,
    setUpsertError: (error) => { upsertError = error; },
    logger: () => loggerCategoryMock,
    setVisibilityState,
  });
});
