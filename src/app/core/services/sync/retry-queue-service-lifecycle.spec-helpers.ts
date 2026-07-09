import { expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import type { RetryOperationHandler, RetryQueueItem, RetryQueueService } from './retry-queue.service';
import { asTimeoutHandle } from './retry-queue-indexeddb.spec-helpers';

type MockFn = ReturnType<typeof vi.fn>;
type SpyInstance = ReturnType<typeof vi.spyOn>;

const SYNC_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RetryQueueServiceLifecycleSpecContext {
  service: RetryQueueService;
  handler: RetryOperationHandler;
  loggerCategory: {
    debug: MockFn;
    warn: MockFn;
  };
  initDbSpy: SpyInstance;
  loadFromStorageSpy: SpyInstance;
  saveToStorageSpy: SpyInstance;
  releaseLeaseMock: MockFn;
  syncWriterLeaseMock: {
    isFeatureEnabled: MockFn;
    requestLease: MockFn;
  };
  destroy(): void;
  setOnline(value: boolean): void;
  createTask(label: string): Task;
}

export function registerRetryQueueServiceLifecycleSpecs(
  getContext: () => RetryQueueServiceLifecycleSpecContext,
): void {
  it('processQueueSlice 在 sync writer lease 开启时应持有 lease 后再 flush 并最终释放', async () => {
    const {
      service,
      handler,
      releaseLeaseMock,
      syncWriterLeaseMock,
      setOnline,
      createTask,
    } = getContext();
    setOnline(true);
    syncWriterLeaseMock.isFeatureEnabled.mockReturnValue(true);
    const task = createTask('leased-task');
    service.add('task', 'upsert', task, 'project-lease', 'test-user');

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(syncWriterLeaseMock.requestLease).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test-user',
      projectId: '__global__',
    }));
    expect(handler.pushTask).toHaveBeenCalledWith(
      task,
      'project-lease',
      'test-user',
      undefined,
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
    expect(releaseLeaseMock).toHaveBeenCalledTimes(1);
  });

  it('processQueueSlice 在等待 sync writer lease 期间销毁后不应继续重放队列', async () => {
    const {
      service,
      handler,
      releaseLeaseMock,
      syncWriterLeaseMock,
      setOnline,
      createTask,
    } = getContext();
    setOnline(true);
    syncWriterLeaseMock.isFeatureEnabled.mockReturnValue(true);
    const task = createTask('lease-destroy-mid-flight');
    service.add('task', 'upsert', task, 'project-lease-destroy', 'test-user');

    let resolveLease: ((handle: {
      tabId: string;
      lockName: string;
      mode: 'memory-only';
      release: typeof releaseLeaseMock;
    }) => void) | null = null;
    syncWriterLeaseMock.requestLease.mockReturnValue(new Promise(resolve => {
      resolveLease = resolve;
    }));

    const processing = service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    await vi.waitFor(() => {
      expect(syncWriterLeaseMock.requestLease).toHaveBeenCalled();
    });

    (service as unknown as { lifecycleClosed: boolean }).lifecycleClosed = true;
    resolveLease!({
      tabId: 'tab-test',
      lockName: 'nanoflow-sync:test:test-user:__global__',
      mode: 'memory-only',
      release: releaseLeaseMock,
    });

    const result = await processing;

    expect(result.processed).toBe(0);
    expect(handler.pushTask).not.toHaveBeenCalled();
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: task.id }),
      }),
    ]);
    expect(releaseLeaseMock).toHaveBeenCalledTimes(1);
    expect((service as unknown as { isProcessingQueue: boolean }).isProcessingQueue).toBe(false);
  });

  it('closeStorageConnections 应清理句柄为 0 的防抖保存', async () => {
    const { service, saveToStorageSpy } = getContext();
    saveToStorageSpy.mockRestore();
    (service as unknown as { saveDebounceTimer: ReturnType<typeof setTimeout> | null }).saveDebounceTimer =
      asTimeoutHandle(0);

    await service.closeStorageConnections();

    expect((service as unknown as { saveDebounceTimer: ReturnType<typeof setTimeout> | null }).saveDebounceTimer).toBeNull();
  });

  it('stopLoop 应清理句柄为 0 的重试循环', () => {
    const { service } = getContext();
    const intervalHandle = 0 as unknown as ReturnType<typeof setInterval>;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(() => intervalHandle);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

    try {
      service.startLoop(1000);
      service.stopLoop();

      expect(clearIntervalSpy).toHaveBeenCalledWith(0);
    } finally {
      (service as unknown as { retryLoopTimer: ReturnType<typeof setInterval> | null }).retryLoopTimer = null;
    }
  });

  it('startLoop 在销毁后不应重新创建重试循环', () => {
    const { service } = getContext();
    const intervalHandle = 1 as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => intervalHandle);
    (service as unknown as { lifecycleClosed: boolean }).lifecycleClosed = true;

    try {
      service.startLoop(1000);

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect((service as unknown as { retryLoopTimer: ReturnType<typeof setInterval> | null }).retryLoopTimer).toBeNull();
    } finally {
      (service as unknown as { retryLoopTimer: ReturnType<typeof setInterval> | null }).retryLoopTimer = null;
    }
  });

  it('startLoop 自运行 tick 中的同步异常不应逃逸到 timer 边界', () => {
    const {
      service,
      handler,
      loggerCategory,
      setOnline,
      createTask,
    } = getContext();
    const scheduledCallbacks: Array<() => void> = [];
    const intervalHandle = 1 as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback: TimerHandler) => {
      scheduledCallbacks.push(callback as () => void);
      return intervalHandle;
    });
    const loopError = new Error('loop status check failed');
    service.add('task', 'upsert', createTask('retry-loop-sync-error'), 'p-loop-error');
    setOnline(true);
    vi.mocked(handler.isOnline).mockImplementation(() => {
      throw loopError;
    });

    try {
      service.startLoop(1000);

      expect(() => scheduledCallbacks[0]?.()).not.toThrow();
      expect(loggerCategory.warn).toHaveBeenCalledWith(
        'RetryQueue 重试循环执行失败',
        loopError,
      );
    } finally {
      service.stopLoop();
      setIntervalSpy.mockRestore();
      (service as unknown as { retryLoopTimer: ReturnType<typeof setInterval> | null }).retryLoopTimer = null;
    }
  });

  it('销毁回调中立即保存失败仍应关闭存储连接并隔离拒绝', async () => {
    const {
      service,
      loggerCategory,
      destroy,
    } = getContext();
    const saveError = new Error('destroy save failed');
    const saveImmediateSpy = vi.spyOn(
      service as unknown as { saveToStorageImmediate: () => Promise<boolean> },
      'saveToStorageImmediate',
    ).mockRejectedValue(saveError);
    const closeStorageConnectionsSpy = vi.spyOn(service, 'closeStorageConnections')
      .mockResolvedValue(undefined);

    destroy();
    await Promise.resolve();
    await Promise.resolve();

    expect(saveImmediateSpy).toHaveBeenCalledTimes(1);
    expect(closeStorageConnectionsSpy).toHaveBeenCalledTimes(1);
    expect(loggerCategory.warn).toHaveBeenCalledWith(
      'RetryQueue 销毁持久化失败，继续关闭存储连接',
      saveError,
    );
  });

  it('销毁回调中关闭存储连接失败不应逃逸到异步边界', async () => {
    const {
      service,
      loggerCategory,
      destroy,
    } = getContext();
    const closeError = new Error('destroy close failed');
    const saveImmediateSpy = vi.spyOn(
      service as unknown as { saveToStorageImmediate: () => Promise<boolean> },
      'saveToStorageImmediate',
    ).mockResolvedValue(true);
    const closeStorageConnectionsSpy = vi.spyOn(service, 'closeStorageConnections')
      .mockRejectedValue(closeError);

    destroy();
    await Promise.resolve();
    await Promise.resolve();

    expect(saveImmediateSpy).toHaveBeenCalledTimes(1);
    expect(closeStorageConnectionsSpy).toHaveBeenCalledTimes(1);
    expect(loggerCategory.warn).toHaveBeenCalledWith(
      'RetryQueue 销毁关闭存储连接失败',
      closeError,
    );
  });

  it('销毁后晚到的构造期存储加载不应重新应用队列项', async () => {
    const {
      service,
      loggerCategory,
      initDbSpy,
      loadFromStorageSpy,
      saveToStorageSpy,
      createTask,
    } = getContext();
    loadFromStorageSpy.mockRestore();
    saveToStorageSpy.mockResolvedValue(undefined);

    let resolveDbInit: ((db: IDBDatabase | null) => void) | null = null;
    initDbSpy.mockReturnValue(new Promise(resolve => {
      resolveDbInit = resolve;
    }));

    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: createTask('t-late-load-after-destroy'),
          projectId: 'p-late-load',
          retryCount: 0,
          createdAt: Date.now(),
          sourceUserId: 'test-user',
          operationId: `test-retry-${crypto.randomUUID()}`,
        } satisfies RetryQueueItem,
      ],
      savedAt: Date.now(),
    }));

    service.reloadFromStorageForCurrentOwner();
    (service as unknown as { lifecycleClosed: boolean }).lifecycleClosed = true;

    resolveDbInit!(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(service.getItems()).toEqual([]);
    expect(loggerCategory.debug).toHaveBeenCalledWith(
      '忽略过期的重试队列加载结果',
      expect.objectContaining({ stage: 'loadFromStorage:init-db' }),
    );
  });
}
