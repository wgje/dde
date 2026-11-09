import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from '../../../../services/logger.service';
import { SessionRuntimeResetRegistry } from '../../../../services/session-runtime-reset.service';
import { ExternalSourceCacheService } from '../external-source-cache.service';
import type { ExternalSourceLink, LocalSiyuanPreviewCache } from '../external-source.model';
import { SiyuanDirectProvider } from './siyuan-direct-provider';
import { SiyuanExtensionProvider } from './siyuan-extension-provider';
import { SiyuanPreviewService } from './siyuan-preview.service';

describe('SiyuanPreviewService', () => {
  const link: ExternalSourceLink = {
    id: 'link-1',
    taskId: 'task-1',
    sourceType: 'siyuan-block',
    targetId: '20260426123456-abc1234',
    uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
    sortOrder: 0,
    deletedAt: null,
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
  };

  let cachedPreview: LocalSiyuanPreviewCache | null;
  let savePreview: ReturnType<typeof vi.fn>;
  let getPreview: ReturnType<typeof vi.fn>;
  let getBlockPreview: ReturnType<typeof vi.fn>;
  let extensionIsAvailable: ReturnType<typeof vi.fn>;
  let previewGeneration: ReturnType<typeof vi.fn>;
  let pushConfig: ReturnType<typeof vi.fn>;
  let probeConfigStatus: ReturnType<typeof vi.fn>;
  let ownerUserId: string;
  let resetRuntime: ((reason: 'owner-change' | 'clear-local-data') => void) | undefined;

  beforeEach(() => {
    cachedPreview = null;
    ownerUserId = 'user-1';
    resetRuntime = undefined;
    savePreview = vi.fn().mockResolvedValue(true);
    previewGeneration = vi.fn().mockReturnValue(0);
    getPreview = vi.fn().mockImplementation(() => Promise.resolve(cachedPreview));
    getBlockPreview = vi.fn().mockResolvedValue({
      blockId: link.targetId,
      plainText: 'preview text',
      excerpt: 'preview text',
      truncated: false,
    });
    extensionIsAvailable = vi.fn().mockResolvedValue(true);
    pushConfig = vi.fn().mockResolvedValue({ ok: true });
    probeConfigStatus = vi.fn().mockResolvedValue({
      kind: 'ok',
      status: { baseUrl: 'http://127.0.0.1:6806', hasToken: true },
    });

    TestBed.configureTestingModule({
      providers: [
        SiyuanPreviewService,
        {
          provide: ExternalSourceCacheService,
          useValue: {
            ownerId: () => ownerUserId,
            loadConfig: vi.fn().mockResolvedValue({ runtimeMode: 'extension-relay' }),
            getPreview,
            previewGeneration,
            savePreview,
          },
        },
        {
          provide: SiyuanExtensionProvider,
          useValue: {
            isAvailable: extensionIsAvailable,
            getBlockPreview,
            pushConfig,
            getConfigStatus: vi.fn(),
            probeConfigStatus,
            diagnoseConnection: vi.fn(),
          },
        },
        {
          provide: SiyuanDirectProvider,
          useValue: { isAvailable: vi.fn().mockResolvedValue(false) },
        },
        {
          provide: LoggerService,
          useValue: { category: () => ({ debug: vi.fn(), warn: vi.fn() }) },
        },
        {
          provide: SessionRuntimeResetRegistry,
          useValue: {
            register: vi.fn((_owner: string, reset: typeof resetRuntime) => {
              resetRuntime = reset;
              return vi.fn();
            }),
          },
        },
      ],
    });
  });

  it('dedupes concurrent preview refreshes for the same user/link/block key', async () => {
    const service = TestBed.inject(SiyuanPreviewService);

    const [first, second] = await Promise.all([
      service.preview(link),
      service.preview(link),
    ]);

    expect(getBlockPreview).toHaveBeenCalledTimes(1);
    expect(getBlockPreview).toHaveBeenCalledWith(link.targetId, expect.any(AbortSignal), 'user-1');
    expect(savePreview).toHaveBeenCalledTimes(1);
    expect(savePreview).toHaveBeenCalledWith(expect.any(Object), 'user-1', 0);
    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
  });

  it('cancelling one host flight does not abort another host request', async () => {
    const first = createDeferred<{
      blockId: string;
      plainText: string;
      excerpt: string;
      truncated: boolean;
    }>();
    const second = createDeferred<{
      blockId: string;
      plainText: string;
      excerpt: string;
      truncated: boolean;
    }>();
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    const secondLink: ExternalSourceLink = {
      ...link,
      id: 'link-2',
      targetId: '20260426123456-def5678',
      uri: 'siyuan://blocks/20260426123456-def5678',
    };
    getBlockPreview.mockImplementation((blockId: string, signal: AbortSignal) => {
      if (blockId === link.targetId) {
        firstSignal = signal;
        return first.promise;
      }
      secondSignal = signal;
      return second.promise;
    });
    const service = TestBed.inject(SiyuanPreviewService);

    const firstRequest = service.preview(link);
    const secondRequest = service.preview(secondLink);
    await vi.waitFor(() => expect(getBlockPreview).toHaveBeenCalledTimes(2));

    firstRequest.cancel?.();
    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(false);

    first.resolve({
      blockId: link.targetId,
      plainText: 'cancelled A',
      excerpt: 'cancelled A',
      truncated: false,
    });
    second.resolve({
      blockId: secondLink.targetId,
      plainText: 'current B',
      excerpt: 'current B',
      truncated: false,
    });

    await expect(firstRequest).resolves.toEqual({ status: 'loading' });
    await expect(secondRequest).resolves.toMatchObject({
      status: 'ready',
      preview: { linkId: secondLink.id, blockId: secondLink.targetId },
    });
    expect(savePreview).toHaveBeenCalledTimes(1);
    expect(savePreview).toHaveBeenCalledWith(expect.objectContaining({ linkId: secondLink.id }), 'user-1', 0);
  });

  it('keeps a deduped flight alive until its last host subscriber cancels', async () => {
    const pending = createDeferred<{
      blockId: string;
      plainText: string;
      excerpt: string;
      truncated: boolean;
    }>();
    let requestSignal: AbortSignal | undefined;
    getBlockPreview.mockImplementationOnce((_blockId: string, signal: AbortSignal) => {
      requestSignal = signal;
      return pending.promise;
    });
    const service = TestBed.inject(SiyuanPreviewService);

    const firstRequest = service.preview(link);
    const secondRequest = service.preview(link);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    firstRequest.cancel?.();
    expect(requestSignal?.aborted).toBe(false);
    pending.resolve({
      blockId: link.targetId,
      plainText: 'shared result',
      excerpt: 'shared result',
      truncated: false,
    });

    await expect(firstRequest).resolves.toEqual({ status: 'loading' });
    await expect(secondRequest).resolves.toMatchObject({
      status: 'ready',
      preview: { linkId: link.id, blockId: link.targetId },
    });
    expect(getBlockPreview).toHaveBeenCalledTimes(1);
  });

  it('aborts a shared flight only after its last subscriber cancels', async () => {
    let requestSignal: AbortSignal | undefined;
    getBlockPreview.mockImplementationOnce((_blockId: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      requestSignal = signal;
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const service = TestBed.inject(SiyuanPreviewService);

    const firstRequest = service.preview(link);
    const secondRequest = service.preview(link);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    firstRequest.cancel?.();
    expect(requestSignal?.aborted).toBe(false);
    secondRequest.cancel?.();
    expect(requestSignal?.aborted).toBe(true);
    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([
      { status: 'loading' },
      { status: 'loading' },
    ]);
  });

  it('link 删除使缓存 generation 失效时不得把网络预览作为 ready 返回', async () => {
    previewGeneration.mockReturnValue(7);
    savePreview.mockResolvedValueOnce(false);
    const service = TestBed.inject(SiyuanPreviewService);

    const result = await service.preview(link);

    expect(result).toEqual({ status: 'loading' });
    expect(savePreview).toHaveBeenCalledWith(expect.any(Object), 'user-1', 7);
  });

  it('keeps force refresh separate from normal cached refresh requests', async () => {
    const service = TestBed.inject(SiyuanPreviewService);

    await Promise.all([
      service.preview(link),
      service.preview(link, { forceRefresh: true }),
    ]);

    expect(getBlockPreview).toHaveBeenCalledTimes(2);
  });

  it('owner 切换后旧预览请求不得写入新 owner 缓存', async () => {
    const deferred = createDeferred<{
      blockId: string;
      plainText: string;
      excerpt: string;
      truncated: boolean;
    }>();
    getBlockPreview.mockReturnValueOnce(deferred.promise);
    const service = TestBed.inject(SiyuanPreviewService);

    const pending = service.preview(link);
    await vi.waitFor(() => expect(getBlockPreview).toHaveBeenCalledTimes(1));
    ownerUserId = 'user-2';
    deferred.resolve({
      blockId: link.targetId,
      plainText: 'owner-a preview',
      excerpt: 'owner-a preview',
      truncated: false,
    });

    const result = await pending;

    expect(result.status).toBe('loading');
    expect(savePreview).not.toHaveBeenCalled();
  });

  it('owner 切换发生在 provider 探测期间时不得返回旧 owner 的缓存降级结果', async () => {
    cachedPreview = {
      blockId: link.targetId,
      linkId: link.id,
      plainText: 'owner-a cache',
      excerpt: 'owner-a cache',
      truncated: false,
      fetchedAt: '2026-05-18T00:00:00.000Z',
      fetchStatus: 'ready',
    };
    const availability = createDeferred<boolean>();
    extensionIsAvailable.mockReturnValueOnce(availability.promise);
    const service = TestBed.inject(SiyuanPreviewService);

    const pending = service.preview(link, { forceRefresh: true });
    await vi.waitFor(() => expect(extensionIsAvailable).toHaveBeenCalledTimes(1));
    ownerUserId = 'user-2';
    availability.resolve(false);

    expect(await pending).toEqual({ status: 'loading' });
    expect(getBlockPreview).not.toHaveBeenCalled();
    expect(savePreview).not.toHaveBeenCalled();
  });

  it('写入 relay 配置必须绑定 captured owner，迟到 A 结果不得成为 B 的成功状态', async () => {
    const deferred = createDeferred<{ ok: boolean }>();
    pushConfig.mockReturnValueOnce(deferred.promise);
    const service = TestBed.inject(SiyuanPreviewService);

    const pending = service.pushExtensionConfig({
      baseUrl: 'http://127.0.0.1:6806',
      token: 'owner-a-token',
    });
    await vi.waitFor(() => expect(pushConfig).toHaveBeenCalledTimes(1));
    ownerUserId = 'user-2';
    deferred.resolve({ ok: true });

    expect(await pending).toEqual({ ok: false, errorCode: 'not-configured' });
    expect(pushConfig).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:6806',
      token: 'owner-a-token',
    }, 'user-1', expect.any(Number));
  });

  it('A-B-A 配置写入必须携带单调递增的 issuedAt，旧请求不得覆盖新请求', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const service = TestBed.inject(SiyuanPreviewService);

    const first = service.pushExtensionConfig({
      baseUrl: 'http://127.0.0.1:6806',
      token: 'old-a-token',
    });
    ownerUserId = 'user-2';
    ownerUserId = 'user-1';
    const second = service.pushExtensionConfig({
      baseUrl: 'http://127.0.0.1:6806',
      token: 'new-a-token',
    });

    await Promise.all([first, second]);

    expect(pushConfig.mock.calls[0]?.[2]).toBe(1_000);
    expect(pushConfig.mock.calls[1]?.[2]).toBe(1_001);
  });

  it('读取 relay 状态必须绑定 captured owner，owner 切换后丢弃迟到状态', async () => {
    const deferred = createDeferred<{
      kind: 'ok';
      status: { baseUrl: string; hasToken: boolean };
    }>();
    probeConfigStatus.mockReturnValueOnce(deferred.promise);
    const service = TestBed.inject(SiyuanPreviewService);

    const pending = service.probeExtensionConfigStatus();
    await vi.waitFor(() => expect(probeConfigStatus).toHaveBeenCalledTimes(1));
    ownerUserId = 'user-2';
    deferred.resolve({
      kind: 'ok',
      status: { baseUrl: 'http://127.0.0.1:6806', hasToken: true },
    });

    expect(await pending).toEqual({ kind: 'unavailable' });
    expect(probeConfigStatus).toHaveBeenCalledWith('user-1');
  });

  it('session reset 应 abort 所有 host 预览请求并让晚到结果失效', async () => {
    const requestSignals: AbortSignal[] = [];
    getBlockPreview.mockImplementation((blockId: string, signal: AbortSignal) => {
      requestSignals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });
    const service = TestBed.inject(SiyuanPreviewService);
    const secondLink: ExternalSourceLink = {
      ...link,
      id: 'link-2',
      targetId: '20260426123456-def5678',
      uri: 'siyuan://blocks/20260426123456-def5678',
    };

    const pending = [service.preview(link), service.preview(secondLink)];
    await vi.waitFor(() => expect(getBlockPreview).toHaveBeenCalledTimes(2));
    expect(resetRuntime).toBeTypeOf('function');

    resetRuntime?.('owner-change');

    expect(requestSignals).toHaveLength(2);
    expect(requestSignals.every(signal => signal.aborted)).toBe(true);
    await expect(Promise.all(pending)).resolves.toEqual([
      { status: 'loading' },
      { status: 'loading' },
    ]);
  });

  it('clear-local-data reset 发生在缓存读取期间时不得返回旧缓存或启动刷新', async () => {
    const cacheRead = createDeferred<LocalSiyuanPreviewCache | null>();
    getPreview.mockReturnValueOnce(cacheRead.promise);
    const service = TestBed.inject(SiyuanPreviewService);

    const pending = service.preview(link);
    await vi.waitFor(() => expect(getPreview).toHaveBeenCalledTimes(1));
    resetRuntime?.('clear-local-data');
    cacheRead.resolve(createCachedPreview('stale-after-clear'));

    expect(await pending).toEqual({ status: 'loading' });
    expect(extensionIsAvailable).not.toHaveBeenCalled();
    expect(getBlockPreview).not.toHaveBeenCalled();
  });

  it('A-B-A reset 发生在缓存读取期间时不得接受旧 owner generation 的缓存', async () => {
    const cacheRead = createDeferred<LocalSiyuanPreviewCache | null>();
    getPreview.mockReturnValueOnce(cacheRead.promise);
    const service = TestBed.inject(SiyuanPreviewService);

    const pending = service.preview(link);
    await vi.waitFor(() => expect(getPreview).toHaveBeenCalledTimes(1));
    ownerUserId = 'user-2';
    resetRuntime?.('owner-change');
    ownerUserId = 'user-1';
    cacheRead.resolve(createCachedPreview('stale-after-a-b-a'));

    expect(await pending).toEqual({ status: 'loading' });
    expect(extensionIsAvailable).not.toHaveBeenCalled();
    expect(getBlockPreview).not.toHaveBeenCalled();
  });

  it('abortActive 发生在缓存读取期间时不得在调用方销毁后返回旧缓存', async () => {
    const cacheRead = createDeferred<LocalSiyuanPreviewCache | null>();
    getPreview.mockReturnValueOnce(cacheRead.promise);
    const service = TestBed.inject(SiyuanPreviewService);

    const pending = service.preview(link);
    await vi.waitFor(() => expect(getPreview).toHaveBeenCalledTimes(1));
    service.abortActive();
    cacheRead.resolve(createCachedPreview('stale-after-destroy'));

    expect(await pending).toEqual({ status: 'loading' });
    expect(extensionIsAvailable).not.toHaveBeenCalled();
    expect(getBlockPreview).not.toHaveBeenCalled();
  });

  it('A-B-A reset 后旧请求 finally 不得删除新 owner 请求的去重槽', async () => {
    const first = createDeferred<{
      blockId: string;
      plainText: string;
      excerpt: string;
      truncated: boolean;
    }>();
    const second = createDeferred<{
      blockId: string;
      plainText: string;
      excerpt: string;
      truncated: boolean;
    }>();
    getBlockPreview
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const service = TestBed.inject(SiyuanPreviewService);

    const staleRequest = service.preview(link);
    await vi.waitFor(() => expect(getBlockPreview).toHaveBeenCalledTimes(1));
    ownerUserId = 'user-2';
    resetRuntime?.('owner-change');
    ownerUserId = 'user-1';
    const currentRequest = service.preview(link);
    await vi.waitFor(() => expect(getBlockPreview).toHaveBeenCalledTimes(2));

    first.resolve({
      blockId: link.targetId,
      plainText: 'stale',
      excerpt: 'stale',
      truncated: false,
    });
    await staleRequest;
    const dedupedCurrentRequest = service.preview(link);
    await Promise.resolve();
    expect(getBlockPreview).toHaveBeenCalledTimes(2);

    second.resolve({
      blockId: link.targetId,
      plainText: 'current',
      excerpt: 'current',
      truncated: false,
    });

    expect((await currentRequest).status).toBe('ready');
    expect((await dedupedCurrentRequest).status).toBe('ready');
    expect(getBlockPreview).toHaveBeenCalledTimes(2);
  });
});

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

function createCachedPreview(plainText: string): LocalSiyuanPreviewCache {
  return {
    blockId: '20260426123456-abc1234',
    linkId: 'link-1',
    plainText,
    excerpt: plainText,
    truncated: false,
    fetchedAt: new Date().toISOString(),
    fetchStatus: 'ready',
  };
}
