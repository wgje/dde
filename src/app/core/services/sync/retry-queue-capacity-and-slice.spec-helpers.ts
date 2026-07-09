import { expect, it, vi } from 'vitest';

import type { Connection, Task } from '../../../../models';
import {
  createBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { createRetryDeferredError } from '../../../../utils/retry-deferred-error';
import type { RetryOperationHandler, RetryQueueItem, RetryQueueService } from './retry-queue.service';

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
    service.add('task', 'upsert', createTask('t-1'), 'p-1');
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
    service.add('task', 'upsert', firstTask, 'p-keep');
    service.add('task', 'upsert', secondTask, 'p-drop');
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
      undefined,
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

  it('成功重放项的移除未完成持久化确认时应保留在队列中等待后续回放', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const task = createTask('retry-success-persist-failure');
    service.add('task', 'upsert', task, 'p-retry');
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
    service.add('task', 'upsert', task, 'p-retry');
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
    service.add('task', 'upsert', task, 'p-retry');
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
    service.add('task', 'upsert', task, 'p-retry');
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
    service.add('task', 'upsert', task, 'p-retry');
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
    service.add('task', 'upsert', createTask('retry-lock-contention-first'), 'p-lock');
    service.add('task', 'upsert', createTask('retry-lock-contention-second'), 'p-lock');
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
    service.add('task', 'upsert', firstTask, 'p-first');
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

    service.add('task', 'upsert', secondTask, 'p-second');
    const secondProcessing = service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    await vi.waitFor(() => {
      expect(handler.pushTask).toHaveBeenCalledTimes(2);
    });

    resolveFirst!(true);
    await firstProcessing;
    await secondProcessing;

    expect((service as unknown as { isProcessingQueue: boolean }).isProcessingQueue).toBe(false);
  });

  it('满队列进入压力模式后，在线状态应触发应急处理并继续入队', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;

    expect(service.add('task', 'upsert', createTask('t-1'), 'p-1')).toBe(true);
    setOnline(true);

    expect(service.add('task', 'upsert', createTask('t-2'), 'p-1')).toBe(true);
    expect(service.queuePressure()).toBe(true);

    await vi.waitFor(() => {
      expect(handler.pushTask).toHaveBeenCalledTimes(1);
    }, { timeout: 200, interval: 10 });
    expect(service.length).toBe(1);

    await service.processQueue();
    expect(handler.pushTask).toHaveBeenCalledTimes(2);
    expect(service.length).toBe(0);
  });

  it('queue_full 压力模式下应允许同实体更新覆盖（不视为新增入队）', () => {
    const { service, toastMock, setOnline, createTask, stableUUID } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 2;
    setOnline(false);

    expect(service.add('task', 'upsert', createTask('t-1'), 'p-1')).toBe(true);
    expect(service.add('task', 'upsert', createTask('t-2'), 'p-1')).toBe(true);

    expect(service.add('task', 'upsert', createTask('t-3'), 'p-1')).toBe(true);
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');

    toastMock.warning.mockClear();

    const updated = createTask('t-1');
    updated.title = 'Task t-1 updated';

    expect(service.add('task', 'upsert', updated, 'p-1')).toBe(true);
    expect(service.length).toBe(3);
    expect(service.getItems().find(item => item.data.id === stableUUID('t-1'))?.data).toEqual(updated);
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('缺失 ID 的入队拒绝日志异常不应阻断 add 返回 false', () => {
    const { service, loggerCategory, createTask } = getContext();
    const task = { ...createTask('missing-id-boundary'), id: '' };
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });
    let accepted = true;

    expect(() => {
      accepted = service.add('task', 'upsert', task, 'p-pressure');
    }).not.toThrow();

    expect(accepted).toBe(false);
    expect(service.length).toBe(0);
  });

  it('非法 UUID 的入队拒绝日志异常不应阻断 add 返回 false', () => {
    const { service, loggerCategory, createTask } = getContext();
    const task = { ...createTask('invalid-id-boundary'), id: 'not-a-uuid' };
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });
    let accepted = true;

    expect(() => {
      accepted = service.add('task', 'upsert', task, 'p-pressure');
    }).not.toThrow();

    expect(accepted).toBe(false);
    expect(service.length).toBe(0);
  });

  it('软上限压力模式 warning 异常不应阻断 add 入队和应急处理', () => {
    const { service, loggerCategory, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(true);
    const processQueueSpy = vi.spyOn(service, 'processQueue').mockResolvedValue(undefined);
    expect(service.add('task', 'upsert', createTask('soft-limit-warn-1'), 'p-pressure')).toBe(true);
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });
    let accepted = false;

    expect(() => {
      accepted = service.add('task', 'upsert', createTask('soft-limit-warn-2'), 'p-pressure');
    }).not.toThrow();

    expect(accepted).toBe(true);
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');
    expect(service.length).toBe(2);
    expect(processQueueSpy).toHaveBeenCalled();
  });

  it('压力模式续加入 warning 异常不应阻断 add 入队和应急处理', () => {
    const { service, loggerCategory, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(true);
    const processQueueSpy = vi.spyOn(service, 'processQueue').mockResolvedValue(undefined);
    expect(service.add('task', 'upsert', createTask('pressure-warn-1'), 'p-pressure')).toBe(true);
    expect(service.add('task', 'upsert', createTask('pressure-warn-2'), 'p-pressure')).toBe(true);
    processQueueSpy.mockClear();
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });
    let accepted = false;

    expect(() => {
      accepted = service.add('task', 'upsert', createTask('pressure-warn-3'), 'p-pressure');
    }).not.toThrow();

    expect(accepted).toBe(true);
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');
    expect(service.length).toBe(3);
    expect(processQueueSpy).toHaveBeenCalled();
  });

  it('进入 queue_full 压力模式的 Sentry tag 异常不应阻断 add 入队', () => {
    const { service, sentryLazyLoaderMock, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(false);
    expect(service.add('task', 'upsert', createTask('pressure-tag-1'), 'p-pressure')).toBe(true);
    sentryLazyLoaderMock.setTag.mockImplementationOnce(() => {
      throw new Error('setTag failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('pressure-tag-2'), 'p-pressure');
    }).not.toThrow();

    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');
    expect(service.length).toBe(2);
  });

  it('进入 queue_full 压力模式的 Sentry context 异常不应阻断 add 入队', () => {
    const { service, sentryLazyLoaderMock, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(false);
    expect(service.add('task', 'upsert', createTask('pressure-context-1'), 'p-pressure')).toBe(true);
    sentryLazyLoaderMock.setContext.mockImplementationOnce(() => {
      throw new Error('setContext failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('pressure-context-2'), 'p-pressure');
    }).not.toThrow();

    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');
    expect(service.length).toBe(2);
  });

  it('退出 queue_full 压力模式的 Sentry tag 异常不应阻断解锁', () => {
    const { service, sentryLazyLoaderMock, setOnline, createTask, stableUUID } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 3;
    setOnline(false);
    expect(service.add('task', 'upsert', createTask('pressure-clear-tag-1'), 'p-pressure')).toBe(true);
    expect(service.add('task', 'upsert', createTask('pressure-clear-tag-2'), 'p-pressure')).toBe(true);
    expect(service.add('task', 'upsert', createTask('pressure-clear-tag-3'), 'p-pressure')).toBe(true);
    expect(service.add('task', 'upsert', createTask('pressure-clear-tag-4'), 'p-pressure')).toBe(true);
    expect(service.queuePressure()).toBe(true);
    service.removeByEntityId(stableUUID('pressure-clear-tag-1'));
    service.removeByEntityId(stableUUID('pressure-clear-tag-2'));
    sentryLazyLoaderMock.setTag.mockImplementationOnce(() => {
      throw new Error('setTag failed');
    });

    expect(() => {
      (service as unknown as { tryRecoverQueueFullPressure: (force?: boolean) => void }).tryRecoverQueueFullPressure(true);
    }).not.toThrow();

    expect(service.queuePressure()).toBe(false);
    expect(service.queuePressureReason()).toBeNull();
  });

  it('storage 压力恢复后应自动退出压力模式', () => {
    const { service } = getContext();
    (service as unknown as { enterPressureMode: (reason: string) => void }).enterPressureMode('storage_quota_exceeded');
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('storage_quota_exceeded');

    (service as unknown as { tryRecoverQueueFullPressure: (force?: boolean) => void }).tryRecoverQueueFullPressure(true);

    expect(service.queuePressure()).toBe(false);
    expect(service.queuePressureReason()).toBeNull();
  });

  it('storage 压力恢复日志异常不应阻断压力模式退出', () => {
    const { service, loggerCategory } = getContext();
    (service as unknown as { enterPressureMode: (reason: string) => void }).enterPressureMode('storage_quota_exceeded');
    loggerCategory.info.mockImplementationOnce(() => {
      throw new Error('info failed');
    });

    expect(() => {
      (service as unknown as { tryRecoverQueueFullPressure: (force?: boolean) => void }).tryRecoverQueueFullPressure(true);
    }).not.toThrow();

    expect(service.queuePressure()).toBe(false);
    expect(service.queuePressureReason()).toBeNull();
  });

  it('getCapacityPercent 应返回正确的容量百分比', () => {
    const { service, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 10;

    expect(service.getCapacityPercent()).toBe(0);

    service.add('task', 'upsert', createTask('t-1'), 'p-1');
    service.add('task', 'upsert', createTask('t-2'), 'p-1');
    service.add('task', 'upsert', createTask('t-3'), 'p-1');

    expect(service.getCapacityPercent()).toBe(30);
  });

  it('getCapacityPercent 队列满时应返回 100 或更高', () => {
    const { service, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 2;

    service.add('task', 'upsert', createTask('t-1'), 'p-1');
    service.add('task', 'upsert', createTask('t-2'), 'p-1');

    expect(service.getCapacityPercent()).toBeGreaterThanOrEqual(100);
  });

  it('checkCapacityWarning 在 80%+ 时应记录日志（WARNING_THRESHOLD=0.8）', () => {
    const { service, loggerCategory, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 10;
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;

    for (let i = 0; i < 8; i += 1) {
      service.add('task', 'upsert', createTask(`cap-${i}`), 'p-1');
    }

    expect(loggerCategory.warn).toHaveBeenCalled();
  });

  it('80% 容量告警日志异常不应阻断 add 入队', () => {
    const { service, loggerCategory, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 10;
    (service as unknown as { lastWarningTime: number }).lastWarningTime = Date.now();
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 80;
    for (let i = 0; i < 7; i += 1) {
      service.add('task', 'upsert', createTask(`warn-log-boundary-${i}`), 'p-capacity');
    }
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('warn-log-boundary-7'), 'p-capacity');
    }).not.toThrow();

    expect(service.length).toBe(8);
  });

  it('85% 容量告警 toast 异常不应阻断 add 入队', () => {
    const { service, toastMock, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 20;
    (service as unknown as { lastWarningTime: number }).lastWarningTime = Date.now();
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 80;
    for (let i = 0; i < 16; i += 1) {
      service.add('task', 'upsert', createTask(`toast-boundary-${i}`), 'p-capacity');
    }
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    toastMock.warning.mockImplementationOnce(() => {
      throw new Error('toast failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('toast-boundary-16'), 'p-capacity');
    }).not.toThrow();

    expect(service.length).toBe(17);
  });

  it('checkCapacityWarning 在 95%+ 时应触发 error 级别日志', () => {
    const { service, loggerCategory, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 20;

    for (let i = 0; i < 19; i += 1) {
      service.add('task', 'upsert', createTask(`crit-${i}`), 'p-1');
    }

    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    loggerCategory.error.mockClear();

    service.checkCapacityWarning();

    expect(loggerCategory.error).toHaveBeenCalled();
  });

  it('95% 容量告警 error 日志异常不应阻断 add 入队', () => {
    const { service, loggerCategory, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 20;
    (service as unknown as { lastWarningTime: number }).lastWarningTime = Date.now();
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 90;
    for (let i = 0; i < 18; i += 1) {
      service.add('task', 'upsert', createTask(`error-log-boundary-${i}`), 'p-capacity');
    }
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    loggerCategory.error.mockImplementationOnce(() => {
      throw new Error('error failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('error-log-boundary-18'), 'p-capacity');
    }).not.toThrow();

    expect(service.length).toBe(19);
  });

  it('95% 容量告警 toast 异常不应阻断 add 入队', () => {
    const { service, toastMock, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 20;
    (service as unknown as { lastWarningTime: number }).lastWarningTime = Date.now();
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 90;
    for (let i = 0; i < 18; i += 1) {
      service.add('task', 'upsert', createTask(`error-toast-boundary-${i}`), 'p-capacity');
    }
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    toastMock.error.mockImplementationOnce(() => {
      throw new Error('toast failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('error-toast-boundary-18'), 'p-capacity');
    }).not.toThrow();

    expect(service.length).toBe(19);
  });

  it('95% 容量告警 Sentry 异常不应阻断 add 入队', () => {
    const { service, sentryLazyLoaderMock, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 20;
    (service as unknown as { lastWarningTime: number }).lastWarningTime = Date.now();
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 90;
    for (let i = 0; i < 18; i += 1) {
      service.add('task', 'upsert', createTask(`sentry-boundary-${i}`), 'p-capacity');
    }
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    sentryLazyLoaderMock.captureMessage.mockImplementationOnce(() => {
      throw new Error('sentry failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('sentry-boundary-18'), 'p-capacity');
    }).not.toThrow();

    expect(service.length).toBe(19);
  });

  it('absolute limit 拒绝入队日志异常不应阻断 add 返回 false', () => {
    const { service, loggerCategory, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(false);
    for (let i = 0; i < 5; i += 1) {
      expect(service.add('task', 'upsert', createTask(`reject-log-boundary-${i}`), 'p-capacity')).toBe(true);
    }
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });
    let accepted = true;

    expect(() => {
      accepted = service.add('task', 'upsert', createTask('reject-log-boundary-5'), 'p-capacity');
    }).not.toThrow();

    expect(accepted).toBe(false);
    expect(service.length).toBe(5);
  });

  it('absolute limit 拒绝入队 toast 异常不应阻断 add 返回 false', () => {
    const { service, toastMock, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(false);
    for (let i = 0; i < 5; i += 1) {
      expect(service.add('task', 'upsert', createTask(`reject-toast-boundary-${i}`), 'p-capacity')).toBe(true);
    }
    toastMock.warning.mockImplementationOnce(() => {
      throw new Error('toast failed');
    });
    let accepted = true;

    expect(() => {
      accepted = service.add('task', 'upsert', createTask('reject-toast-boundary-5'), 'p-capacity');
    }).not.toThrow();

    expect(accepted).toBe(false);
    expect(service.length).toBe(5);
  });

  it('absolute limit 拒绝入队 Sentry 异常不应阻断 add 返回 false', () => {
    const { service, sentryLazyLoaderMock, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(false);
    for (let i = 0; i < 5; i += 1) {
      expect(service.add('task', 'upsert', createTask(`reject-sentry-boundary-${i}`), 'p-capacity')).toBe(true);
    }
    sentryLazyLoaderMock.captureMessage.mockImplementationOnce(() => {
      throw new Error('sentry failed');
    });
    let accepted = true;

    expect(() => {
      accepted = service.add('task', 'upsert', createTask('reject-sentry-boundary-5'), 'p-capacity');
    }).not.toThrow();

    expect(accepted).toBe(false);
    expect(service.length).toBe(5);
  });

  it('processQueueSlice 应按 maxItems 切片并返回未完成状态', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    service.add('task', 'upsert', createTask('slice-1'), 'p-1');
    service.add('task', 'upsert', createTask('slice-2'), 'p-1');
    service.add('task', 'upsert', createTask('slice-3'), 'p-1');
    setOnline(true);

    const result = await service.processQueueSlice({ maxItems: 2, maxDurationMs: 1000 });

    expect(result.processed).toBe(2);
    expect(result.completed).toBe(false);
    expect(result.remaining).toBe(1);
    expect(handler.pushTask).toHaveBeenCalledTimes(2);
  });

  it('processQueueSlice 应按 maxDurationMs 切片并可续跑完成', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    let fakeNow = 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    (handler.pushTask as MockFn).mockImplementation(async () => {
      fakeNow += 220;
      return true;
    });

    service.add('task', 'upsert', createTask('budget-1'), 'p-1');
    service.add('task', 'upsert', createTask('budget-2'), 'p-1');
    service.add('task', 'upsert', createTask('budget-3'), 'p-1');
    setOnline(true);

    const first = await service.processQueueSlice({ maxItems: 30, maxDurationMs: 150 });
    expect(first.processed).toBe(1);
    expect(first.completed).toBe(false);
    expect(first.remaining).toBe(2);

    const second = await service.processQueueSlice({ maxItems: 30, maxDurationMs: 150 });
    expect(second.processed).toBe(1);
    expect(second.completed).toBe(false);
    expect(second.remaining).toBe(1);

    const third = await service.processQueueSlice({ maxItems: 30, maxDurationMs: 150 });
    expect(third.processed).toBe(1);
    expect(third.completed).toBe(true);
    expect(third.remaining).toBe(0);

    nowSpy.mockRestore();
  });

  it('processQueueSlice 遇到浏览器网络挂起异常时不应消耗 retry budget', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const recordCircuitFailureSpy = vi.spyOn(service, 'recordCircuitFailure');
    const task = createTask('suspended-retry-item');
    service.add('task', 'upsert', task, 'p-1');
    setOnline(true);
    (handler.pushTask as MockFn).mockRejectedValueOnce(createBrowserNetworkSuspendedError());

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(result.completed).toBe(false);
    expect(recordCircuitFailureSpy).not.toHaveBeenCalled();
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: task.id }),
        retryCount: 0,
      }),
    ]);
  });

  it('processQueueSlice 遇到受控延后异常时应保留队列项且不消耗 retry budget', async () => {
    const { service, handler, setOnline, stableUUID } = getContext();
    const recordCircuitFailureSpy = vi.spyOn(service, 'recordCircuitFailure');
    const connection: Connection = {
      id: stableUUID('deferred-connection-retry-item'),
      source: stableUUID('deferred-source-task'),
      target: stableUUID('deferred-target-task'),
    };
    service.add('connection', 'upsert', connection, 'p-1');
    setOnline(true);
    (handler.pushConnection as MockFn).mockRejectedValueOnce(
      createRetryDeferredError('connection remote newer; waiting for pull merge'),
    );

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(result.completed).toBe(false);
    expect(recordCircuitFailureSpy).not.toHaveBeenCalled();
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: connection.id }),
        retryCount: 0,
      }),
    ]);
  });

  it('manual processQueue 应等待恢复保护期结束后再重放', async () => {
    const { service, handler, setOnline, setVisibilityState, createTask } = getContext();
    vi.useFakeTimers();
    try {
      const task = createTask('manual-suspended-wait');
      service.add('task', 'upsert', task, 'p-1');
      setOnline(true);

      expect(isBrowserNetworkSuspendedWindow()).toBe(false);
      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(isBrowserNetworkSuspendedWindow()).toBe(true);

      const processPromise = service.processQueue(undefined, true);
      expect(handler.pushTask).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1499);
      expect(handler.pushTask).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await processPromise;

      expect(handler.pushTask).toHaveBeenCalledOnce();
      expect(service.getItems()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
}
