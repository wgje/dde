import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_CONFIG } from '../../../../config/auth.config';
import type { Task } from '../../../../models';
import type { BlackBoxEntry } from '../../../../models/focus';
import type { RetryOperationHandler, RetryQueueItem, RetryQueueService } from './retry-queue.service';

type MockFn = ReturnType<typeof vi.fn>;
type SpyInstance = ReturnType<typeof vi.spyOn>;

const SYNC_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RetryQueueOwnerIsolationSpecContext {
  service: RetryQueueService;
  handler: RetryOperationHandler;
  authServiceMock: {
    currentUserId: MockFn;
    peekPersistedOwnerHint: MockFn;
  };
  projectStateMock: {
    getProject: MockFn;
  };
  blackBoxSyncMock: {
    markEntrySyncConflict: MockFn;
  };
  toastMock: {
    warning: MockFn;
  };
  initDbSpy: SpyInstance;
  loadFromStorageSpy: SpyInstance;
  saveToStorageSpy: SpyInstance;
  setOnline(value: boolean): void;
  createTask(label: string): Task;
  createBlackBoxEntry(label: string, overrides?: Partial<BlackBoxEntry>): BlackBoxEntry;
  stableUUID(label: string): string;
}

export function registerRetryQueueOwnerIsolationSpecs(
  getContext: () => RetryQueueOwnerIsolationSpecContext,
): void {
  let service: RetryQueueService;
  let handler: RetryOperationHandler;
  let authServiceMock: RetryQueueOwnerIsolationSpecContext['authServiceMock'];
  let projectStateMock: RetryQueueOwnerIsolationSpecContext['projectStateMock'];
  let blackBoxSyncMock: RetryQueueOwnerIsolationSpecContext['blackBoxSyncMock'];
  let toastMock: RetryQueueOwnerIsolationSpecContext['toastMock'];
  let initDbSpy: SpyInstance;
  let loadFromStorageSpy: SpyInstance;
  let saveToStorageSpy: SpyInstance;
  let setOnline: (value: boolean) => void;
  let createTask: RetryQueueOwnerIsolationSpecContext['createTask'];
  let createBlackBoxEntry: RetryQueueOwnerIsolationSpecContext['createBlackBoxEntry'];
  let stableUUID: RetryQueueOwnerIsolationSpecContext['stableUUID'];

  function loadContext(): void {
    const context = getContext();
    service = context.service;
    handler = context.handler;
    authServiceMock = context.authServiceMock;
    projectStateMock = context.projectStateMock;
    blackBoxSyncMock = context.blackBoxSyncMock;
    toastMock = context.toastMock;
    initDbSpy = context.initDbSpy;
    loadFromStorageSpy = context.loadFromStorageSpy;
    saveToStorageSpy = context.saveToStorageSpy;
    setOnline = context.setOnline;
    createTask = context.createTask;
    createBlackBoxEntry = context.createBlackBoxEntry;
    stableUUID = context.stableUUID;
  }

  function createRetryQueueItem(
    overrides: Omit<RetryQueueItem, 'id' | 'operationId' | 'retryCount' | 'createdAt'> & Partial<Pick<RetryQueueItem, 'id' | 'operationId' | 'retryCount' | 'createdAt'>>,
  ): RetryQueueItem {
    return {
      id: crypto.randomUUID(),
      retryCount: 0,
      createdAt: Date.now(),
      operationId: `test-retry-${crypto.randomUUID()}`,
      ...overrides,
    };
  }

  describe('owner isolation and legacy review', () => {
    beforeEach(loadContext);
    it('切账号后清空当前视图并保存，不应覆盖其它账号的持久化重试项', async () => {
      loadFromStorageSpy.mockRestore();
      initDbSpy.mockResolvedValue(null);
      saveToStorageSpy.mockImplementation(() => {
        (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
        return undefined as unknown as Promise<void>;
      });

      const currentTask = createTask('t-current-owner');
      const otherTask = createTask('t-other-owner');
      const storedItems: RetryQueueItem[] = [
        createRetryQueueItem({
          type: 'task',
          operation: 'upsert',
          data: currentTask,
          projectId: 'p-1',
          sourceUserId: 'test-user',
        }),
        createRetryQueueItem({
          type: 'task',
          operation: 'upsert',
          data: otherTask,
          projectId: 'p-2',
          sourceUserId: 'other-user',
        }),
      ];
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: storedItems,
        savedAt: Date.now(),
      }));

      service.reloadFromStorageForCurrentOwner();

      await vi.waitFor(() => {
        expect(service.getItems().map(item => item.data.id)).toEqual([currentTask.id]);
      });
      expect(service.getProjectPendingWriteState('p-1', 'test-user')).toBe('pending');
      expect(service.getProjectPendingWriteState('p-2', 'test-user')).toBe('clear');

      service.clearCurrentView();
      (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();

      const persistedAfterClear = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as {
        items?: RetryQueueItem[];
      };
      expect(new Set((persistedAfterClear.items ?? []).map(item => item.data.id))).toEqual(
        new Set([currentTask.id, otherTask.id])
      );

      authServiceMock.currentUserId.mockReturnValue('other-user');
      service.reloadFromStorageForCurrentOwner();

      await vi.waitFor(() => {
        expect(service.getItems().map(item => item.data.id)).toEqual([otherTask.id]);
      });
      expect(service.getProjectPendingWriteState('p-2', 'other-user')).toBe('pending');
      expect(service.getProjectPendingWriteState('p-2', 'test-user')).toBe('unknown');
    });

    it.each([['失败回放', false], ['unknown replay 对账', true]] as const)('owner 切换后晚到的%s不应结算旧切片', async (_label, unknownOutcome) => {
      const projectId = `p-stale-owner-${unknownOutcome ? 'unknown' : 'failed'}`;
      const lastFailure = unknownOutcome
        ? { errorType: 'TimeoutError', message: 'stale owner unknown outcome', remoteOutcome: 'unknown' as const, recordedAt: Date.now() }
        : undefined;
      const item = createRetryQueueItem({ type: 'task', operation: 'upsert', data: createTask(projectId), projectId,
        sourceUserId: 'test-user', writeIntent: 'task_full_upsert', lastFailure });
      (service as unknown as { queue: RetryQueueItem[] }).queue = [item];
      let releaseLateResult: (() => void) | undefined;
      const reconcileLateCall = vi.fn((_item: RetryQueueItem) => new Promise<'replay'>(resolve => { releaseLateResult = () => resolve('replay'); }));
      const lateCall = unknownOutcome ? reconcileLateCall : vi.mocked(handler.pushTask)
        .mockImplementationOnce(() => new Promise<boolean>(resolve => { releaseLateResult = () => resolve(false); }));
      if (unknownOutcome) handler.reconcileUnknownOutcome = reconcileLateCall;
      setOnline(true);
      const processing = service.processQueue();
      await vi.waitFor(() => expect(lateCall).toHaveBeenCalledOnce());
      authServiceMock.currentUserId.mockReturnValue('other-user');
      service.clearCurrentView();
      releaseLateResult?.();
      await processing;
      const hiddenItems = (service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems;
      expect(hiddenItems).toEqual([expect.objectContaining({ id: item.id, retryCount: 0, lastFailure })]);
      expect(service.getProjectPendingWriteState(projectId, 'test-user')).toBe('pending');
      if (unknownOutcome) expect(handler.pushTask).not.toHaveBeenCalled();
      expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.test-user')).toBeNull();
    });

    it('晚到的存储加载结果不应覆盖当前 owner 新增的重试项', async () => {
      loadFromStorageSpy.mockRestore();
      saveToStorageSpy.mockResolvedValue(undefined);

      let resolveDbInit: ((db: IDBDatabase | null) => void) | null = null;
      initDbSpy.mockReturnValue(new Promise(resolve => {
        resolveDbInit = resolve;
      }));

      const staleTask = createTask('t-stale-reload');
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [
          {
            id: crypto.randomUUID(),
            type: 'task',
            operation: 'upsert',
            data: staleTask,
            projectId: 'p-stale',
            retryCount: 0,
            createdAt: Date.now(),
            sourceUserId: 'test-user',
          },
        ],
        savedAt: Date.now(),
      }));

      service.reloadFromStorageForCurrentOwner();

      const freshTask = createTask('t-fresh-after-reload');
      service.add('task', 'upsert', freshTask, 'p-fresh');

      resolveDbInit!(null);
      await Promise.resolve();
      await Promise.resolve();

      await vi.waitFor(() => {
        expect(service.getItems().map(item => item.data.id)).toEqual([freshTask.id]);
      });
    });

    it('IndexedDB 成功加载空队列时不应回退到 stale localStorage 复活旧重试项', async () => {
      loadFromStorageSpy.mockRestore();
      const db = {} as IDBDatabase;
      const loadFromIdbSpy = vi.spyOn(service as unknown as {
        loadFromIdb(db: IDBDatabase): Promise<RetryQueueItem[] | null>;
      }, 'loadFromIdb').mockResolvedValue([]);
      initDbSpy.mockResolvedValue(db);
      const staleTask = createTask('t-stale-local-storage-after-empty-idb');
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [
          {
            id: crypto.randomUUID(),
            type: 'task',
            operation: 'upsert',
            data: staleTask,
            projectId: 'p-stale',
            retryCount: 0,
            createdAt: Date.now(),
            sourceUserId: 'test-user',
          },
        ],
        savedAt: Date.now(),
      }));

      try {
        await (service as unknown as { loadFromStorage(): Promise<void> }).loadFromStorage();
        expect(service.getProjectPendingWriteState('p-stale', 'test-user')).toBe('clear');
      } finally {
        loadFromIdbSpy.mockRestore();
      }

      expect(service.getItems()).toEqual([]);
      expect(handler.onProcessingStateChange).toHaveBeenCalledWith(false, 0);
    });

    it('clearCurrentView 应按当前 owner 重新刷新 legacyReviewCount', () => {
      localStorage.setItem('nanoflow.retry-queue.legacy-review.test-user', JSON.stringify([
        {
          item: {
            id: crypto.randomUUID(),
            type: 'task',
            operation: 'upsert',
            data: createTask('legacy-review-user-a'),
            projectId: 'p-1',
            retryCount: 0,
            createdAt: Date.now(),
            sourceUserId: 'test-user',
          },
          reason: 'legacy',
          quarantinedAt: new Date().toISOString(),
          ownerUserId: 'test-user',
        },
      ]));

      service.refreshLegacyReviewCount();
      expect(service.legacyReviewCount()).toBe(1);

      authServiceMock.currentUserId.mockReturnValue(null);
      service.clearCurrentView();

      expect(service.legacyReviewCount()).toBe(0);
    });

    it('clear 应清空包含 hidden items 在内的全量重试数据', () => {
      (service as unknown as { queue: RetryQueueItem[] }).queue = [
        createRetryQueueItem({
          type: 'task',
          operation: 'upsert',
          data: createTask('t-visible-clear-all'),
          projectId: 'p-visible',
          sourceUserId: 'test-user',
        }),
      ];
      (service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems = [
        createRetryQueueItem({
          type: 'task',
          operation: 'upsert',
          data: createTask('t-hidden-clear-all'),
          projectId: 'p-hidden',
          sourceUserId: 'other-user',
        }),
      ];

      service.clear();

      expect(service.getItems()).toEqual([]);
      expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems).toEqual([]);
    });

    it('云端账号加载阶段应立即隔离缺少来源元数据的 legacy 重试项', async () => {
      loadFromStorageSpy.mockRestore();
      initDbSpy.mockResolvedValue(null);
      authServiceMock.currentUserId.mockReturnValue('test-user');
      saveToStorageSpy.mockImplementation(() => {
        (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
        return undefined as unknown as Promise<void>;
      });

      const legacyTask = createTask('t-legacy-load');
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [
          {
            id: crypto.randomUUID(),
            type: 'task',
            operation: 'upsert',
            data: legacyTask,
            projectId: 'p-legacy',
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        savedAt: Date.now(),
      }));

      service.reloadFromStorageForCurrentOwner();

      await vi.waitFor(() => {
        expect(service.getItems()).toEqual([]);
      });

      expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toContain('t-legacy-load');
      const persisted = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as { items?: RetryQueueItem[] };
      expect(persisted.items ?? []).toHaveLength(0);
    });

    it('本地模式加载缺少来源元数据的 legacy 重试残留应静默清理且不弹待确认提示', async () => {
      loadFromStorageSpy.mockRestore();
      initDbSpy.mockResolvedValue(null);
      authServiceMock.currentUserId.mockReturnValue(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      saveToStorageSpy.mockImplementation(() => {
        (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
        return undefined as unknown as Promise<void>;
      });

      const legacyTask = createTask('t-legacy-local-load');
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [
          {
            id: crypto.randomUUID(),
            type: 'task',
            operation: 'upsert',
            data: legacyTask,
            projectId: 'p-local',
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        savedAt: Date.now(),
      }));

      service.reloadFromStorageForCurrentOwner();

      await vi.waitFor(() => {
        expect(service.getItems()).toEqual([]);
      });

      expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toBeNull();
      const persisted = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}') as { items?: RetryQueueItem[] };
      expect(persisted.items ?? []).toHaveLength(0);
      expect(toastMock.warning).not.toHaveBeenCalledWith(
        '检测到待确认的离线同步数据',
        expect.any(String),
      );
    });

    it('匿名启动且无持久 owner hint 时 legacy 重试残留应静默清理', async () => {
      loadFromStorageSpy.mockRestore();
      initDbSpy.mockResolvedValue(null);
      authServiceMock.currentUserId.mockReturnValue(null);
      authServiceMock.peekPersistedOwnerHint.mockReturnValue(null);
      saveToStorageSpy.mockImplementation(() => {
        (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
        return undefined as unknown as Promise<void>;
      });

      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [
          {
            id: crypto.randomUUID(),
            type: 'task',
            operation: 'upsert',
            data: createTask('t-anonymous-legacy-load'),
            projectId: 'p-anonymous',
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        savedAt: Date.now(),
      }));

      service.reloadFromStorageForCurrentOwner();

      await vi.waitFor(() => {
        expect(service.getItems()).toEqual([]);
      });

      expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toBeNull();
      expect(toastMock.warning).not.toHaveBeenCalledWith(
        '检测到待确认的离线同步数据',
        expect.any(String),
      );
    });

    it('匿名启动但存在持久云端 owner hint 时应保留 legacy 隔离保护', async () => {
      loadFromStorageSpy.mockRestore();
      initDbSpy.mockResolvedValue(null);
      authServiceMock.currentUserId.mockReturnValue(null);
      authServiceMock.peekPersistedOwnerHint.mockReturnValue('persisted-cloud-user');
      saveToStorageSpy.mockImplementation(() => {
        (service as unknown as { saveToLocalStorage: () => void }).saveToLocalStorage();
        return undefined as unknown as Promise<void>;
      });

      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [
          {
            id: crypto.randomUUID(),
            type: 'task',
            operation: 'upsert',
            data: createTask('t-persisted-hint-legacy-load'),
            projectId: 'p-cloud',
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        savedAt: Date.now(),
      }));

      service.reloadFromStorageForCurrentOwner();

      await vi.waitFor(() => {
        expect(service.getItems()).toEqual([]);
      });

      expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toContain('t-persisted-hint-legacy-load');
      expect(toastMock.warning).toHaveBeenCalledWith(
        '检测到待确认的离线同步数据',
        expect.any(String),
      );
    });

    it('认证态下无法确认归属的 legacy 重试项应隔离保留而不是静默丢弃', async () => {
      const task = createTask('t-legacy-retry');
      (service as unknown as {
        queue: Array<Record<string, unknown>>;
      }).queue = [
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: task,
          projectId: 'p-1',
          retryCount: 0,
          createdAt: Date.now(),
        },
      ];
      setOnline(true);

      await service.processQueue();

      expect(handler.pushTask).not.toHaveBeenCalled();
      expect(service.length).toBe(0);
      expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toContain('t-legacy-retry');
      expect(toastMock.warning).toHaveBeenCalled();
    });

    it('认证态下即使项目已存在也应隔离缺少来源元数据的 legacy 重试项', async () => {
      const task = createTask('t-legacy-adopt');
      projectStateMock.getProject.mockReturnValueOnce({ id: 'p-1', syncSource: 'synced' });
      (service as unknown as {
        queue: Array<Record<string, unknown>>;
      }).queue = [
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: task,
          projectId: 'p-1',
          retryCount: 0,
          createdAt: Date.now(),
        },
      ];
      setOnline(true);

      await service.processQueue();

      expect(handler.pushTask).not.toHaveBeenCalled();
      expect(service.length).toBe(0);
      expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toContain('t-legacy-adopt');
      expect(toastMock.warning).toHaveBeenCalled();
    });

    it('legacy local-user 重试项应隔离保留而不是自动上云', async () => {
      const task = createTask('t-legacy-local-user');
      (service as unknown as {
        queue: Array<Record<string, unknown>>;
      }).queue = [
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: task,
          projectId: 'p-1',
          retryCount: 0,
          createdAt: Date.now(),
          sourceUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
        },
      ];
      setOnline(true);

      await service.processQueue();

      expect(handler.pushTask).not.toHaveBeenCalled();
      expect(service.length).toBe(0);
      expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toContain('legacy local-user');
    });

    it('legacy local-user blackbox 重试项隔离时应把本地条目标记为 conflict', async () => {
      const entry = createBlackBoxEntry('legacy-local-user-blackbox', {
        syncStatus: 'pending',
      });
      (service as unknown as {
        queue: Array<Record<string, unknown>>;
      }).queue = [
        {
          id: crypto.randomUUID(),
          type: 'blackbox',
          operation: 'upsert',
          data: entry,
          retryCount: 0,
          createdAt: Date.now(),
          sourceUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
        },
      ];
      setOnline(true);

      await service.processQueue();

      expect(handler.pushBlackBoxEntry).not.toHaveBeenCalled();
      expect(blackBoxSyncMock.markEntrySyncConflict).toHaveBeenCalledWith(entry);
      expect(service.length).toBe(0);
    });

    it('blackbox 重试超过上限时应把本地 pending 标记为 conflict', async () => {
      const entry = createBlackBoxEntry('max-retry-blackbox', {
        syncStatus: 'pending',
      });
      (service as unknown as {
        queue: Array<Record<string, unknown>>;
        MAX_RETRIES: number;
      }).queue = [
        {
          id: crypto.randomUUID(),
          type: 'blackbox',
          operation: 'upsert',
          data: entry,
          retryCount: (service as unknown as { MAX_RETRIES: number }).MAX_RETRIES - 1,
          createdAt: Date.now(),
          sourceUserId: 'test-user',
        },
      ];
      (handler.pushBlackBoxEntry as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
      setOnline(true);

      await service.processQueue();

      expect(handler.pushBlackBoxEntry).toHaveBeenCalledWith(
        entry,
        'test-user',
        expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
      );
      expect(blackBoxSyncMock.markEntrySyncConflict).toHaveBeenCalledWith(entry);
      expect(service.length).toBe(0);
    });

    it('应修复历史 legacy review 中遗留的 blackbox pending 状态', () => {
      const entry = createBlackBoxEntry('legacy-review-blackbox', {
        syncStatus: 'pending',
        updatedAt: '2026-05-11T00:00:10.000Z',
      });
      localStorage.setItem(
        'nanoflow.retry-queue.legacy-review.__legacy_unknown__',
        JSON.stringify([
          {
            item: {
              id: crypto.randomUUID(),
              type: 'blackbox',
              operation: 'upsert',
              data: entry,
              retryCount: 0,
              createdAt: Date.now(),
              sourceUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
            },
            reason: 'legacy local-user 重试项禁止自动上云',
            quarantinedAt: '2026-05-11T00:00:00.000Z',
            ownerUserId: '__legacy_unknown__',
          },
        ]),
      );

      (service as unknown as {
        repairQuarantinedBlackBoxEntriesFromStorage: () => void;
      }).repairQuarantinedBlackBoxEntriesFromStorage();

      expect(blackBoxSyncMock.markEntrySyncConflict).toHaveBeenCalledWith(entry);
    });

    it('历史 legacy review 修复应忽略其它账号的 blackbox 条目', () => {
      const foreignEntry = createBlackBoxEntry('legacy-review-foreign-blackbox', {
        userId: 'other-user',
        syncStatus: 'pending',
        updatedAt: '2026-05-11T00:00:20.000Z',
      });
      localStorage.setItem(
        'nanoflow.retry-queue.legacy-review.other-user',
        JSON.stringify([
          {
            item: {
              id: crypto.randomUUID(),
              type: 'blackbox',
              operation: 'upsert',
              data: foreignEntry,
              retryCount: 0,
              createdAt: Date.now(),
              sourceUserId: 'other-user',
            },
            reason: '跨账号重试项来源 other-user 与当前账号 test-user 不匹配',
            quarantinedAt: '2026-05-11T00:00:20.000Z',
            ownerUserId: 'other-user',
          },
        ]),
      );

      (service as unknown as {
        repairQuarantinedBlackBoxEntriesFromStorage: () => void;
      }).repairQuarantinedBlackBoxEntriesFromStorage();

      expect(blackBoxSyncMock.markEntrySyncConflict).not.toHaveBeenCalledWith(foreignEntry);
    });

    it('历史 legacy review 修复应优先采用同一条目的最新 blackbox 快照', () => {
      const entryId = stableUUID('legacy-review-blackbox-latest');
      const olderEntry = createBlackBoxEntry('legacy-review-blackbox-latest-old', {
        id: entryId,
        syncStatus: 'pending',
        updatedAt: '2026-05-11T00:00:05.000Z',
        content: 'old snapshot',
      });
      const newerEntry = createBlackBoxEntry('legacy-review-blackbox-latest-new', {
        id: entryId,
        syncStatus: 'pending',
        updatedAt: '2026-05-11T00:00:30.000Z',
        content: 'new snapshot',
      });
      localStorage.setItem(
        'nanoflow.retry-queue.legacy-review.test-user',
        JSON.stringify([
          {
            item: {
              id: crypto.randomUUID(),
              type: 'blackbox',
              operation: 'upsert',
              data: olderEntry,
              retryCount: 0,
              createdAt: Date.now(),
              sourceUserId: 'test-user',
            },
            reason: 'older snapshot',
            quarantinedAt: '2026-05-11T00:00:05.000Z',
            ownerUserId: 'test-user',
          },
          {
            item: {
              id: crypto.randomUUID(),
              type: 'blackbox',
              operation: 'upsert',
              data: newerEntry,
              retryCount: 0,
              createdAt: Date.now(),
              sourceUserId: 'test-user',
            },
            reason: 'newer snapshot',
            quarantinedAt: '2026-05-11T00:00:30.000Z',
            ownerUserId: 'test-user',
          },
        ]),
      );

      (service as unknown as {
        repairQuarantinedBlackBoxEntriesFromStorage: () => void;
      }).repairQuarantinedBlackBoxEntriesFromStorage();

      expect(blackBoxSyncMock.markEntrySyncConflict).toHaveBeenCalledTimes(1);
      expect(blackBoxSyncMock.markEntrySyncConflict).toHaveBeenCalledWith(newerEntry);
    });

    it('本地模式下 local-user 重试残留应静默清理且不弹待确认提示', async () => {
      authServiceMock.currentUserId.mockReturnValue(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      const task = createTask('t-local-mode-leftover');
      (service as unknown as {
        queue: Array<Record<string, unknown>>;
      }).queue = [
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: task,
          projectId: 'p-1',
          retryCount: 0,
          createdAt: Date.now(),
          sourceUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
        },
      ];
      setOnline(true);

      await service.processQueue();

      expect(handler.pushTask).not.toHaveBeenCalled();
      expect(service.length).toBe(0);
      expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.__legacy_unknown__')).toBeNull();
      expect(toastMock.warning).not.toHaveBeenCalledWith(
        '检测到待确认的离线同步数据',
        expect.any(String),
      );
    });

    it('仅清理终止态残留时也应回写 pendingCount，避免 UI 持续显示待同步', async () => {
      const task = createTask('t-terminal-cleanup-pending-count');
      (service as unknown as {
        queue: Array<Record<string, unknown>>;
      }).queue = [
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: task,
          // 缺少 projectId 会进入终止态清理分支，且不会发起网络同步。
          retryCount: 0,
          createdAt: Date.now(),
          sourceUserId: 'test-user',
        },
      ];
      setOnline(true);
      vi.mocked(handler.onProcessingStateChange).mockClear();

      await service.processQueue();

      expect(handler.pushTask).not.toHaveBeenCalled();
      expect(service.length).toBe(0);
      expect(handler.onProcessingStateChange).not.toHaveBeenCalledWith(true, expect.any(Number));
      expect(handler.onProcessingStateChange).toHaveBeenCalledWith(false, 0);
    });

    it('跨账号重试项应隔离保留而不是在当前账号下重放', async () => {
      const task = createTask('t-foreign-user');
      (service as unknown as {
        queue: Array<Record<string, unknown>>;
      }).queue = [
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: task,
          projectId: 'p-1',
          retryCount: 0,
          createdAt: Date.now(),
          sourceUserId: 'other-user',
        },
      ];
      setOnline(true);

      await service.processQueue();

      expect(handler.pushTask).not.toHaveBeenCalled();
      expect(service.length).toBe(0);
      expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.other-user')).toContain('other-user');
    });

  });
}
