import { expect, it, vi } from 'vitest';

import type { Connection, Task } from '../../../../models';
import type { RetryOperationHandler, RetryQueueItem, RetryQueueService } from './retry-queue.service';
import { registerRetryQueueCapacitySpecs } from './retry-queue-capacity.spec-helpers';
import { registerRetryQueueSliceSpecs } from './retry-queue-slice.spec-helpers';

type MockFn = ReturnType<typeof vi.fn>;
type SpyInstance = ReturnType<typeof vi.spyOn>;

const SYNC_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RetryQueueCapacityAndSliceSpecContext {
  service: RetryQueueService;
  handler: RetryOperationHandler;
  authServiceMock: {
    currentUserId: MockFn;
  };
  initDbSpy: SpyInstance;
  saveToStorageSpy: SpyInstance;
  loggerCategory: {
    info: MockFn;
    warn: MockFn;
    error: MockFn;
    debug: MockFn;
  };
  syncWriterLeaseMock: {
    isFeatureEnabled: MockFn;
    requestLease: MockFn;
  };
  sentryLazyLoaderMock: {
    captureMessage: MockFn;
    captureException: MockFn;
    setTag: MockFn;
    setContext: MockFn;
  };
  toastMock: {
    warning: MockFn;
    error: MockFn;
    info: MockFn;
    success: MockFn;
  };
  setOnline(value: boolean): void;
  createTask(label: string): Task;
  createConnection(label: string, sourceLabel?: string, targetLabel?: string): Connection;
  stableUUID(label: string): string;
  setVisibilityState(state: DocumentVisibilityState): void;
}

