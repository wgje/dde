import { expect, it, vi } from 'vitest';

import type { RetryQueueItem, RetryQueueService } from './retry-queue.service';
import { asTimeoutHandle } from './retry-queue-indexeddb.spec-helpers';
import {
  createRetryQueueServiceSpecHarness,
  type RetryQueueServiceSpecHarness,
} from './retry-queue-service.spec-fixture';
import { createTask } from './retry-queue-test-data.spec-helpers';

export interface RetryQueueStorageLifecycleSpecContext {
  service: RetryQueueService;
  loggerCategory: RetryQueueServiceSpecHarness['loggerCategory'];
  loadFromStorageSpy: RetryQueueServiceSpecHarness['loadFromStorageSpy'];
  saveToStorageSpy: RetryQueueServiceSpecHarness['saveToStorageSpy'];
}

export function registerRetryQueueStorageLifecycleSpecs(
  loadContext: () => RetryQueueStorageLifecycleSpecContext,
): void {
  const flushMicrotasks = async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
    }
  };

  it('构造期 initDb 失败时应记录并跳过启动加载，避免未处理拒绝', async () => {
    const { loadFromStorageSpy } = loadContext();
    await Promise.resolve();
    await Promise.resolve();
    loadFromStorageSpy.mockClear();

    const initError = new Error('constructor init db failed');
    const failingHarness = createRetryQueueServiceSpecHarness({
      initDb: () => Promise.reject(initError),
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(failingHarness.loadFromStorageSpy).not.toHaveBeenCalled();
    expect(failingHarness.loggerCategory.warn).toHaveBeenCalledWith(
      'RetryQueue 初始化加载失败，已跳过本次启动加载',
      initError,
    );
  });

  it('构造期 loadFromStorage 失败时应记录并继续服务生命周期', async () => {
    const { loadFromStorageSpy } = loadContext();
    await Promise.resolve();
    await Promise.resolve();
    loadFromStorageSpy.mockClear();

    const loadError = new Error('constructor load failed');
    const failingHarness = createRetryQueueServiceSpecHarness({
      loadFromStorage: () => Promise.reject(loadError),
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(failingHarness.loadFromStorageSpy).toHaveBeenCalledTimes(1);
    expect(failingHarness.loggerCategory.warn).toHaveBeenCalledWith(
      'RetryQueue 初始化加载失败，已跳过本次启动加载',
      loadError,
    );
  });

  it('owner reload 的异步 loadFromStorage 失败时应保留清空后的视图并记录', async () => {
    const { service, loggerCategory, loadFromStorageSpy } = loadContext();
    const loadError = new Error('owner reload load failed');
    const task = createTask('owner-reload-load-failed');
    await flushMicrotasks();
    loadFromStorageSpy.mockClear();
    loadFromStorageSpy.mockRejectedValueOnce(loadError);

    service.add('task', 'upsert', task, 'p-owner-reload');
    expect(service.getItems().map(item => item.data.id)).toEqual([task.id]);

    expect(() => service.reloadFromStorageForCurrentOwner()).not.toThrow();
    await flushMicrotasks();

    expect(loadFromStorageSpy).toHaveBeenCalledTimes(1);
    expect(service.getItems()).toEqual([]);
    expect(loggerCategory.warn).toHaveBeenCalledWith(
      'RetryQueue owner 队列重新加载失败，已保留清空后的当前视图',
      loadError,
    );
  });

  it('addDurably 回滚后应重新挂起已恢复队列的防抖持久化', async () => {
    const { service, saveToStorageSpy } = loadContext();
    saveToStorageSpy.mockRestore();
    const existingTask = createTask('existing-pending-persist');
    const failedTask = createTask('durable-persist-failure');

    service.add('task', 'upsert', existingTask, 'p-1');
    const originalTimer = getSaveDebounceTimer(service);
    expect(originalTimer).not.toBeNull();

    getStorageInternals(service).saveToStorageImmediate = vi
      .fn()
      .mockResolvedValue(false);

    const accepted = await service.addDurably('task', 'upsert', failedTask, 'p-1');

    expect(accepted).toBe(false);
    expect(service.getItems().map(item => item.data.id)).toEqual([existingTask.id]);
    expect(getSaveDebounceTimer(service)).not.toBeNull();

    clearSaveDebounceTimer(service);
  });

  it('saveToStorage 的防抖句柄为 0 时不应重复调度保存', () => {
    const { service, saveToStorageSpy } = loadContext();
    saveToStorageSpy.mockRestore();
    const scheduledCallbacks: Array<() => void> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler: TimerHandler) => {
      if (typeof handler === 'function') {
        scheduledCallbacks.push(handler as () => void);
      }
      return asTimeoutHandle(0);
    });

    try {
      getStorageInternals(service).saveToStorage();
      getStorageInternals(service).saveToStorage();

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(scheduledCallbacks).toHaveLength(1);
    } finally {
      setSaveDebounceTimer(service, null);
      setTimeoutSpy.mockRestore();
    }
  });

  it('saveToStorage 应忽略被新句柄替换的过期防抖回调', () => {
    const { service, saveToStorageSpy } = loadContext();
    saveToStorageSpy.mockRestore();
    const scheduledCallbacks: Array<() => void> = [];
    const handles = [asTimeoutHandle(1), asTimeoutHandle(2)];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler: TimerHandler) => {
      if (typeof handler === 'function') {
        scheduledCallbacks.push(handler as () => void);
      }
      return handles[scheduledCallbacks.length - 1] ?? asTimeoutHandle(99);
    });
    const immediateSpy = vi.spyOn(
      getStorageInternals(service),
      'saveToStorageImmediate',
    ).mockResolvedValue(true);

    try {
      getStorageInternals(service).saveToStorage();
      setSaveDebounceTimer(service, handles[1]);

      scheduledCallbacks[0]?.();

      expect(immediateSpy).not.toHaveBeenCalled();
      expect(getSaveDebounceTimer(service)).toBe(handles[1]);
    } finally {
      setSaveDebounceTimer(service, null);
      setTimeoutSpy.mockRestore();
      immediateSpy.mockRestore();
    }
  });

  it('saveToStorage 防抖回调中的异步持久化失败应被隔离并记录', async () => {
    const { service, loggerCategory, saveToStorageSpy } = loadContext();
    saveToStorageSpy.mockRestore();
    const scheduledCallbacks: Array<() => void> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler: TimerHandler) => {
      if (typeof handler === 'function') {
        scheduledCallbacks.push(handler as () => void);
      }
      return asTimeoutHandle(1);
    });
    const immediateSpy = vi.spyOn(
      getStorageInternals(service),
      'saveToStorageImmediate',
    ).mockRejectedValueOnce(new Error('persist failed'));

    try {
      getStorageInternals(service).saveToStorage();

      scheduledCallbacks[0]?.();
      await Promise.resolve();

      expect(loggerCategory.warn).toHaveBeenCalledWith(
        'RetryQueue 防抖保存失败',
        expect.any(Error),
      );
      expect(getSaveDebounceTimer(service)).toBeNull();
    } finally {
      setSaveDebounceTimer(service, null);
      setTimeoutSpy.mockRestore();
      immediateSpy.mockRestore();
    }
  });

  it('加载 completion marker 时应忽略字段不完整的旧记录，避免误删待恢复项', () => {
    const { service } = loadContext();
    const task = createTask('malformed-completion-marker');
    const operationId = crypto.randomUUID();
    const item: RetryQueueItem = {
      id: crypto.randomUUID(),
      type: 'task',
      operation: 'upsert',
      data: task,
      projectId: 'p-1',
      retryCount: 0,
      createdAt: Date.now(),
      sourceUserId: 'test-user',
      operationId,
    };
    localStorage.setItem(
      'nanoflow.retry-queue.completed-operations',
      JSON.stringify([
        {
          key: `test-user::task::upsert::${task.id}::${operationId}`,
          ownerUserId: 'test-user',
          operationId,
          type: 'not-a-retryable-type',
          operation: 'upsert',
          entityId: task.id,
          completedAt: Date.now(),
        },
      ]),
    );

    const result = getSanitizeInternals(service).sanitizeLoadedItems([item]);

    expect(result.safeItems).toEqual([item]);
    expect(result.removedCount).toBe(0);
  });
}

