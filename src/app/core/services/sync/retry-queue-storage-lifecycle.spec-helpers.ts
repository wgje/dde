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
    expect(service.getProjectPendingWriteState('p-owner-reload', 'test-user')).toBe('pending');
    expect(loggerCategory.warn).toHaveBeenCalledWith(
      'RetryQueue owner 队列重新加载失败，已保留清空后的当前视图',
      loadError,
    );
  });

  it('owner reload 失败且内存中无对应写入时应保持 unknown 而不是误报 clear', async () => {
    const { service, loadFromStorageSpy } = loadContext();
    await flushMicrotasks();
    loadFromStorageSpy.mockClear();
    loadFromStorageSpy.mockRejectedValueOnce(new Error('empty owner reload failed'));
    await service.reloadFromStorageForCurrentOwner();
    expect(service.getProjectPendingWriteState('p-owner-reload-empty', 'test-user')).toBe('unknown');
  });

  it.each([
    ['fallback-loaded empty', 'unavailable', 'none', false],
    ['authoritative empty', 'complete', 'none', true],
    ['request success then transaction abort', 'abort', 'none', false],
    ['owner drift', 'complete', 'owner', false],
    ['loaded-state drift', 'complete', 'load', false],
    ['queue-generation drift', 'complete', 'queue', false],
    ['lifecycle drift', 'complete', 'lifecycle', false],
  ] as const)('durable project cleanup classifies %s', async (_label, outcome, drift, expected) => {
    const { service, loadFromStorageSpy } = loadContext();
    loadFromStorageSpy.mockRestore();
    await getStorageLoadInternals(service).loadFromStorage();
    const storage = getCleanupReadInternals(service);
    const envelope = JSON.stringify({ version: 1, items: [], savedAt: 73 });
    localStorage.setItem('nanoflow.retry-queue', envelope);
    const persistNowSpy = vi.spyOn(service, 'persistNow');
    const initDbSpy = vi.spyOn(storage, 'initDb').mockClear().mockResolvedValue(
      outcome === 'unavailable' ? null : createCleanupReadDb(outcome, () => {
        if (drift === 'owner') vi.spyOn(storage, 'getCurrentOwnerUserId').mockReturnValue('other-user');
        if (drift === 'load') storage.markCurrentOwnerStorageLoadUnknown();
        if (drift === 'queue') storage.queueStateGeneration += 1;
        if (drift === 'lifecycle') storage.lifecycleClosed = true;
      }),
    );
    await expect(
      service.removeByProjectIdDurablyForOwner('p-owner-load', 'test-user'),
    ).resolves.toBe(expected);
    expect(initDbSpy).toHaveBeenCalledOnce();
    expect(persistNowSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem('nanoflow.retry-queue')).toBe(envelope);
  });

  it('fake-indexeddb restart preserves owner isolation before and after durable cleanup commit', async () => {
    await deleteRetryQueueDatabase();
    localStorage.clear();
    const ownerTask = createTask('restart-project-cleanup-owner');
    const otherOwnerTask = createTask('restart-project-cleanup-other-owner');
    let initialHarness: RetryQueueServiceSpecHarness | null = null;
    let cleanupHarness: RetryQueueServiceSpecHarness | null = null;
    let restartHarness: RetryQueueServiceSpecHarness | null = null;
    try {
      initialHarness = createRetryQueueServiceSpecHarness({ clearLocalStorage: false });
      await flushMicrotasks();
      initialHarness.initDbSpy.mockRestore();
      initialHarness.loadFromStorageSpy.mockRestore();
      await getStorageLoadInternals(initialHarness.service).loadFromStorage();
      initialHarness.service.add(
        'task', 'upsert', ownerTask, 'p-restart-cleanup', 'test-user',
      );
      initialHarness.service.add(
        'task', 'upsert', otherOwnerTask, 'p-restart-cleanup', 'other-user',
      );
      await expect(initialHarness.service.persistNow()).resolves.toBe(true);
      await initialHarness.service.closeStorageConnections();

      cleanupHarness = createRetryQueueServiceSpecHarness({ clearLocalStorage: false });
      await flushMicrotasks();
      cleanupHarness.initDbSpy.mockRestore();
      cleanupHarness.loadFromStorageSpy.mockRestore();
      await getStorageLoadInternals(cleanupHarness.service).loadFromStorage();
      expect(cleanupHarness.service.findItemForOwner('task', ownerTask.id, 'test-user')).toBeTruthy();
      expect(cleanupHarness.service.findItemForOwner('task', otherOwnerTask.id, 'other-user')).toBeTruthy();

      await expect(cleanupHarness.service.removeByProjectIdDurablyForOwner(
        'p-restart-cleanup',
        'test-user',
      )).resolves.toBe(true);
      await cleanupHarness.service.closeStorageConnections();

      restartHarness = createRetryQueueServiceSpecHarness({ clearLocalStorage: false });
      await flushMicrotasks();
      restartHarness.initDbSpy.mockRestore();
      restartHarness.loadFromStorageSpy.mockRestore();
      await getStorageLoadInternals(restartHarness.service).loadFromStorage();
      expect(restartHarness.service.findItemForOwner('task', ownerTask.id, 'test-user')).toBeUndefined();
      expect(restartHarness.service.findItemForOwner('task', otherOwnerTask.id, 'other-user')).toBeTruthy();
    } finally {
      await initialHarness?.teardown();
      await cleanupHarness?.teardown();
      await restartHarness?.teardown();
      await deleteRetryQueueDatabase();
    }
  });

  it('成功 IDB 写入结算旧 fallback proof 后，后续 fallback 与下一次重启都不应复活已移除条目', async () => {
    const fallbackHarness = createRetryQueueServiceSpecHarness();
    const fallbackService = fallbackHarness.service;
    const fallbackDb = {} as IDBDatabase;
    const persistedTask = createTask('retry-idb-proof-settled-a');
    const removedTask = createTask('retry-idb-proof-settled-b');

    await flushMicrotasks();
    fallbackHarness.loadFromStorageSpy.mockClear();
    fallbackHarness.initDbSpy.mockResolvedValue(fallbackDb);

    const fallbackStorageInternals = getStorageProofInternals(fallbackService);
    const fallbackSaveToIdbSpy = vi.spyOn(
      fallbackStorageInternals,
      'saveToIdb',
    );
    const fallbackLoadFromIdbSpy = vi.spyOn(
      fallbackStorageInternals,
      'loadFromIdb',
    );

    let restartHarness: RetryQueueServiceSpecHarness | null = null;
    let restartSaveToIdbSpy: ReturnType<typeof vi.spyOn> | null = null;
    let restartLoadFromIdbSpy: ReturnType<typeof vi.spyOn> | null = null;
    let secondRestartHarness: RetryQueueServiceSpecHarness | null = null;
    let secondRestartSaveToIdbSpy: ReturnType<typeof vi.spyOn> | null = null;
    let secondRestartLoadFromIdbSpy: ReturnType<typeof vi.spyOn> | null = null;

    try {
      fallbackService.add('task', 'upsert', persistedTask, 'p-proof-settled-a');
      fallbackService.add('task', 'upsert', removedTask, 'p-proof-settled-b');
      const fallbackItems = fallbackService.getItems();
      const persistedItem = fallbackItems.find(item => item.data.id === persistedTask.id);
      expect(persistedItem).toBeTruthy();

      fallbackSaveToIdbSpy.mockResolvedValueOnce(false);
      await expect(fallbackService.persistNow()).resolves.toBe(true);
      expect(readRetryQueueEnvelope()?.idbFallbackProof).toBeTruthy();

      expect(fallbackService.removeByEntity('task', removedTask.id)).toBe(true);
      const settledItems = fallbackService.getItems();
      expect(settledItems.map(item => item.data.id)).toEqual([persistedTask.id]);

      fallbackSaveToIdbSpy.mockImplementationOnce(async (_db, capture) => {
        if (capture) {
          capture.persistedDigest = fallbackStorageInternals.computeRetryQueueItemDigest(
            settledItems,
          );
        }
        return true;
      });
      fallbackLoadFromIdbSpy.mockResolvedValueOnce(settledItems);

      await expect(fallbackService.persistNow()).resolves.toBe(true);
      expect(readRetryQueueEnvelope()?.idbFallbackProof).toBeUndefined();

      restartHarness = createRetryQueueServiceSpecHarness({ clearLocalStorage: false });
      await flushMicrotasks();
      restartHarness.loadFromStorageSpy.mockClear();
      restartHarness.loadFromStorageSpy.mockRestore();
      restartHarness.initDbSpy.mockResolvedValue({} as IDBDatabase);
      const restartStorageInternals = getStorageProofInternals(restartHarness.service);

      restartLoadFromIdbSpy = vi.spyOn(
        restartStorageInternals,
        'loadFromIdb',
      ).mockResolvedValueOnce(settledItems);

      await restartStorageInternals.loadFromStorage();

      expect(restartHarness.service.getItems()).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ id: persistedTask.id }),
        }),
      ]);

      restartSaveToIdbSpy = vi.spyOn(
        restartStorageInternals,
        'saveToIdb',
      ).mockResolvedValueOnce(false);

      await expect(restartHarness.service.persistNow()).resolves.toBe(true);

      expect(readRetryQueueEnvelopeItemIds()).toEqual([persistedTask.id]);
      expect(readRetryQueueEnvelope()?.idbFallbackProof).toEqual(
        expect.objectContaining({ itemCount: 1 }),
      );

      secondRestartHarness = createRetryQueueServiceSpecHarness({ clearLocalStorage: false });
      await flushMicrotasks();
      secondRestartHarness.loadFromStorageSpy.mockClear();
      secondRestartHarness.loadFromStorageSpy.mockRestore();
      secondRestartHarness.initDbSpy.mockResolvedValue({} as IDBDatabase);
      const secondRestartStorageInternals = getStorageProofInternals(secondRestartHarness.service);

      secondRestartLoadFromIdbSpy = vi.spyOn(
        secondRestartStorageInternals,
        'loadFromIdb',
      ).mockResolvedValueOnce(settledItems).mockResolvedValueOnce(settledItems);
      secondRestartSaveToIdbSpy = vi.spyOn(
        secondRestartStorageInternals,
        'saveToIdb',
      ).mockImplementation(async (_db, capture) => {
        if (capture) {
          capture.persistedDigest = secondRestartStorageInternals.computeRetryQueueItemDigest(
            settledItems,
          );
        }
        return true;
      });

      await secondRestartStorageInternals.loadFromStorage();

      expect(secondRestartHarness.service.getItems()).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ id: persistedTask.id }),
        }),
      ]);
    } finally {
      secondRestartLoadFromIdbSpy?.mockRestore();
      secondRestartSaveToIdbSpy?.mockRestore();
      if (secondRestartHarness) {
        await secondRestartHarness.teardown();
      }
      restartLoadFromIdbSpy?.mockRestore();
      restartSaveToIdbSpy?.mockRestore();
      if (restartHarness) {
        await restartHarness.teardown();
      }
      fallbackLoadFromIdbSpy.mockRestore();
      fallbackSaveToIdbSpy.mockRestore();
      await fallbackHarness.teardown();
    }
  });

  it('IDB 成功写入期间若 proof 被并发更新，旧 writer 不得清除新的 fallback proof', async () => {
    const harness = createRetryQueueServiceSpecHarness();
    const service = harness.service;
    const db = {} as IDBDatabase;
    const persistedTask = createTask('retry-idb-concurrent-proof-a');
    const removedTask = createTask('retry-idb-concurrent-proof-b');

    await flushMicrotasks();
    harness.loadFromStorageSpy.mockClear();
    harness.initDbSpy.mockResolvedValue(db);

    const storageInternals = getStorageProofInternals(service);
    const saveToIdbSpy = vi.spyOn(storageInternals, 'saveToIdb');
    const loadFromIdbSpy = vi.spyOn(storageInternals, 'loadFromIdb');

    try {
      service.add('task', 'upsert', persistedTask, 'p-concurrent-proof-a');
      service.add('task', 'upsert', removedTask, 'p-concurrent-proof-b');

      saveToIdbSpy.mockResolvedValueOnce(false);
      await expect(service.persistNow()).resolves.toBe(true);

      const originalEnvelope = readRetryQueueEnvelope();
      expect(originalEnvelope?.idbFallbackProof).toBeTruthy();

      expect(service.removeByEntity('task', removedTask.id)).toBe(true);
      const settledItems = service.getItems();
      const concurrentSavedAt = (originalEnvelope?.savedAt ?? Date.now()) + 1_000;
      const concurrentEnvelopes: RetryQueueLocalStorageEnvelope[] = [];

      saveToIdbSpy.mockImplementationOnce(async (_db, capture) => {
        if (capture) {
          capture.persistedDigest = storageInternals.computeRetryQueueItemDigest(
            settledItems,
          );
        }
        concurrentEnvelopes.push(writeRetryQueueFallbackEnvelope(
          service,
          settledItems,
          concurrentSavedAt,
        ));
        return true;
      });
      loadFromIdbSpy.mockResolvedValueOnce(settledItems);

      await expect(service.persistNow()).resolves.toBe(true);

      const envelopeAfterPersist = readRetryQueueEnvelope();
      expect(concurrentEnvelopes).toHaveLength(1);
      const [concurrentEnvelope] = concurrentEnvelopes;
      if (!concurrentEnvelope) {
        throw new Error('Expected one concurrent RetryQueue fallback envelope');
      }
      expect(envelopeAfterPersist?.savedAt).toBe(concurrentEnvelope.savedAt);
      expect(envelopeAfterPersist?.items).toHaveLength(settledItems.length);
      expect(envelopeAfterPersist?.idbFallbackProof).toEqual(
        concurrentEnvelope.idbFallbackProof,
      );
    } finally {
      loadFromIdbSpy.mockRestore();
      saveToIdbSpy.mockRestore();
      await harness.teardown();
    }
  });

  it('IDB 写入失败后若仅 localStorage 持久化成功，重启遇到 stale IDB 时应恢复 fallback-only 条目并保留较新的 fallback winner', async () => {
    const fallbackHarness = createRetryQueueServiceSpecHarness();
    const fallbackService = fallbackHarness.service;
    const fallbackTask = {
      ...createTask('retry-idb-fallback-newer-winner'),
      title: 'Fallback newer winner',
      updatedAt: '2026-02-01T00:00:00.000Z',
    };
    const fallbackOnlyTask = createTask('retry-idb-fallback-only-item');
    const fallbackDb = {} as IDBDatabase;
    const restartDb = {} as IDBDatabase;

    await flushMicrotasks();
    fallbackHarness.loadFromStorageSpy.mockClear();
    fallbackHarness.initDbSpy.mockResolvedValue(fallbackDb);

    const fallbackSaveToIdbSpy = vi.spyOn(
      getStorageLoadInternals(fallbackService),
      'saveToIdb',
    ).mockResolvedValue(false);

    let restartHarness: RetryQueueServiceSpecHarness | null = null;
    let restartLoadFromIdbSpy: ReturnType<typeof vi.spyOn> | null = null;
    let restartSaveToIdbSpy: ReturnType<typeof vi.spyOn> | null = null;

    try {
      fallbackService.add('task', 'upsert', fallbackTask, 'p-idb-fallback-winner');
      fallbackService.add('task', 'upsert', fallbackOnlyTask, 'p-idb-fallback-only');

      const fallbackWinner = fallbackService.getItems().find(item => item.data.id === fallbackTask.id);
      const fallbackOnlyItem = fallbackService.getItems().find(item => item.data.id === fallbackOnlyTask.id);

      expect(fallbackWinner).toBeTruthy();
      expect(fallbackOnlyItem).toBeTruthy();
      await expect(fallbackService.persistNow()).resolves.toBe(true);

      const storedAfterFallback = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as {
        idbFallbackProof?: { ownerUserId?: string };
      };
      expect(storedAfterFallback.idbFallbackProof?.ownerUserId).toBe('test-user');

      const staleIdbItem: RetryQueueItem = {
        ...fallbackWinner!,
        id: crypto.randomUUID(),
        data: {
          ...fallbackTask,
          title: 'Stale IndexedDB snapshot',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        createdAt: fallbackWinner!.createdAt - 1_000,
        operationId: `retry-stale-idb-${crypto.randomUUID()}`,
      };

      restartHarness = createRetryQueueServiceSpecHarness({ clearLocalStorage: false });
      await flushMicrotasks();
      restartHarness.loadFromStorageSpy.mockClear();
      restartHarness.loadFromStorageSpy.mockRestore();
      restartHarness.initDbSpy.mockResolvedValue(restartDb);

      restartLoadFromIdbSpy = vi.spyOn(
        getStorageLoadInternals(restartHarness.service),
        'loadFromIdb',
      ).mockResolvedValueOnce([staleIdbItem]).mockResolvedValue([
        fallbackWinner!,
        fallbackOnlyItem!,
      ]);
      const restartStorageInternals = getStorageProofInternals(restartHarness.service);
      restartSaveToIdbSpy = vi.spyOn(
        restartStorageInternals,
        'saveToIdb',
      ).mockImplementation(async (_db, capture) => {
        if (capture) {
          capture.persistedDigest = restartStorageInternals.computeRetryQueueItemDigest([
            fallbackWinner!,
            fallbackOnlyItem!,
          ]);
        }
        return true;
      });

      await getStorageLoadInternals(restartHarness.service).loadFromStorage();

      const recoveredItems = restartHarness.service.getItems();
      expect(recoveredItems).toHaveLength(2);

      const recoveredWinner = recoveredItems.find(item => item.data.id === fallbackTask.id);
      const recoveredFallbackOnly = recoveredItems.find(item => item.data.id === fallbackOnlyTask.id);
      expect(recoveredWinner).toEqual(expect.objectContaining({
        id: fallbackWinner!.id,
        operationId: fallbackWinner!.operationId,
        data: expect.objectContaining({
          title: 'Fallback newer winner',
          updatedAt: '2026-02-01T00:00:00.000Z',
        }),
      }));
      expect(recoveredFallbackOnly).toEqual(expect.objectContaining({
        id: fallbackOnlyItem!.id,
        operationId: fallbackOnlyItem!.operationId,
      }));
      expect(restartSaveToIdbSpy).toHaveBeenCalledTimes(1);

      const storedAfterRecovery = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as {
        idbFallbackProof?: unknown;
      };
      expect(storedAfterRecovery).not.toHaveProperty('idbFallbackProof');
    } finally {
      restartLoadFromIdbSpy?.mockRestore();
      restartSaveToIdbSpy?.mockRestore();
      if (restartHarness) {
        await restartHarness.teardown();
      }
      fallbackSaveToIdbSpy.mockRestore();
      await fallbackHarness.teardown();
    }
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
      clearSaveDebounceTimer(service);
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
      clearSaveDebounceTimer(service);
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
      clearSaveDebounceTimer(service);
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
  saveDebounceWriter: { release(): void } | null;
  saveToStorage: () => void;
  saveToStorageImmediate: () => Promise<boolean>;
};

function getStorageInternals(service: RetryQueueService): RetryQueueStorageInternals {
  return service as unknown as RetryQueueStorageInternals;
}

type RetryQueueStorageLoadInternals = RetryQueueStorageInternals & {
  initDb: () => Promise<IDBDatabase | null>;
  loadFromStorage: () => Promise<void>;
  loadFromIdb: (db: IDBDatabase) => Promise<RetryQueueItem[] | null>;
  saveToIdb: (
    db: IDBDatabase,
    capture?: { persistedDigest?: string },
  ) => Promise<boolean>;
  minifyItem: (item: RetryQueueItem) => unknown;
  computeRetryQueueItemDigest: (items: unknown[]) => string;
};
type RetryQueueCleanupReadInternals = RetryQueueStorageLoadInternals & {
  getCurrentOwnerUserId: () => string;
  lifecycleClosed: boolean;
  markCurrentOwnerStorageLoadUnknown: () => void;
  queueStateGeneration: number;
};
function getStorageLoadInternals(service: RetryQueueService): RetryQueueStorageLoadInternals {
  return service as unknown as RetryQueueStorageLoadInternals;
}
function getCleanupReadInternals(service: RetryQueueService): RetryQueueCleanupReadInternals {
  return service as unknown as RetryQueueCleanupReadInternals;
}
function createCleanupReadDb(
  outcome: 'complete' | 'abort',
  afterRequest: () => void,
): IDBDatabase {
  const request = { result: [] } as unknown as IDBRequest<RetryQueueItem[]>;
  const transaction = {
    objectStore: () => ({ getAll: () => {
      queueMicrotask(() => {
        request.onsuccess?.call(request, new Event('success'));
        afterRequest();
        const handler = outcome === 'abort' ? transaction.onabort : transaction.oncomplete;
        handler?.call(transaction, new Event(outcome));
      });
      return request;
    } }),
  } as unknown as IDBTransaction;
  return { transaction: () => transaction } as unknown as IDBDatabase;
}
function deleteRetryQueueDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('nanoflow-retry-queue');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('RetryQueue database deletion was blocked'));
  });
}

