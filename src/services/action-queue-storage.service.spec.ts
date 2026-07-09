import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import {
  ActionQueueStorageService,
  LOCAL_QUEUE_CONFIG,
  ActionQueueContext,
} from './action-queue-storage.service';
import {
  registerActionQueueStoragePureHelperSpecs,
  registerActionQueueStorageRetrySpecs,
  registerActionQueueStorageTailSpecs,
} from './action-queue-storage-tail.spec-helpers';
import { registerActionQueueStorageCoreSpecs } from './action-queue-storage-core.spec-helpers';
import { registerActionQueueStorageOwnerSettlementSpecs } from './action-queue-storage-owner-settlement.spec-helpers';
import { registerActionQueueStorageDeadLetterRestoreSpecs } from './action-queue-storage-dead-letter-restore.spec-helpers';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { AuthService } from './auth.service';
import { QueueBackupService } from './queue-backup.service';
import { ActionQueueOwnerStorageService } from './action-queue-owner-storage.service';
import { ActionQueueSchedulerService } from './action-queue-scheduler.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import {
  createMockAction,
  createMockContext,
  flushQueueBackupRestore,
  mockLoggerCategory,
  mockLoggerService,
  mockNetworkAwarenessService,
  mockQueueBackupService,
  mockToastService,
  resetQueueBackupMocks,
} from './action-queue-storage.spec-helpers';
import type { QueuedAction } from './action-queue.types';

