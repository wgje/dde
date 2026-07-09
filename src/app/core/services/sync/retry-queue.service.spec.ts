import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryQueueItem, RetryQueueService, RetryOperationHandler } from './retry-queue.service';
import {
  registerRetryQueueBlackBoxReplaySpecs,
  type RetryQueueBlackBoxReplaySpecContext,
} from './retry-queue-blackbox-replay.spec-helpers';
import {
  registerRetryQueueBackupRestoreSpecs,
  type RetryQueueBackupRestoreSpecContext,
} from './retry-queue-backup-restore.spec-helpers';
import {
  registerRetryQueueCapacityAndSliceSpecs,
  type RetryQueueCapacityAndSliceSpecContext,
} from './retry-queue-capacity-and-slice.spec-helpers';
import {
  registerRetryQueueDrainFlagSpecs,
  type RetryQueueDrainFlagSpecContext,
} from './retry-queue-drain-flag.spec-helpers';
import {
  registerRetryQueueOwnerIsolationSpecs,
  type RetryQueueOwnerIsolationSpecContext,
} from './retry-queue-owner-isolation.spec-helpers';
import {
  registerRetryQueueOperationIdSpecs,
  type RetryQueueOperationIdSpecContext,
} from './retry-queue-operation-id.spec-helpers';
import {
  registerRetryQueueReplayBehaviorSpecs,
  type RetryQueueReplayBehaviorSpecContext,
} from './retry-queue-replay-behavior.spec-helpers';
import {
  registerRetryQueueServiceLifecycleSpecs,
  type RetryQueueServiceLifecycleSpecContext,
} from './retry-queue-service-lifecycle.spec-helpers';
import {
  registerRetryQueueStorageLifecycleSpecs,
  type RetryQueueStorageLifecycleSpecContext,
} from './retry-queue-storage-lifecycle.spec-helpers';
import {
  createBlackBoxEntry,
  createConnection,
  createProject,
  createTask,
  setVisibilityState,
  stableUUID,
} from './retry-queue-test-data.spec-helpers';
import { asTimeoutHandle, type FakeIdbTransaction } from './retry-queue-indexeddb.spec-helpers';
import {
  createRetryQueueServiceSpecHarness,
  resetRetryQueueServiceSpecEnvironment,
  type RetryQueueServiceSpecHarness,
} from './retry-queue-service.spec-fixture';