type RetryQueueIdbFallbackProof = {
  version: number;
  ownerUserId: string;
  savedAt: number;
  itemCount: number;
  snapshotDigest: string;
  recordedAt: number;
};

type RetryQueueLocalStorageEnvelope = {
  version: number;
  items: unknown[];
  savedAt: number;
  idbFallbackProof?: RetryQueueIdbFallbackProof;
};

function getStorageProofInternals(service: RetryQueueService): RetryQueueStorageLoadInternals {
  return getStorageLoadInternals(service);
}

function readRetryQueueEnvelope(): RetryQueueLocalStorageEnvelope | null {
  const raw = localStorage.getItem('nanoflow.retry-queue');
  return raw ? JSON.parse(raw) as RetryQueueLocalStorageEnvelope : null;
}

function readRetryQueueEnvelopeItemIds(): string[] {
  return (readRetryQueueEnvelope()?.items ?? [])
    .map(item => (item as { data?: { id?: string } }).data?.id)
    .filter((id): id is string => typeof id === 'string');
}

function writeRetryQueueFallbackEnvelope(
  service: RetryQueueService,
  items: RetryQueueItem[],
  savedAt: number,
): RetryQueueLocalStorageEnvelope {
  const storageInternals = getStorageProofInternals(service);
  const persistedItems = items.map(item => storageInternals.minifyItem(item));
  const envelope: RetryQueueLocalStorageEnvelope = {
    version: readRetryQueueEnvelope()?.version ?? 1,
    items: persistedItems,
    savedAt,
    idbFallbackProof: {
      version: 1,
      ownerUserId: 'test-user',
      savedAt,
      itemCount: persistedItems.length,
      snapshotDigest: storageInternals.computeRetryQueueItemDigest(persistedItems),
      recordedAt: savedAt + 1,
    },
  };
  localStorage.setItem('nanoflow.retry-queue', JSON.stringify(envelope));
  return envelope;
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
  const internals = getStorageInternals(service);
  const timer = internals.saveDebounceTimer;
  if (timer !== null) {
    clearTimeout(timer);
    internals.saveDebounceTimer = null;
  }
  internals.saveDebounceWriter?.release();
  internals.saveDebounceWriter = null;
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