describe('ActionQueueStorageService', () => {
  let service: ActionQueueStorageService;
  let ctx: ActionQueueContext;
  let currentUserId: ReturnType<typeof signal<string | null>>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    resetQueueBackupMocks();
    currentUserId = signal<string | null>('user-a');

    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const injector = Injector.create({
      providers: [
        ActionQueueStorageService,
        ActionQueueOwnerStorageService,
        ActionQueueSchedulerService,
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ToastService, useValue: mockToastService },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        { provide: NetworkAwarenessService, useValue: mockNetworkAwarenessService },
        { provide: AuthService, useValue: { currentUserId } },
        { provide: QueueBackupService, useValue: mockQueueBackupService },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(ActionQueueStorageService));
    ctx = createMockContext();
    service.init(ctx);
  });

  afterEach(() => {
    service.reset();
    consoleWarnSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
  });

  registerActionQueueStorageCoreSpecs({
    getService: () => service,
    getContext: () => ctx,
  });

  // ==================== 持久化操作 ====================

  describe('storage persistence', () => {
    it('saveQueueToStorage should persist pending actions to localStorage', () => {
      const action = createMockAction();
      ctx.pendingActions.set([action]);

      service.saveQueueToStorage();

      const saved = localStorage.getItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`);
      expect(saved).toBeTruthy();
      const parsed = JSON.parse(saved!);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe(action.id);
      expect(mockQueueBackupService.backupQueue).toHaveBeenCalledWith([action], 'user-a');
    });

    it('saveQueueToStorage 在 localStorage 不可用时应写入 IndexedDB 备份而不是形成内存队列', async () => {
      const action = createMockAction({ id: 'no-local-storage-action' });
      const originalLocalStorage = globalThis.localStorage;

      Object.defineProperty(globalThis, 'localStorage', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      try {
        ctx.pendingActions.set([action]);

        service.saveQueueToStorage();
        await flushQueueBackupRestore();

        expect(mockQueueBackupService.backupQueue).toHaveBeenCalledWith([action], 'user-a');
        expect(ctx.pendingActions()).toEqual([action]);
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          value: originalLocalStorage,
          configurable: true,
          writable: true,
        });
      }
    });

    it('saveQueueToStorage 在 localStorage 配额失败但 IDB 备份成功后应让旧快照失效', async () => {
      const staleAction = createMockAction({ id: 'stale-local-action' });
      const freshAction = createMockAction({ id: 'fresh-idb-action' });
      const scopedKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`;
      const originalLocalStorage = globalThis.localStorage;
      const storageData = new Map<string, string>([[scopedKey, JSON.stringify([staleAction])]]);
      const quotaStorage = {
        getItem: (key: string) => storageData.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (key === scopedKey) {
            throw new DOMException('quota exceeded', 'QuotaExceededError');
          }
          storageData.set(key, String(value));
        },
        removeItem: (key: string) => {
          storageData.delete(key);
        },
        clear: () => {
          storageData.clear();
        },
        key: (index: number) => Array.from(storageData.keys())[index] ?? null,
        get length() {
          return storageData.size;
        },
      } as Storage;

      Object.defineProperty(globalThis, 'localStorage', {
        value: quotaStorage,
        configurable: true,
        writable: true,
      });

      try {
        ctx.pendingActions.set([freshAction]);

        mockQueueBackupService.backupQueue.mockResolvedValue(true);
        mockQueueBackupService.restoreQueue.mockResolvedValue([freshAction]);

        service.saveQueueToStorage();
        await flushQueueBackupRestore();

        expect(mockQueueBackupService.backupQueue).toHaveBeenCalled();
        expect(globalThis.localStorage.getItem(scopedKey)).toBeNull();

        ctx.pendingActions.set([]);
        ctx.queueSize.set(0);
        service.loadQueueFromStorage();
        await flushQueueBackupRestore();

        expect(mockQueueBackupService.restoreQueue).toHaveBeenCalled();
        expect(ctx.pendingActions()).toEqual([freshAction]);
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          value: originalLocalStorage,
          configurable: true,
          writable: true,
        });
      }
    });

    it('saveQueueToStorage 在 localStorage 普通写失败但 IDB 备份成功后应从持久备份恢复', async () => {
      const freshAction = createMockAction({ id: 'fresh-security-fallback-action' });
      const scopedKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`;
      const originalLocalStorage = globalThis.localStorage;
      const storageData = new Map<string, string>();
      const failingStorage = {
        getItem: (key: string) => storageData.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (key === scopedKey) {
            throw new DOMException('blocked', 'SecurityError');
          }
          storageData.set(key, String(value));
        },
        removeItem: (key: string) => {
          storageData.delete(key);
        },
        clear: () => {
          storageData.clear();
        },
        key: (index: number) => Array.from(storageData.keys())[index] ?? null,
        get length() {
          return storageData.size;
        },
      } as Storage;

      Object.defineProperty(globalThis, 'localStorage', {
        value: failingStorage,
        configurable: true,
        writable: true,
      });

      try {
        ctx.pendingActions.set([freshAction]);
        mockQueueBackupService.backupQueue.mockResolvedValue(true);
        mockQueueBackupService.restoreQueue.mockResolvedValue([freshAction]);

        service.saveQueueToStorage();
        await flushQueueBackupRestore();

        expect(mockQueueBackupService.backupQueue).toHaveBeenCalledWith([freshAction], 'user-a');
        expect(globalThis.localStorage.getItem(scopedKey)).toBeNull();

        ctx.pendingActions.set([]);
        ctx.queueSize.set(0);
        service.loadQueueFromStorage();
        await flushQueueBackupRestore();

        expect(mockQueueBackupService.restoreQueue).toHaveBeenCalledWith('user-a', expect.any(Function));
        expect(ctx.pendingActions()).toEqual([freshAction]);
        expect(ctx.queueSize()).toBe(1);
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          value: originalLocalStorage,
          configurable: true,
          writable: true,
        });
      }
    });

    it('saveQueueSnapshotForOwner 在 localStorage 配额失败时应优先使用 IDB 版本恢复 owner 队列', async () => {
      const staleAction = createMockAction({ id: 'stale-owner-action' });
      const freshAction = createMockAction({ id: 'fresh-owner-action' });
      const scopedKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`;
      const originalLocalStorage = globalThis.localStorage;
      const storageData = new Map<string, string>([[scopedKey, JSON.stringify([staleAction])]]);
      const quotaStorage = {
        getItem: (key: string) => storageData.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (key === scopedKey) {
            throw new DOMException('quota exceeded', 'QuotaExceededError');
          }
          storageData.set(key, String(value));
        },
        removeItem: (key: string) => {
          storageData.delete(key);
        },
        clear: () => {
          storageData.clear();
        },
        key: (index: number) => Array.from(storageData.keys())[index] ?? null,
        get length() {
          return storageData.size;
        },
      } as Storage;

      Object.defineProperty(globalThis, 'localStorage', {
        value: quotaStorage,
        configurable: true,
        writable: true,
      });

      try {
        mockQueueBackupService.backupQueue.mockResolvedValue(true);
        mockQueueBackupService.restoreQueue.mockResolvedValue([freshAction]);

        await (service as unknown as {
          saveQueueSnapshotForOwner: (ownerUserId: string, queue: QueuedAction[]) => Promise<void>;
        }).saveQueueSnapshotForOwner('user-a', [freshAction]);

        const loaded = await (service as unknown as {
          loadPersistedQueueForOwner: (ownerUserId: string) => Promise<QueuedAction[]>;
        }).loadPersistedQueueForOwner('user-a');

        expect(globalThis.localStorage.getItem(scopedKey)).toBeNull();
        expect(loaded).toEqual([freshAction]);
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          value: originalLocalStorage,
          configurable: true,
          writable: true,
        });
      }
    });

    it('persistQueueSnapshotForOwner 在 IndexedDB 备份失败时不应把 localStorage 镜像当作 durable 成功', async () => {
      const action = createMockAction({ id: 'local-only-durable-action' });

      mockQueueBackupService.backupQueue.mockResolvedValueOnce(false);

      const saved = await service.persistQueueSnapshotForOwner('user-a', [action]);

      expect(saved).toBe(false);
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`)).toBeTruthy();
      expect(service.storageFailure()).toBe(true);
      expect(service.queueFrozen()).toBe(true);
    });

    it('loadQueueFromStorage should restore queue from localStorage', () => {
      const action = createMockAction();
      localStorage.setItem(
        `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`,
        JSON.stringify([action])
      );

      service.loadQueueFromStorage();

      expect(ctx.pendingActions().length).toBe(1);
      expect(ctx.queueSize()).toBe(1);
    });

    it('loadQueueFromStorage should let IndexedDB Outbox override stale localStorage mirror', async () => {
      const staleAction = createMockAction({ id: 'stale-local-mirror' });
      const durableAction = createMockAction({ id: 'durable-idb-outbox' });
      localStorage.setItem(
        `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`,
        JSON.stringify([staleAction])
      );
      mockQueueBackupService.restoreQueue.mockResolvedValueOnce([durableAction]);

      service.loadQueueFromStorage();
      await flushQueueBackupRestore();

      expect(mockQueueBackupService.restoreQueue).toHaveBeenCalledWith('user-a', expect.any(Function));
      expect(ctx.pendingActions().map(action => action.id)).toEqual(['durable-idb-outbox']);
      expect(ctx.queueSize()).toBe(1);
    });

    it('loadQueueFromStorage should preserve foreground writes while IndexedDB restore is pending', async () => {
      const localAction = createMockAction({
        id: 'local-before-restore',
        operationId: 'op-local-before-restore',
      });
      const foregroundAction = createMockAction({
        id: 'foreground-during-restore',
        operationId: 'op-foreground-during-restore',
      });
      const backupDuplicate = createMockAction({
        id: 'backup-duplicate-local',
        operationId: 'op-local-before-restore',
      });
      const backupOnlyAction = createMockAction({
        id: 'backup-only-action',
        operationId: 'op-backup-only-action',
      });
      let resolveRestore: (queue: QueuedAction[]) => void = () => {};
      const restorePromise = new Promise<QueuedAction[]>((resolve) => {
        resolveRestore = resolve;
      });
      localStorage.setItem(
        `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`,
        JSON.stringify([localAction])
      );
      mockQueueBackupService.restoreQueue.mockReturnValueOnce(restorePromise);

      service.loadQueueFromStorage();
      expect(ctx.pendingActions().map(action => action.id)).toEqual(['local-before-restore']);

      ctx.pendingActions.set([localAction, foregroundAction]);
      ctx.queueSize.set(2);
      resolveRestore([backupDuplicate, backupOnlyAction]);
      await flushQueueBackupRestore();

      expect(ctx.pendingActions().map(action => action.id)).toEqual([
        'local-before-restore',
        'foreground-during-restore',
        'backup-only-action',
      ]);
      expect(ctx.queueSize()).toBe(3);
    });

    it('loadQueueFromStorage should preserve foreground updates to existing actions while IndexedDB restore is pending', async () => {
      const localAction = createMockAction({
        id: 'local-action-before-restore-update',
        operationId: '22222222-2222-4222-8222-222222222222',
        retryCount: 0,
        syncState: 'pending_sync',
        localCommittedAt: 100,
      });
      const foregroundUpdatedAction = {
        ...localAction,
        retryCount: 4,
        syncState: 'retry_scheduled' as const,
        localCommittedAt: 200,
      };
      const staleBackupAction = createMockAction({
        id: 'stale-backup-copy',
        operationId: '22222222-2222-4222-8222-222222222222',
        retryCount: 0,
        syncState: 'pending_sync',
        localCommittedAt: 100,
      });
      let resolveRestore: (queue: QueuedAction[]) => void = () => {};
      const restorePromise = new Promise<QueuedAction[]>((resolve) => {
        resolveRestore = resolve;
      });
      localStorage.setItem(
        `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`,
        JSON.stringify([localAction])
      );
      mockQueueBackupService.restoreQueue.mockReturnValueOnce(restorePromise);

      service.loadQueueFromStorage();
      expect(ctx.pendingActions()).toEqual([expect.objectContaining({ retryCount: 0 })]);

      ctx.pendingActions.set([foregroundUpdatedAction]);
      ctx.queueSize.set(1);
      resolveRestore([staleBackupAction]);
      await flushQueueBackupRestore();

      expect(ctx.pendingActions()).toEqual([
        expect.objectContaining({
          id: 'local-action-before-restore-update',
          operationId: '22222222-2222-4222-8222-222222222222',
          retryCount: 4,
          syncState: 'retry_scheduled',
          localCommittedAt: 200,
        }),
      ]);
      expect(ctx.queueSize()).toBe(1);
    });

    it('loadQueueFromStorage should isolate rejected IndexedDB backup restore', async () => {
      const restoreError = new Error('idb restore failed');
      mockQueueBackupService.restoreQueue.mockRejectedValueOnce(restoreError);

      service.loadQueueFromStorage();
      await flushQueueBackupRestore();

      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'IndexedDB 队列备份恢复失败，保留当前队列视图',
        expect.objectContaining({ ownerUserId: 'user-a', error: restoreError }),
      );
      expect(ctx.pendingActions()).toEqual([]);
      expect(ctx.queueSize()).toBe(0);
    });

    it('loadQueueFromStorage should recover interrupted syncing actions as pending_sync', () => {
      const action = createMockAction({
        id: 'interrupted-syncing-action',
        syncState: 'syncing',
      });
      localStorage.setItem(
        `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`,
        JSON.stringify([action])
      );

      service.loadQueueFromStorage();

      expect(ctx.pendingActions()[0].syncState).toBe('pending_sync');
    });

    it('loadQueueFromStorage should ignore another owner scoped queue', () => {
      const foreignAction = createMockAction({ id: 'foreign-action' });
      localStorage.setItem(
        `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.other-user`,
        JSON.stringify([foreignAction])
      );

      service.loadQueueFromStorage();

      expect(ctx.pendingActions()).toEqual([]);
      expect(ctx.queueSize()).toBe(0);
    });

    it('loadQueueFromStorage should quarantine signed-in legacy global queue into unknown-owner bucket', () => {
      const legacyAction = createMockAction({ id: 'legacy-global-action' });
      localStorage.setItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, JSON.stringify([legacyAction]));

      service.loadQueueFromStorage();

      expect(ctx.pendingActions()).toEqual([]);
      expect(service.deadLetterQueue()).toEqual([]);
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`)).toBeNull();
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`)).toBeNull();
      expect(localStorage.getItem('nanoflow.action-queue.legacy-review.__legacy_unknown__')).toContain('legacy-global-action');
      expect(localStorage.getItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY)).toBeNull();
    });

    it('loadQueueFromStorage should quarantine legacy global queue even for local-user', () => {
      currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      const action = createMockAction();
      localStorage.setItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, JSON.stringify([action]));

      service.loadQueueFromStorage();

      expect(ctx.pendingActions()).toEqual([]);
      expect(localStorage.getItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY)).toBeNull();
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.${AUTH_CONFIG.LOCAL_MODE_USER_ID}`)).toBeNull();
      expect(localStorage.getItem('nanoflow.action-queue.legacy-review.__legacy_unknown__')).toContain(action.id);
    });

    it('saveQueueToStorage should not delete untouched legacy global queue for signed-in owners', () => {
      const legacyAction = createMockAction({ id: 'legacy-global-action' });
      const scopedAction = createMockAction({ id: 'scoped-user-action' });
      localStorage.setItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, JSON.stringify([legacyAction]));
      ctx.pendingActions.set([scopedAction]);

      service.saveQueueToStorage();

      expect(localStorage.getItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY)).toContain('legacy-global-action');
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`)).toContain('scoped-user-action');
    });

    it('saveQueueToStorage should enter escape mode when IndexedDB quota fallback rejects', async () => {
      const originalLocalStorage = globalThis.localStorage;
      const scopedKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`;
      const storageData = new Map<string, string>();
      const quotaStorage = {
        getItem: (key: string) => storageData.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (key === scopedKey) {
            throw new DOMException('quota exceeded', 'QuotaExceededError');
          }
          storageData.set(key, String(value));
        },
        removeItem: (key: string) => {
          storageData.delete(key);
        },
        clear: () => {
          storageData.clear();
        },
        key: (index: number) => Array.from(storageData.keys())[index] ?? null,
        get length() {
          return storageData.size;
        },
      } as Storage;
      const queuedAction = createMockAction({ id: 'quota-backup-reject' });
      const backupError = new Error('idb backup failed');
      const storageFailureCallback = vi.fn();

      Object.defineProperty(globalThis, 'localStorage', {
        value: quotaStorage,
        configurable: true,
        writable: true,
      });

      try {
        ctx.pendingActions.set([queuedAction]);
        service.onStorageFailure(storageFailureCallback);
        mockQueueBackupService.backupQueue.mockRejectedValueOnce(backupError);

        service.saveQueueToStorage();
        await flushQueueBackupRestore();

        expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
          'IndexedDB 队列备份失败，进入存储逃生模式',
          expect.objectContaining({ ownerUserId: 'user-a', error: backupError }),
        );
        expect(service.storageFailure()).toBe(true);
        expect(service.queueFrozen()).toBe(true);
        expect(service.queueFreezeReason()).toBe('storage_failure');
        expect(storageFailureCallback).toHaveBeenCalledWith({
          queue: [queuedAction],
          deadLetter: [],
        });
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          value: originalLocalStorage,
          configurable: true,
          writable: true,
        });
      }
    });

    it('loadQueueFromStorage should handle corrupted data gracefully', () => {
      localStorage.setItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`, '{invalid json}');

      expect(() => service.loadQueueFromStorage()).not.toThrow();
      expect(mockLoggerCategory.warn).toHaveBeenCalled();
    });

    it('loadQueueFromStorage should freeze instead of treating corrupt local queue with no backup as empty', async () => {
      const scopedKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`;
      const corruptedSnapshot = '{invalid json}';
      const storageFailureCallback = vi.fn();
      localStorage.setItem(scopedKey, corruptedSnapshot);
      mockQueueBackupService.restoreQueue.mockResolvedValueOnce(null);
      service.onStorageFailure(storageFailureCallback);

      service.loadQueueFromStorage();
      await flushQueueBackupRestore();

      expect(mockQueueBackupService.restoreQueue).toHaveBeenCalledWith('user-a', expect.any(Function));
      expect(service.storageFailure()).toBe(true);
      expect(service.queueFrozen()).toBe(true);
      expect(service.queueFreezeReason()).toBe('storage_failure');
      expect(storageFailureCallback).toHaveBeenCalledWith({
        queue: [],
        deadLetter: [],
      });
      expect(localStorage.getItem(scopedKey)).toBe(corruptedSnapshot);
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'owner-scoped 队列快照损坏且 IndexedDB 备份不可用，已冻结队列写入避免静默丢失',
        expect.objectContaining({
          ownerUserId: 'user-a',
          storageKey: scopedKey,
        }),
      );
    });

    it('loadQueueFromStorage should accept an empty IndexedDB backup record for a corrupt local mirror', async () => {
      const scopedKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`;
      localStorage.setItem(scopedKey, '{invalid json}');
      mockQueueBackupService.restoreQueue.mockResolvedValueOnce([]);

      service.loadQueueFromStorage();
      await flushQueueBackupRestore();

      expect(service.storageFailure()).toBe(false);
      expect(service.queueFrozen()).toBe(false);
      expect(ctx.pendingActions()).toEqual([]);
      expect(ctx.queueSize()).toBe(0);
    });

    it('saveDeadLetterToStorage should persist dead letter queue', () => {
      const action = createMockAction();
      service.moveToDeadLetter(action, 'test');

      const saved = localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`);
      expect(saved).toBeTruthy();
      const parsed = JSON.parse(saved!);
      expect(parsed).toHaveLength(1);
    });

    it('saveDeadLetterToStorage should freeze and expose escape data when dead-letter persistence fails', () => {
      const originalLocalStorage = globalThis.localStorage;
      const storageData = new Map<string, string>();
      const failingStorage = {
        getItem: (key: string) => storageData.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (key === `${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`) {
            throw new DOMException('quota exceeded', 'QuotaExceededError');
          }
          storageData.set(key, String(value));
        },
        removeItem: (key: string) => {
          storageData.delete(key);
        },
        clear: () => {
          storageData.clear();
        },
        key: (index: number) => Array.from(storageData.keys())[index] ?? null,
        get length() {
          return storageData.size;
        },
      } as Storage;
      const storageFailureCallback = vi.fn();

      Object.defineProperty(globalThis, 'localStorage', {
        value: failingStorage,
        configurable: true,
        writable: true,
      });

      try {
        const action = createMockAction({ id: 'dead-letter-save-failure' });
        service.onStorageFailure(storageFailureCallback);

        service.moveToDeadLetter(action, 'quota');

        expect(service.queueFrozen()).toBe(true);
        expect(service.queueFreezeReason()).toBe('storage_failure');
        expect(storageFailureCallback).toHaveBeenCalledWith({
          queue: [],
          deadLetter: [
            expect.objectContaining({
              action: expect.objectContaining({
                id: action.id,
                syncState: 'dead_letter',
              }),
            }),
          ],
        });
        expect(globalThis.localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`)).toBeNull();
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          value: originalLocalStorage,
          configurable: true,
          writable: true,
        });
      }
    });

    registerActionQueueStorageOwnerSettlementSpecs({
      getService: () => service,
      createMockAction,
      getCurrentUserId: () => currentUserId,
      backupDeadLetters: (ownerUserId, items) =>
        mockQueueBackupService.backupDeadLetters(items, ownerUserId),
    });

    registerActionQueueStorageDeadLetterRestoreSpecs({
      getService: () => service,
      createMockAction,
      setCurrentUserId: userId => currentUserId.set(userId),
      backupDeadLetters: (ownerUserId, items) =>
        mockQueueBackupService.backupDeadLetters(items, ownerUserId),
      flushBackupRestore: flushQueueBackupRestore,
    });
  });

  registerActionQueueStorageRetrySpecs({
    getService: () => service,
    getContext: () => ctx,
    createMockAction,
    mockLoggerCategory,
    mockSentryLazyLoaderService,
    mockToastService,
  });

  // ==================== pauseDependentActions ====================

  registerActionQueueStorageTailSpecs({
    getService: () => service,
    getContext: () => ctx,
    createMockAction,
    mockLoggerCategory,
    mockSentryLazyLoaderService,
    mockToastService,
  });
});

registerActionQueueStoragePureHelperSpecs(createMockAction);