describe('RetryQueueService', () => {
  let harness: RetryQueueServiceSpecHarness;
  let service: RetryQueueService;
  let loggerCategory: RetryQueueServiceSpecHarness['loggerCategory'];
  let handler: RetryOperationHandler;
  let authServiceMock: RetryQueueServiceSpecHarness['authServiceMock'];
  let projectStateMock: RetryQueueServiceSpecHarness['projectStateMock'];
  let toastMock: RetryQueueServiceSpecHarness['toastMock'];
  let blackBoxSyncMock: RetryQueueServiceSpecHarness['blackBoxSyncMock'];
  let initDbSpy: RetryQueueServiceSpecHarness['initDbSpy'];
  let loadFromStorageSpy: RetryQueueServiceSpecHarness['loadFromStorageSpy'];
  let saveToStorageSpy: RetryQueueServiceSpecHarness['saveToStorageSpy'];
  let releaseLeaseMock: RetryQueueServiceSpecHarness['releaseLeaseMock'];
  let syncWriterLeaseMock: RetryQueueServiceSpecHarness['syncWriterLeaseMock'];
  let sentryLazyLoaderMock: RetryQueueServiceSpecHarness['sentryLazyLoaderMock'];

  beforeEach(() => {
    harness = createRetryQueueServiceSpecHarness();
    ({
      service,
      loggerCategory,
      handler,
      authServiceMock,
      projectStateMock,
      toastMock,
      blackBoxSyncMock,
      initDbSpy,
      loadFromStorageSpy,
      saveToStorageSpy,
      releaseLeaseMock,
      syncWriterLeaseMock,
      sentryLazyLoaderMock,
    } = harness);
  });

  afterEach(resetRetryQueueServiceSpecEnvironment);

  function getCapacityAndSliceSpecContext(): RetryQueueCapacityAndSliceSpecContext {
    return {
      service,
      handler,
      authServiceMock,
      initDbSpy,
      saveToStorageSpy,
      loggerCategory,
      syncWriterLeaseMock,
      sentryLazyLoaderMock,
      toastMock,
      setOnline: harness.setOnline,
      createTask,
      createConnection,
      stableUUID,
      setVisibilityState,
    };
  }

  function getOwnerIsolationSpecContext(): RetryQueueOwnerIsolationSpecContext {
    return {
      service,
      handler,
      authServiceMock,
      projectStateMock,
      blackBoxSyncMock,
      toastMock,
      initDbSpy,
      loadFromStorageSpy,
      saveToStorageSpy,
      setOnline: harness.setOnline,
      createTask,
      createBlackBoxEntry,
      stableUUID,
    };
  }

  function getOperationIdSpecContext(): RetryQueueOperationIdSpecContext {
    return {
      service,
      handler,
      authServiceMock,
      loadFromStorageSpy,
      saveToStorageSpy,
      setOnline: harness.setOnline,
      createTask,
      createProject,
      createConnection,
      createBlackBoxEntry,
      stableUUID,
    };
  }

  function getDrainFlagSpecContext(): RetryQueueDrainFlagSpecContext {
    return {
      service,
      handler,
      toastMock,
      setOnline: harness.setOnline,
      createTask,
      createProject,
    };
  }

  function getBlackBoxReplaySpecContext(): RetryQueueBlackBoxReplaySpecContext {
    return {
      service,
      handler,
      setOnline: harness.setOnline,
      createBlackBoxEntry,
      stableUUID,
    };
  }

  function getBackupRestoreSpecContext(): RetryQueueBackupRestoreSpecContext {
    return {
      service,
      createTask,
    };
  }

  function getReplayBehaviorSpecContext(): RetryQueueReplayBehaviorSpecContext {
    return {
      service,
      handler,
      authServiceMock,
      setOnline: harness.setOnline,
      createTask,
      createProject,
      stableUUID,
      setVisibilityState,
    };
  }

  function getServiceLifecycleSpecContext(): RetryQueueServiceLifecycleSpecContext {
    return {
      service,
      handler,
      loggerCategory,
      initDbSpy,
      loadFromStorageSpy,
      saveToStorageSpy,
      releaseLeaseMock,
      syncWriterLeaseMock,
      destroy: harness.destroy,
      setOnline: harness.setOnline,
      createTask,
    };
  }

  function getStorageLifecycleSpecContext(): RetryQueueStorageLifecycleSpecContext {
    return {
      service,
      loggerCategory,
      loadFromStorageSpy,
      saveToStorageSpy,
    };
  }

  it('setOperationHandler 即使 queue 为空也应主动同步 pendingCount=0 到 SyncState（防止切账号 stale 漂移）', () => {
    // 模拟切账号场景：clearCurrentView 已把 queue 清空，但 SyncState 残留旧 pendingCount。
    // 此时上层 SimpleSyncService 重新 setOperationHandler 必须把 pendingCount 主动归零。
    const freshHandler = {
      pushTask: vi.fn().mockResolvedValue(true),
      deleteTask: vi.fn().mockResolvedValue(true),
      pushProject: vi.fn().mockResolvedValue(true),
      pushConnection: vi.fn().mockResolvedValue(true),
      pushBlackBoxEntry: vi.fn().mockResolvedValue(true),
      isSessionExpired: vi.fn().mockReturnValue(false),
      isOnline: vi.fn(() => false),
      onProcessingStateChange: vi.fn(),
    };

    expect(service.length).toBe(0);

    service.setOperationHandler(freshHandler);

    expect(freshHandler.onProcessingStateChange).toHaveBeenCalledWith(false, 0);
  });

  it('入队时应记录来源用户，避免跨账号重放', () => {
    service.add('task', 'upsert', createTask('t-source-user'), 'p-1');

    expect(service.getItems()[0]?.sourceUserId).toBe('test-user');
  });

  it('显式传入来源用户时应优先使用捕获 owner，避免晚到失败被当前 auth 污染', () => {
    authServiceMock.currentUserId.mockReturnValue('new-user');

    service.add('task', 'upsert', createTask('t-captured-owner'), 'p-1', 'old-user');

    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems[0]?.sourceUserId).toBe('old-user');
  });

  it('跨账号来源的新重试项应直接进入 hidden bucket，不污染当前可见队列', () => {
    authServiceMock.currentUserId.mockReturnValue('new-user');

    service.add('task', 'delete', { id: stableUUID('task-hidden-owner') }, 'p-1', 'old-user');

    expect(service.length).toBe(0);
    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems).toEqual([
      expect.objectContaining({
        projectId: 'p-1',
        sourceUserId: 'old-user',
        data: expect.objectContaining({ id: stableUUID('task-hidden-owner') }),
      }),
    ]);
  });

  it('findItemForOwner 应能命中 hidden bucket 中的旧 owner 重试项', () => {
    const hiddenProject = createProject('hidden-owner-project');
    authServiceMock.currentUserId.mockReturnValue('new-user');

    service.add('project', 'upsert', hiddenProject, undefined, 'old-user');

    expect(service.findItemForOwner('project', hiddenProject.id, 'old-user')).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ id: hiddenProject.id }),
        sourceUserId: 'old-user',
      }),
    );
  });

  it('removeByEntity 不应移除来源 owner 不属于当前账号的可见重试项', () => {
    authServiceMock.currentUserId.mockReturnValue('test-user');
    const oldOwnerTask = createTask('t-remove-by-entity-old-owner-visible');
    (service as unknown as { queue: RetryQueueItem[] }).queue = [
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: oldOwnerTask,
        projectId: 'p-old-owner-visible',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'old-user',
        operationId: `test-retry-${crypto.randomUUID()}`,
      },
    ];

    const removed = service.removeByEntity('task', oldOwnerTask.id);

    expect(removed).toBe(false);
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: oldOwnerTask.id }),
        sourceUserId: 'old-user',
      }),
    ]);
    expect(saveToStorageSpy).not.toHaveBeenCalled();
  });

  registerRetryQueueStorageLifecycleSpecs(getStorageLifecycleSpecContext);

  it('persistNow 应在 IndexedDB 事务中止时降级写入 localStorage，避免刷新恢复队列丢失', async () => {
    saveToStorageSpy.mockRestore();
    const task = createTask('retry-idb-abort-fallback');
    const abortError = new Error('idb transaction aborted');
    const transaction: FakeIdbTransaction = {
      objectStore: vi.fn(() => ({
        clear: vi.fn(),
        put: vi.fn(),
      })),
      oncomplete: null,
      onerror: null,
      onabort: null,
      error: abortError,
    };
    const db = {
      transaction: vi.fn(() => transaction),
    } as unknown as IDBDatabase;
    initDbSpy.mockResolvedValue(db);

    service.add('task', 'upsert', task, 'p-idb-abort', 'test-user');
    const persisted = service.persistNow();
    await vi.waitFor(() => {
      expect(db.transaction).toHaveBeenCalled();
    });
    transaction.onabort?.();

    await expect(persisted).resolves.toBe(true);
    expect(loggerCategory.error).toHaveBeenCalledWith('保存到 IndexedDB 中止', abortError);
    expect(localStorage.getItem('nanoflow.retry-queue')).toContain(task.id);
  });

  it('persistNow 在 IndexedDB 合并读取失败且中止事务失败时仍应降级写入 localStorage', async () => {
    saveToStorageSpy.mockRestore();
    const task = createTask('retry-idb-merge-read-abort-fallback');
    const readError = new Error('idb getAll failed');
    const abortError = new Error('idb abort failed');
    const getAllRequest: {
      result: RetryQueueItem[];
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      error: DOMException | Error | null;
    } = {
      result: [],
      onsuccess: null,
      onerror: null,
      error: readError,
    };
    const store = {
      getAll: vi.fn(() => getAllRequest),
      clear: vi.fn(),
      put: vi.fn(),
    };
    const transaction: FakeIdbTransaction & { abort: () => void } = {
      objectStore: vi.fn(() => store),
      oncomplete: null,
      onerror: null,
      onabort: null,
      error: readError,
      abort: vi.fn(() => {
        throw abortError;
      }),
    };
    const db = {
      transaction: vi.fn(() => transaction),
    } as unknown as IDBDatabase;
    initDbSpy.mockResolvedValue(db);

    service.add('task', 'upsert', task, 'p-idb-merge-read-abort', 'test-user');
    const persisted = service.persistNow();
    await vi.waitFor(() => {
      expect(store.getAll).toHaveBeenCalled();
    });

    expect(() => getAllRequest.onerror?.()).not.toThrow();

    await expect(persisted).resolves.toBe(true);
    expect(loggerCategory.error).toHaveBeenCalledWith('IndexedDB 合并读取失败', readError);
    expect(localStorage.getItem('nanoflow.retry-queue')).toContain(task.id);
  });

  it('persistNow 降级写入 localStorage 时应合并已有项，避免覆盖其它标签队列', async () => {
    saveToStorageSpy.mockRestore();
    const currentTask = createTask('retry-localstorage-current-tab');
    const otherTabTask = createTask('retry-localstorage-other-tab');
    const otherTabItem: RetryQueueItem = {
      id: crypto.randomUUID(),
      type: 'task',
      operation: 'upsert',
      data: otherTabTask,
      projectId: 'p-other-tab',
      retryCount: 0,
      createdAt: Date.now(),
      sourceUserId: 'test-user',
      operationId: `retry-other-tab-${crypto.randomUUID()}`,
    };
    const abortError = new Error('idb transaction aborted');
    const transaction: FakeIdbTransaction = {
      objectStore: vi.fn(() => ({
        clear: vi.fn(),
        put: vi.fn(),
      })),
      oncomplete: null,
      onerror: null,
      onabort: null,
      error: abortError,
    };
    const db = {
      transaction: vi.fn(() => transaction),
    } as unknown as IDBDatabase;
    initDbSpy.mockResolvedValue(db);
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [otherTabItem],
      savedAt: Date.now(),
    }));

    service.add('task', 'upsert', currentTask, 'p-current-tab', 'test-user');
    const persisted = service.persistNow();
    await vi.waitFor(() => {
      expect(db.transaction).toHaveBeenCalled();
    });
    transaction.onabort?.();

    await expect(persisted).resolves.toBe(true);
    const stored = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as { items?: RetryQueueItem[] };
    expect(stored.items?.map(item => item.data.id)).toEqual(
      expect.arrayContaining([otherTabTask.id, currentTask.id])
    );
  });

  it('persistNow 写入 IndexedDB 时应合并未本地移除的已有项，避免 clear+put 覆盖其它标签队列', async () => {
    saveToStorageSpy.mockRestore();
    const currentTask = createTask('retry-idb-current-tab');
    const otherTabTask = createTask('retry-idb-other-tab');
    const otherTabItem: RetryQueueItem = {
      id: crypto.randomUUID(),
      type: 'task',
      operation: 'upsert',
      data: otherTabTask,
      projectId: 'p-idb-other-tab',
      retryCount: 0,
      createdAt: Date.now(),
      sourceUserId: 'test-user',
      operationId: `retry-idb-other-tab-${crypto.randomUUID()}`,
    };
    const persistedItems = new Map<string, RetryQueueItem>([
      [otherTabItem.id, otherTabItem],
    ]);
    const getAllRequest: {
      result: RetryQueueItem[];
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      error: DOMException | Error | null;
    } = {
      result: Array.from(persistedItems.values()),
      onsuccess: null,
      onerror: null,
      error: null,
    };
    const store = {
      getAll: vi.fn(() => getAllRequest),
      clear: vi.fn(() => {
        persistedItems.clear();
      }),
      put: vi.fn((item: RetryQueueItem) => {
        persistedItems.set(item.id, item);
      }),
    };
    const transaction: FakeIdbTransaction = {
      objectStore: vi.fn(() => store),
      oncomplete: null,
      onerror: null,
      onabort: null,
      error: null,
    };
    const db = {
      transaction: vi.fn(() => transaction),
    } as unknown as IDBDatabase;
    initDbSpy.mockResolvedValue(db);

    service.add('task', 'upsert', currentTask, 'p-idb-current-tab', 'test-user');
    const persisted = service.persistNow();
    await vi.waitFor(() => {
      expect(db.transaction).toHaveBeenCalled();
    });
    expect(store.getAll).toHaveBeenCalled();
    getAllRequest.onsuccess?.();
    transaction.oncomplete?.();

    await expect(persisted).resolves.toBe(true);
    expect(Array.from(persistedItems.values()).map(item => item.data.id)).toEqual(
      expect.arrayContaining([otherTabTask.id, currentTask.id])
    );
  });

  it('persistNow 写入 IndexedDB 合并已有项时应按 owner/type/entity 去重，避免同一实体重复重放', async () => {
    saveToStorageSpy.mockRestore();
    const task = createTask('retry-idb-duplicate-entity');
    const staleStoredItem: RetryQueueItem = {
      id: crypto.randomUUID(),
      type: 'task',
      operation: 'delete',
      data: { id: task.id },
      projectId: 'p-idb-duplicate-old',
      retryCount: 1,
      createdAt: Date.now() - 1000,
      sourceUserId: 'test-user',
      operationId: `retry-idb-duplicate-old-${crypto.randomUUID()}`,
    };
    const persistedItems = new Map<string, RetryQueueItem>([
      [staleStoredItem.id, staleStoredItem],
    ]);
    const getAllRequest: {
      result: RetryQueueItem[];
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      error: DOMException | Error | null;
    } = {
      result: Array.from(persistedItems.values()),
      onsuccess: null,
      onerror: null,
      error: null,
    };
    const store = {
      getAll: vi.fn(() => getAllRequest),
      clear: vi.fn(() => {
        persistedItems.clear();
      }),
      put: vi.fn((item: RetryQueueItem) => {
        persistedItems.set(item.id, item);
      }),
    };
    const transaction: FakeIdbTransaction = {
      objectStore: vi.fn(() => store),
      oncomplete: null,
      onerror: null,
      onabort: null,
      error: null,
    };
    const db = {
      transaction: vi.fn(() => transaction),
    } as unknown as IDBDatabase;
    initDbSpy.mockResolvedValue(db);

    service.add('task', 'upsert', task, 'p-idb-duplicate-new', 'test-user');
    const currentItem = service.getItems()[0];
    const persisted = service.persistNow();
    await vi.waitFor(() => {
      expect(db.transaction).toHaveBeenCalled();
    });
    getAllRequest.onsuccess?.();
    transaction.oncomplete?.();

    await expect(persisted).resolves.toBe(true);
    const matchingItems = Array.from(persistedItems.values()).filter(item => item.data.id === task.id);
    expect(matchingItems).toEqual([
      expect.objectContaining({
        id: currentItem?.id,
        operation: 'upsert',
        projectId: 'p-idb-duplicate-new',
        operationId: currentItem?.operationId,
      }),
    ]);
  });

  it('persistNow 写入 IndexedDB 合并同实体项时应优先当前内存队列，避免旧存储项覆盖最新本地操作', async () => {
    saveToStorageSpy.mockRestore();
    const task = createTask('retry-idb-current-wins-over-stored-created-at');
    const staleStoredItem: RetryQueueItem = {
      id: crypto.randomUUID(),
      type: 'task',
      operation: 'delete',
      data: { id: task.id },
      projectId: 'p-idb-current-wins-old',
      retryCount: 1,
      createdAt: Date.now() + 60_000,
      sourceUserId: 'test-user',
      operationId: 'retry-idb-current-wins-old-op',
    };
    const persistedItems = new Map<string, RetryQueueItem>([
      [staleStoredItem.id, staleStoredItem],
    ]);
    const getAllRequest: {
      result: RetryQueueItem[];
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      error: DOMException | Error | null;
    } = {
      result: Array.from(persistedItems.values()),
      onsuccess: null,
      onerror: null,
      error: null,
    };
    const store = {
      getAll: vi.fn(() => getAllRequest),
      clear: vi.fn(() => {
        persistedItems.clear();
      }),
      put: vi.fn((item: RetryQueueItem) => {
        persistedItems.set(item.id, item);
      }),
    };
    const transaction: FakeIdbTransaction = {
      objectStore: vi.fn(() => store),
      oncomplete: null,
      onerror: null,
      onabort: null,
      error: null,
    };
    const db = {
      transaction: vi.fn(() => transaction),
    } as unknown as IDBDatabase;
    initDbSpy.mockResolvedValue(db);

    service.add('task', 'upsert', task, 'p-idb-current-wins-new', 'test-user');
    const currentItem = service.getItems()[0];
    const persisted = service.persistNow();
    await vi.waitFor(() => {
      expect(db.transaction).toHaveBeenCalled();
    });
    getAllRequest.onsuccess?.();
    transaction.oncomplete?.();

    await expect(persisted).resolves.toBe(true);
    const matchingItems = Array.from(persistedItems.values()).filter(item => item.data.id === task.id);
    expect(matchingItems).toEqual([
      expect.objectContaining({
        id: currentItem?.id,
        operation: 'upsert',
        projectId: 'p-idb-current-wins-new',
        operationId: currentItem?.operationId,
      }),
    ]);
  });

  registerRetryQueueBackupRestoreSpecs(getBackupRestoreSpecContext);

  registerRetryQueueBlackBoxReplaySpecs(getBlackBoxReplaySpecContext);

  registerRetryQueueServiceLifecycleSpecs(getServiceLifecycleSpecContext);

  registerRetryQueueDrainFlagSpecs(getDrainFlagSpecContext);

  registerRetryQueueOperationIdSpecs(getOperationIdSpecContext);

  registerRetryQueueReplayBehaviorSpecs(getReplayBehaviorSpecContext);

  registerRetryQueueOwnerIsolationSpecs(getOwnerIsolationSpecContext);

  registerRetryQueueCapacityAndSliceSpecs(getCapacityAndSliceSpecContext);
});