type RetryQueueStorageInternals = {
  saveDebounceTimer: ReturnType<typeof setTimeout> | null;
  saveToStorage: () => void;
  saveToStorageImmediate: () => Promise<boolean>;
};

function getStorageInternals(service: RetryQueueService): RetryQueueStorageInternals {
  return service as unknown as RetryQueueStorageInternals;
}

function getSaveDebounceTimer(
  service: RetryQueueService,
): ReturnType<typeof setTimeout> | null {
  return getStorageInternals(service).saveDebounceTimer;
}

function setSaveDebounceTimer(
  service: RetryQueueService,
  timer: ReturnType<typeof setTimeout> | null,
): void {
  getStorageInternals(service).saveDebounceTimer = timer;
}

function clearSaveDebounceTimer(service: RetryQueueService): void {
  const timer = getSaveDebounceTimer(service);
  if (timer) {
    clearTimeout(timer);
    setSaveDebounceTimer(service, null);
  }
}

type RetryQueueSanitizeInternals = {
  sanitizeLoadedItems: (items: RetryQueueItem[]) => {
    safeItems: RetryQueueItem[];
    removedCount: number;
    repairedOperationIdCount: number;
  };
};

function getSanitizeInternals(service: RetryQueueService): RetryQueueSanitizeInternals {
  return service as unknown as RetryQueueSanitizeInternals;
}