export function registerRetryQueueCapacityAndSliceSpecs(
  getContext: () => RetryQueueCapacityAndSliceSpecContext,
): void {
  it('queue_full 压力模式在容量恢复后应自动解锁', () => {
    const { service, createTask, stableUUID } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 3;

    expect(service.add('task', 'upsert', createTask('t-1'), 'p-1')).toBe(true);
    expect(service.add('task', 'upsert', createTask('t-2'), 'p-1')).toBe(true);
    expect(service.add('task', 'upsert', createTask('t-3'), 'p-1')).toBe(true);
    expect(service.add('task', 'upsert', createTask('t-4'), 'p-1')).toBe(true);
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');

    service.removeByEntityId(stableUUID('t-1')); // 3 -> 2
    service.removeByEntityId(stableUUID('t-2')); // 2 -> 1
    expect(service.length).toBe(2);

    (service as unknown as { tryRecoverQueueFullPressure: (force?: boolean) => void }).tryRecoverQueueFullPressure(true);
    expect(service.queuePressure()).toBe(false);
    expect(service.queuePressureReason()).toBeNull();
  });

  it('容量恢复日志异常不应阻断 queue pressure 解锁', () => {
    const { service, loggerCategory, createTask, stableUUID } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 3;
    expect(service.add('task', 'upsert', createTask('pressure-log-1'), 'p-pressure')).toBe(true);
    expect(service.add('task', 'upsert', createTask('pressure-log-2'), 'p-pressure')).toBe(true);
    expect(service.add('task', 'upsert', createTask('pressure-log-3'), 'p-pressure')).toBe(true);
    expect(service.add('task', 'upsert', createTask('pressure-log-4'), 'p-pressure')).toBe(true);
    service.removeByEntityId(stableUUID('pressure-log-1'));
    service.removeByEntityId(stableUUID('pressure-log-2'));
    loggerCategory.info.mockImplementationOnce(() => {
      throw new Error('info failed');
    });

    expect(() => {
      (service as unknown as { handleCapacityRecovered: (currentSize: number) => void })
        .handleCapacityRecovered(service.length);
    }).not.toThrow();

    expect(service.queuePressure()).toBe(false);
    expect(service.queuePressureReason()).toBeNull();
  });

  it('processQueue 出现异常后应释放处理锁并回写状态', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 3;
    service.add('task', 'upsert', createTask('t-1'), 'p-1', undefined, undefined, 'task_full_upsert');
    setOnline(true);

    (service as unknown as { saveToStorage: () => Promise<void> }).saveToStorage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('save crash');
      })
      .mockResolvedValue(undefined) as unknown as () => Promise<void>;

    await service.processQueue();

    expect((service as unknown as { isProcessingQueue: boolean }).isProcessingQueue).toBe(false);
    expect(handler.onProcessingStateChange).toHaveBeenCalledWith(true, 1);
    expect(handler.onProcessingStateChange).toHaveBeenCalledWith(false, 0);
  });

  it('processQueue 过期清扫应把非黑匣子项隔离保留而不是静默删除', async () => {
    // §5.6：24h 过期项停止自动回放（业务边界不变），但必须落 legacy-review
    // 终态证据；此前仅 blackbox 有 conflict 证据，task/project/connection 直接蒸发
    const { service, setOnline, createTask, stableUUID } = getContext();
    service.add('task', 'upsert', createTask('expired-evidence'), 'p-expired', 'test-user');
    const internals = service as unknown as {
      queue: RetryQueueItem[];
      MAX_ITEM_AGE: number;
    };
    internals.queue[0].createdAt = Date.now() - internals.MAX_ITEM_AGE - 1;
    setOnline(true);

    await service.processQueue();

    expect(service.length).toBe(0);
    const legacyReviewRaw = localStorage.getItem('nanoflow.retry-queue.legacy-review.test-user');
    expect(legacyReviewRaw).toContain(stableUUID('expired-evidence'));
  });

  it('离线入口遇到过期处理锁时应先释放锁态且不重放队列', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(250_000);
    service.add('task', 'upsert', createTask('stale-lock-offline'), 'p-stale-lock');
    setOnline(false);
    (service as unknown as { isProcessingQueue: boolean }).isProcessingQueue = true;
    (service as unknown as { lastProcessTime: number }).lastProcessTime = 1;

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.completed).toBe(true);
    expect((service as unknown as { isProcessingQueue: boolean }).isProcessingQueue).toBe(false);
    expect(handler.pushTask).not.toHaveBeenCalled();

    nowSpy.mockRestore();
  });

  it('高水位卡死恢复的 warning 日志异常不应阻断处理锁释放', () => {
    const { service, handler, loggerCategory, setOnline, createTask } = getContext();
    service.add('task', 'upsert', createTask('high-watermark-stuck-lock'), 'p-stuck');
    setOnline(true);
    (service as unknown as { isProcessingQueue: boolean }).isProcessingQueue = true;
    (service as unknown as { lastProcessTime: number }).lastProcessTime = 1;
    (service as unknown as { lastDrainCompletedBySuccess: boolean }).lastDrainCompletedBySuccess = true;
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });

    expect(() => {
      (service as unknown as {
        forceProcessQueueAtHighWatermark: (percentUsed: number, now: number) => void;
      }).forceProcessQueueAtHighWatermark(95, 250_000);
    }).not.toThrow();

    expect((service as unknown as { isProcessingQueue: boolean }).isProcessingQueue).toBe(false);
    expect((service as unknown as { lastDrainCompletedBySuccess: boolean }).lastDrainCompletedBySuccess).toBe(false);
    expect(handler.onProcessingStateChange).toHaveBeenCalledWith(false, 1);
  });

  it('应急队列处理的 info 日志异常不应阻断 processQueue 触发', () => {
    const { service, loggerCategory, setOnline, createTask } = getContext();
    service.add('task', 'upsert', createTask('emergency-process-info-failure'), 'p-emergency');
    setOnline(true);
    const processQueueSpy = vi.spyOn(service, 'processQueue').mockResolvedValue(undefined);
    loggerCategory.info.mockImplementationOnce(() => {
      throw new Error('info failed');
    });

    expect(() => {
      (service as unknown as {
        triggerEmergencyProcessQueue: (trigger: 'queue_full' | 'pressure_reject' | 'high_watermark') => void;
      }).triggerEmergencyProcessQueue('high_watermark');
    }).not.toThrow();

    expect(processQueueSpy).toHaveBeenCalledOnce();
  });

  it('处理切片中被移除的项目重试项不应继续重放', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const firstTask = createTask('t-keep-processing');
    const secondTask = createTask('t-removed-during-slice');
    service.add('task', 'upsert', firstTask, 'p-keep', undefined, undefined, 'task_full_upsert');
    service.add('task', 'upsert', secondTask, 'p-drop', undefined, undefined, 'task_full_upsert');
    setOnline(true);

    (handler.pushTask as MockFn)
      .mockImplementationOnce(async () => {
        service.removeByProjectId('p-drop');
        return true;
      })
      .mockResolvedValue(true);

    await service.processQueueSlice();

    expect(handler.pushTask).toHaveBeenCalledTimes(1);
    expect(handler.pushTask).toHaveBeenCalledWith(
      firstTask,
      'p-keep',
      'test-user',
      'task_full_upsert',
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
    expect(service.getItems().some(item => item.projectId === 'p-drop')).toBe(false);
  });

  it('sync writer lease 获取失败且 warning 日志异常时应延后本轮处理并释放处理状态', async () => {
    const { service, handler, loggerCategory, syncWriterLeaseMock, setOnline, createTask } = getContext();
    const task = createTask('retry-lease-warn-boundary');
    service.add('task', 'upsert', task, 'p-lease');
    setOnline(true);
    syncWriterLeaseMock.isFeatureEnabled.mockReturnValue(true);
    syncWriterLeaseMock.requestLease.mockRejectedValueOnce(new Error('lease unavailable'));
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.completed).toBe(false);
    expect(result.processed).toBe(0);
    expect(result.remaining).toBe(1);
    expect(handler.pushTask).not.toHaveBeenCalled();
    expect(service.getItems().map(item => item.data.id)).toEqual([task.id]);
    expect((service as unknown as { isProcessingQueue: boolean }).isProcessingQueue).toBe(false);
    expect(loggerCategory.error).not.toHaveBeenCalledWith(
      'processQueueSlice 发生未捕获异常',
      expect.any(Error),
    );
  });

  it('sync writer lease 返回 memory-only 时应释放 lease 并延后切片，不发起云端重放', async () => {
    const { service, handler, syncWriterLeaseMock, setOnline, createTask } = getContext();
    const task = createTask('retry-memory-only-lease');
    const releaseMemoryOnlyLease = vi.fn(async () => undefined);
    service.add('task', 'upsert', task, 'p-memory-only');
    const queuedBefore = service.getItems()[0];
    if (!queuedBefore) throw new Error('expected queued retry item');
    setOnline(true);
    syncWriterLeaseMock.isFeatureEnabled.mockReturnValue(true);
    syncWriterLeaseMock.requestLease.mockResolvedValueOnce({
      tabId: 'tab-memory-only',
      lockName: 'nanoflow-sync:test:test-user:__global__',
      mode: 'memory-only' as const,
      signal: new AbortController().signal,
      release: releaseMemoryOnlyLease,
    });

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.completed).toBe(false);
    expect(result.processed).toBe(0);
    expect(result.remaining).toBe(1);
    expect(syncWriterLeaseMock.requestLease).toHaveBeenCalledOnce();
    expect(releaseMemoryOnlyLease).toHaveBeenCalledOnce();
    expect(handler.pushTask).not.toHaveBeenCalled();
    expect(handler.deleteTask).not.toHaveBeenCalled();
    expect(handler.pushProject).not.toHaveBeenCalled();
    expect(handler.pushConnection).not.toHaveBeenCalled();
    expect(handler.pushBlackBoxEntry).not.toHaveBeenCalled();
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        id: queuedBefore.id,
        operationId: queuedBefore.operationId,
        retryCount: queuedBefore.retryCount,
        data: expect.objectContaining({ id: task.id }),
      }),
    ]);
  });

  it('成功重放项的移除未完成持久化确认时应保留在队列中等待后续回放', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const task = createTask('retry-success-persist-failure');
    service.add('task', 'upsert', task, 'p-retry', undefined, undefined, 'task_full_upsert');
    setOnline(true);

    vi.spyOn(service, 'persistNow').mockResolvedValueOnce(false);

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.pushTask).toHaveBeenCalledOnce();
    expect(result.completed).toBe(false);
    expect(result.remaining).toBe(1);
    expect(service.getItems().map(item => item.id)).toEqual([expect.any(String)]);
    expect(service.getItems()[0]?.data.id).toBe(task.id);
  });

  it('成功重放项已有 completion marker 后应只清理本地残留而不再次远端重放', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const task = createTask('retry-success-completion-marker');
    service.add('task', 'upsert', task, 'p-retry', undefined, undefined, 'task_full_upsert');
    setOnline(true);

    vi.spyOn(service, 'persistNow')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const first = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    const second = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.pushTask).toHaveBeenCalledOnce();
    expect(first.completed).toBe(false);
    expect(first.remaining).toBe(1);
    expect(second.completed).toBe(true);
    expect(second.remaining).toBe(0);
    expect(service.getItems()).toEqual([]);
  });

  it('成功重放项的持久化异常应回滚移除并保留在队列中等待后续回放', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const task = createTask('retry-success-persist-throw');
    service.add('task', 'upsert', task, 'p-retry', undefined, undefined, 'task_full_upsert');
    setOnline(true);

    vi.spyOn(service, 'persistNow').mockRejectedValueOnce(new Error('persist crashed'));

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.pushTask).toHaveBeenCalledOnce();
    expect(result.completed).toBe(false);
    expect(result.remaining).toBe(1);
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: task.id }),
      }),
    ]);
  });

  it('removeByProjectId 应同时清理 hidden bucket 中的同项目重试项', () => {
    const { service, createTask } = getContext();
    const visibleTask = createTask('t-visible-remove-by-project');
    const hiddenTask = createTask('t-hidden-remove-by-project');
    service.add('task', 'upsert', visibleTask, 'p-drop');
    service.add('task', 'upsert', hiddenTask, 'p-drop', 'other-user');

    const removed = service.removeByProjectId('p-drop');

    expect(removed).toBe(2);
    expect(service.getItems()).toEqual([]);
    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems).toEqual([]);
  });

  it('removeByEntities 应同时清理 visible 与 hidden bucket 中的同实体重试项', () => {
    const { service, createTask } = getContext();
    const visibleTask = createTask('task-visible-remove-by-entities');
    const hiddenTask = createTask('task-hidden-remove-by-entities');
    const unrelatedTask = createTask('task-keep-remove-by-entities');
    service.add('task', 'upsert', visibleTask, 'p-entities');
    service.add('task', 'delete', hiddenTask, 'p-entities', 'other-user');
    service.add('task', 'upsert', unrelatedTask, 'p-entities');

    const removedTaskIds = service.removeByEntities('task', [visibleTask.id, hiddenTask.id]);

    expect(removedTaskIds).toEqual(expect.arrayContaining([visibleTask.id, hiddenTask.id]));
    expect(removedTaskIds).not.toContain(unrelatedTask.id);
    expect(service.getItems().map(item => item.data.id)).toEqual([unrelatedTask.id]);
    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems).toEqual([]);
  });

  it('removeByEntityId 应同时清理 hidden bucket 中的同实体重试项', () => {
    const { service, createTask } = getContext();
    const visibleTask = createTask('task-remove-by-entity-id');
    const hiddenTask = {
      ...visibleTask,
      title: 'hidden copy should be removed',
    };
    const unrelatedHiddenTask = createTask('task-keep-hidden-remove-by-entity-id');
    service.add('task', 'upsert', visibleTask, 'p-entity-id');
    service.add('task', 'delete', hiddenTask, 'p-entity-id', 'other-user');
    service.add('task', 'upsert', unrelatedHiddenTask, 'p-entity-id', 'other-user');

    service.removeByEntityId(visibleTask.id);

    expect(service.getItems()).toEqual([]);
    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems.map(item => item.data.id))
      .toEqual([unrelatedHiddenTask.id]);
  });

  it('removeConnectionsReferencingTasks 应同时清理 visible 与 hidden 的悬挂连接重试项', () => {
    const { service, createConnection, stableUUID } = getContext();
    const visibleConnection = createConnection('visible-orphan', 'task-deleted', 'task-keep');
    const hiddenConnection = createConnection('hidden-orphan', 'task-keep', 'task-deleted');
    const unrelatedConnection = createConnection('unrelated', 'task-keep-a', 'task-keep-b');
    service.add('connection', 'upsert', visibleConnection, 'p-drop');
    service.add('connection', 'upsert', hiddenConnection, 'p-drop', 'other-user');
    service.add('connection', 'upsert', unrelatedConnection, 'p-drop');

    const removedConnectionIds = service.removeConnectionsReferencingTasks('p-drop', [stableUUID('task-deleted')]);

    expect(removedConnectionIds).toEqual(expect.arrayContaining([visibleConnection.id, hiddenConnection.id]));
    expect(removedConnectionIds).not.toContain(unrelatedConnection.id);
    expect(service.getItems().map(item => item.data.id)).toEqual([unrelatedConnection.id]);
    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems).toEqual([]);
  });

  it('切账号期间已成功的 in-flight 重试项应从 hidden 持久化队列移除', async () => {
    const { service, handler, authServiceMock, initDbSpy, saveToStorageSpy, setOnline, createTask } = getContext();
    initDbSpy.mockResolvedValue(null);
    saveToStorageSpy.mockImplementation(() => {
      (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
      return undefined as unknown as Promise<void>;
    });

    const task = createTask('retry-inflight-success');
    service.add('task', 'upsert', task, 'p-retry', undefined, undefined, 'task_full_upsert');
    const inFlightItemId = service.getItems()[0]?.id;
    setOnline(true);

    let resolvePush: ((value: boolean) => void) | null = null;
    (handler.pushTask as MockFn).mockImplementationOnce(() => new Promise<boolean>(resolve => {
      resolvePush = resolve;
    }));

    const processing = service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    await vi.waitFor(() => {
      expect(handler.pushTask).toHaveBeenCalledOnce();
    });

    authServiceMock.currentUserId.mockReturnValue('other-user');
    service.clearCurrentView();
    resolvePush!(true);
    await processing;

    const persisted = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as {
      items?: RetryQueueItem[];
    };

    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems).toEqual([]);
    expect((persisted.items ?? []).find(item => item.id === inFlightItemId)).toBeUndefined();
  });

  it('切账号期间失败的 in-flight 重试项应保留在 hidden 队列并递增 retryCount', async () => {
    const { service, handler, authServiceMock, initDbSpy, saveToStorageSpy, setOnline, createTask } = getContext();
    initDbSpy.mockResolvedValue(null);
    saveToStorageSpy.mockImplementation(() => {
      (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
      return undefined as unknown as Promise<void>;
    });

    const task = createTask('retry-inflight-failure');
    service.add('task', 'upsert', task, 'p-retry', undefined, undefined, 'task_full_upsert');
    const inFlightItemId = service.getItems()[0]?.id;
    setOnline(true);

    let rejectPush: ((reason?: unknown) => void) | null = null;
    (handler.pushTask as MockFn).mockImplementationOnce(() => new Promise<boolean>((_resolve, reject) => {
      rejectPush = reject;
    }));

    const processing = service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    await vi.waitFor(() => {
      expect(handler.pushTask).toHaveBeenCalledOnce();
    });

    authServiceMock.currentUserId.mockReturnValue('other-user');
    service.clearCurrentView();
    rejectPush!(new Error('network down'));
    await processing;

    const hiddenItems = (service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems;
    const persisted = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as {
      items?: RetryQueueItem[];
    };
    const persistedItem = (persisted.items ?? []).find(item => item.id === inFlightItemId);

    expect(hiddenItems).toHaveLength(1);
    expect(hiddenItems[0]?.retryCount).toBe(1);
    expect(persistedItem?.retryCount).toBe(1);
  });

  it('另一切片在途导致的锁竞争应按未完成上报，保留 remaining 供恢复续跑排空', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    let resolveFirst: ((value: boolean) => void) | null = null;
    service.add('task', 'upsert', createTask('retry-lock-contention-first'), 'p-lock', undefined, undefined, 'task_full_upsert');
    service.add('task', 'upsert', createTask('retry-lock-contention-second'), 'p-lock', undefined, undefined, 'task_full_upsert');
    setOnline(true);

    (handler.pushTask as MockFn).mockImplementationOnce(() => new Promise<boolean>(resolve => {
      resolveFirst = resolve;
    }));

    const firstProcessing = service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    await vi.waitFor(() => {
      expect(handler.pushTask).toHaveBeenCalledTimes(1);
    });

    // 锁被首个切片持有且未超时：并发切片不得谎报"已排空"（completed:true）
    const contended = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(contended.completed).toBe(false);
    expect(contended.remaining).toBe(2);
    expect(contended.processed).toBe(0);

    resolveFirst!(true);
    await firstProcessing;
    expect((service as unknown as { isProcessingQueue: boolean }).isProcessingQueue).toBe(false);
  });

  it('切账号后新的 owner 不应被旧 in-flight 处理锁阻塞', async () => {
    const { service, handler, authServiceMock, setOnline, createTask } = getContext();
    let resolveFirst: ((value: boolean) => void) | null = null;
    const firstTask = createTask('retry-owner-switch-first');
    const secondTask = createTask('retry-owner-switch-second');
    service.add('task', 'upsert', firstTask, 'p-first', undefined, undefined, 'task_full_upsert');
    setOnline(true);

    (handler.pushTask as MockFn)
      .mockImplementationOnce(() => new Promise<boolean>(resolve => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce(true);

    const firstProcessing = service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    await vi.waitFor(() => {
      expect(handler.pushTask).toHaveBeenCalledTimes(1);
    });

    authServiceMock.currentUserId.mockReturnValue('other-user');
    service.clearCurrentView();

    service.add('task', 'upsert', secondTask, 'p-second', undefined, undefined, 'task_full_upsert');
    const secondProcessing = service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    await vi.waitFor(() => {
      expect(handler.pushTask).toHaveBeenCalledTimes(2);
    });

    resolveFirst!(true);
    await firstProcessing;
    await secondProcessing;

    expect((service as unknown as { isProcessingQueue: boolean }).isProcessingQueue).toBe(false);
  });

  registerRetryQueueCapacitySpecs(getContext);
  registerRetryQueueSliceSpecs(getContext);
}
