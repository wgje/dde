import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendCappedDeadLetterItem,
  buildFailedOwnerDeadLetterReason,
  classifyQueueRetryError,
  LOCAL_QUEUE_CONFIG,
  resolveQueueRetryDelay,
  type ActionQueueContext,
  type ActionQueueStorageService,
} from './action-queue-storage.service';
import {
  buildActionQueueEscapeExportFilename,
  buildActionQueueEscapeExportJson,
} from './action-queue-escape-export.helpers';
import {
  flushQueueBackupRestore,
  mockQueueBackupService,
} from './action-queue-storage.spec-helpers';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';

interface ActionQueueStorageTailSpecContext {
  getService: () => ActionQueueStorageService;
  getContext: () => ActionQueueContext;
  createMockAction: (overrides?: Partial<QueuedAction>) => QueuedAction;
  mockLoggerCategory: {
    warn: (...args: unknown[]) => unknown;
  };
  mockSentryLazyLoaderService: {
    captureMessage: (...args: unknown[]) => unknown;
  };
  mockToastService: {
    warning: (...args: unknown[]) => unknown;
  };
}

interface FrozenQueueControl {
  freezeQueueWrites: (reason: string) => void;
  clearQueueFreeze: () => void;
}

function frozenQueueControl(service: ActionQueueStorageService): FrozenQueueControl {
  return service as unknown as FrozenQueueControl;
}

export function registerActionQueueStorageTailSpecs(context: ActionQueueStorageTailSpecContext): void {
  describe('helper methods', () => {
    it('getActionDescription should return human-readable description', () => {
      const action = context.createMockAction({ type: 'create', entityType: 'task' });
      expect(context.getService().getActionDescription(action)).toContain('任务');
    });

    it('getActionLabel should return human-readable label', () => {
      const action = context.createMockAction({ type: 'update', entityType: 'project' });
      expect(context.getService().getActionLabel(action)).toContain('项目');
    });

    it('getActionLabel should describe connection actions in Chinese', () => {
      const action = context.createMockAction({
        type: 'update',
        entityType: 'connection',
        entityId: 'connection-label',
        payload: {
          connection: { id: 'connection-label', source: 'task-a', target: 'task-b' },
          projectId: 'project-1',
        } as never,
      });

      expect(context.getService().getActionDescription(action)).toBe('更新连接');
      expect(context.getService().getActionLabel(action)).toBe('更新连接');
    });
  });

  describe('pauseDependentActions', () => {
    it('should log warning when dependent actions exist', () => {
      const queue: QueuedAction[] = [
        context.createMockAction({ type: 'update', entityType: 'task', entityId: 'task-1' }),
        context.createMockAction({ type: 'delete', entityType: 'task', entityId: 'task-1' }),
      ];

      context.getService().pauseDependentActions('task', 'task-1', queue);

      expect(context.mockLoggerCategory.warn).toHaveBeenCalled();
      expect(context.mockSentryLazyLoaderService.captureMessage).toHaveBeenCalled();
    });

    it('should not log when there are no dependent actions', () => {
      const queue: QueuedAction[] = [
        context.createMockAction({ type: 'create', entityType: 'task', entityId: 'task-1' }),
      ];

      context.getService().pauseDependentActions('task', 'task-1', queue);

      // create type is excluded from dependents
      expect(context.mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    });

    it('should show toast when critical actions are blocked', () => {
      const queue: QueuedAction[] = [
        context.createMockAction({
          type: 'update',
          entityType: 'task',
          entityId: 'task-1',
          priority: 'critical',
        }),
      ];

      context.getService().pauseDependentActions('task', 'task-1', queue);

      expect(context.mockToastService.warning).toHaveBeenCalled();
    });
  });

  describe('network and reset', () => {
    it('should track online status', () => {
      const service = context.getService();
      service.isOnline = false;
      expect(service.isOnline).toBe(false);

      service.isOnline = true;
      expect(service.isOnline).toBe(true);
    });

    it('reset should clear all state', () => {
      const service = context.getService();
      service.moveToDeadLetter(context.createMockAction(), 'reason');
      expect(service.hasDeadLetters()).toBe(true);

      service.reset();

      expect(service.hasDeadLetters()).toBe(false);
      expect(service.deadLetterSize()).toBe(0);
      expect(service.storageFailure()).toBe(false);
      expect(service.isOnline).toBe(true);
    });
  });

  describe('storage restore', () => {
    it('loadQueueFromStorage 应保留比 IndexedDB 备份更新的 localStorage 操作副本', async () => {
      const operationId = 'restore-local-newer-shared-operation';
      const localAction = context.createMockAction({
        id: 'local-newer-action-copy',
        operationId,
        retryCount: 3,
        syncState: 'retry_scheduled',
        timestamp: 200,
        localCommittedAt: 300,
      });
      const staleBackupAction = context.createMockAction({
        id: 'stale-backup-action-copy',
        operationId,
        retryCount: 0,
        syncState: 'pending_sync',
        timestamp: 100,
        localCommittedAt: 100,
      });
      localStorage.setItem(
        `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`,
        JSON.stringify([localAction])
      );
      mockQueueBackupService.restoreQueue.mockResolvedValueOnce([staleBackupAction]);

      context.getService().loadQueueFromStorage();
      await flushQueueBackupRestore();

      expect(context.getContext().pendingActions()).toEqual([
        expect.objectContaining({
          id: 'local-newer-action-copy',
          operationId: expect.any(String),
          retryCount: 3,
          syncState: 'retry_scheduled',
          localCommittedAt: 300,
        }),
      ]);
    });

    it('loadQueueFromStorage 应保留 IndexedDB 备份缺失的 localStorage-only 操作', async () => {
      const localOnlyAction = context.createMockAction({
        id: 'local-only-action-copy',
        operationId: 'restore-local-only-operation',
        retryCount: 2,
        syncState: 'retry_scheduled',
        timestamp: 250,
        localCommittedAt: 250,
      });
      const backupOnlyAction = context.createMockAction({
        id: 'backup-only-action-copy',
        operationId: 'restore-backup-only-operation',
        timestamp: 100,
        localCommittedAt: 100,
      });
      localStorage.setItem(
        `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`,
        JSON.stringify([localOnlyAction])
      );
      mockQueueBackupService.restoreQueue.mockResolvedValueOnce([backupOnlyAction]);

      context.getService().loadQueueFromStorage();
      await flushQueueBackupRestore();

      expect(context.getContext().pendingActions().map(action => action.id)).toEqual([
        'local-only-action-copy',
        'backup-only-action-copy',
      ]);
      expect(context.getContext().pendingActions().find(action => action.id === 'local-only-action-copy'))
        .toEqual(expect.objectContaining({
          retryCount: 2,
          syncState: 'retry_scheduled',
        }));
    });

    it('loadQueueFromStorage 应在 IndexedDB 备份恢复出操作后立即触发后台处理', async () => {
      const restoredAction = context.createMockAction({
        id: 'backup-restored-action-drains-immediately',
        operationId: 'restore-backup-drain-operation',
        syncState: 'pending_sync',
        timestamp: 100,
        localCommittedAt: 100,
      });
      mockQueueBackupService.restoreQueue.mockResolvedValueOnce([restoredAction]);

      context.getService().isOnline = true;
      context.getService().loadQueueFromStorage();
      await vi.waitFor(() => {
        expect(context.getContext().pendingActions().map(action => action.id)).toEqual([
          'backup-restored-action-drains-immediately',
        ]);
        expect(context.getContext().processQueue).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('escape export（逃生导出）', () => {
    it('exportPendingActionsAsJson 应返回有效 JSON', () => {
      const action1 = context.createMockAction({ id: 'a1' });
      const action2 = context.createMockAction({ id: 'a2' });
      context.getContext().pendingActions.set([action1, action2]);

      const result = context.getService().exportPendingActionsAsJson();
      const parsed = JSON.parse(result) as {
        exportedAt?: unknown;
        pendingActions: unknown[];
        metadata: { source?: unknown };
      };

      expect(parsed).toHaveProperty('exportedAt');
      expect(parsed).toHaveProperty('pendingActions');
      expect(parsed.pendingActions).toHaveLength(2);
      expect(parsed.metadata.source).toBe('action-queue-escape');
    });

    it('exportPendingActionsAsJson 空队列也应返回有效 JSON', () => {
      context.getContext().pendingActions.set([]);

      const result = context.getService().exportPendingActionsAsJson();
      const parsed = JSON.parse(result) as { pendingActions: unknown[] };

      expect(parsed.pendingActions).toHaveLength(0);
    });
  });

  describe('frozen retry timer（冻结重试计时器）', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('freezeQueueWrites 应启动重试计时器', () => {
      vi.useFakeTimers();
      const control = frozenQueueControl(context.getService());

      control.freezeQueueWrites('test_pressure');
      expect(context.getService().queueFrozen()).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('clearQueueFreeze 应停止重试计时器', () => {
      vi.useFakeTimers();
      const service = context.getService();
      const control = frozenQueueControl(service);

      control.freezeQueueWrites('test_pressure');
      control.clearQueueFreeze();

      expect(vi.getTimerCount()).toBe(0);
      expect(service.queueFrozen()).toBe(false);
    });

    it('冻结重试 timer handle 为 0 时仍视为活跃计时器', () => {
      const retryTimer = 0 as unknown as ReturnType<typeof setTimeout>;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => retryTimer);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
      const service = context.getService();
      const control = frozenQueueControl(service);

      try {
        control.freezeQueueWrites('test_pressure');
        control.freezeQueueWrites('test_pressure');
        control.clearQueueFreeze();

        expect(setTimeoutSpy).toHaveBeenCalledOnce();
        expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
        expect(service.queueFrozen()).toBe(false);
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });

    it('忽略被取消后晚到的冻结重试 timer 回调', () => {
      const originalLocalStorage = globalThis.localStorage;
      const queuedTimeouts = new Map<number, () => void>();
      let nextTimerId = 1;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
        .mockImplementation((callback: TimerHandler) => {
          const timerId = nextTimerId++;
          queuedTimeouts.set(timerId, callback as () => void);
          return timerId as unknown as ReturnType<typeof setTimeout>;
        });
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
      const failingStorage = {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('quota exceeded', 'QuotaExceededError');
        },
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        get length() {
          return 0;
        },
      } as Storage;
      const service = context.getService();
      const control = frozenQueueControl(service);

      Object.defineProperty(globalThis, 'localStorage', {
        value: failingStorage,
        configurable: true,
        writable: true,
      });

      try {
        control.freezeQueueWrites('test_pressure');
        control.clearQueueFreeze();
        control.freezeQueueWrites('test_pressure');

        queuedTimeouts.get(1)?.();

        expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
        expect(service.queueFrozen()).toBe(true);

        control.clearQueueFreeze();
        expect(clearTimeoutSpy).toHaveBeenCalledWith(2);
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          value: originalLocalStorage,
          configurable: true,
          writable: true,
        });
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });

    it('reset 应清理冻结重试计时器', () => {
      vi.useFakeTimers();
      const service = context.getService();
      const control = frozenQueueControl(service);

      control.freezeQueueWrites('test_pressure');
      service.reset();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
}

export function registerActionQueueStorageRetrySpecs(context: ActionQueueStorageTailSpecContext): void {
  describe('handleRetry', () => {
    it('should move business errors directly to dead letter queue', () => {
      const service = context.getService();
      const action = context.createMockAction({ retryCount: 0 });

      const result = service.handleRetry(action, 'not found');

      expect(result).toBe('dead-letter');
      expect(service.hasDeadLetters()).toBe(true);
    });

    it('should move permission errors directly to dead letter queue', () => {
      const service = context.getService();
      const action = context.createMockAction({ retryCount: 0 });

      const result = service.handleRetry(action, 'unauthorized');

      expect(result).toBe('dead-letter');
      expect(service.hasDeadLetters()).toBe(true);
    });

    it('should block localized auth-expired errors without consuming retry budget', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = context.createMockAction({ retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES });
      ctx.pendingActions.set([action]);
      const scheduleRetrySpy = vi.spyOn(service, 'scheduleRetry');

      const result = service.handleRetry(action, 'SYNC_AUTH_EXPIRED | 登录已过期，请重新登录 | [AuthError:42501]');

      expect(result).toBe('retry');
      expect(scheduleRetrySpy).toHaveBeenCalled();
      expect(service.hasDeadLetters()).toBe(false);
      expect(ctx.pendingActions().find(a => a.id === action.id)?.retryCount).toBe(LOCAL_QUEUE_CONFIG.MAX_RETRIES);
      expect(ctx.pendingActions().find(a => a.id === action.id)?.syncState).toBe('blocked_by_auth');
    });

    it('should retry on network errors when under max retries', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = context.createMockAction({ retryCount: 0 });
      ctx.pendingActions.set([action]);

      const result = service.handleRetry(action, 'Network timeout');

      expect(result).toBe('retry');
      expect(service.hasDeadLetters()).toBe(false);
      expect(ctx.pendingActions().find(a => a.id === action.id)?.syncState).toBe('retry_scheduled');
    });

    it('should move to dead letter when max retries exceeded', () => {
      const service = context.getService();
      const action = context.createMockAction({
        retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES,
      });

      const result = service.handleRetry(action, 'Network timeout');

      expect(result).toBe('dead-letter');
      expect(service.hasDeadLetters()).toBe(true);
    });

    it('should increment retry count on retriable errors', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = context.createMockAction({ retryCount: 1 });
      ctx.pendingActions.set([action]);

      service.handleRetry(action, 'Network timeout');

      const updated = ctx.pendingActions().find(a => a.id === action.id);
      expect(updated?.retryCount).toBe(2);
    });

    it('should defer browser-suspended errors without consuming retry budget', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = context.createMockAction({ retryCount: 1 });
      ctx.pendingActions.set([action]);
      const scheduleRetrySpy = vi.spyOn(service, 'scheduleRetry');

      const result = service.handleRetry(action, {
        code: 'SYNC_OFFLINE',
        message: '浏览器恢复连接中，请稍后重试',
        details: {
          reason: 'browser-network-suspended',
          resumeDelayMs: 321,
        },
      } as never);

      expect(result).toBe('retry');
      expect(scheduleRetrySpy).toHaveBeenCalledWith(321);
      expect(service.hasDeadLetters()).toBe(false);
      expect(ctx.pendingActions().find(a => a.id === action.id)?.retryCount).toBe(1);
      expect(ctx.pendingActions().find(a => a.id === action.id)?.syncState).toBe('retry_scheduled');
    });

    it('should defer flattened browser-suspended error strings without consuming retry budget', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = context.createMockAction({ retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES });
      ctx.pendingActions.set([action]);
      const scheduleRetrySpy = vi.spyOn(service, 'scheduleRetry');

      const result = service.handleRetry(action, 'SYNC_OFFLINE | 浏览器恢复连接中，请稍后重试');

      expect(result).toBe('retry');
      expect(scheduleRetrySpy).toHaveBeenCalled();
      expect(service.hasDeadLetters()).toBe(false);
      expect(ctx.pendingActions().find(a => a.id === action.id)?.retryCount).toBe(LOCAL_QUEUE_CONFIG.MAX_RETRIES);
    });

    it('should defer partial retry handoff errors without consuming retry budget', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = context.createMockAction({ retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES });
      ctx.pendingActions.set([action]);
      const scheduleRetrySpy = vi.spyOn(service, 'scheduleRetry');

      const result = service.handleRetry(action, {
        code: 'SYNC_RETRY_HANDOFF_PENDING',
        message: 'project batch sync partially delegated; some failures did not enter retry queue',
        details: {
          reason: 'partial-retry-handoff',
          retryAfterMs: 432,
        },
      } as never);

      expect(result).toBe('retry');
      expect(scheduleRetrySpy).toHaveBeenCalledWith(432);
      expect(service.hasDeadLetters()).toBe(false);
      expect(ctx.pendingActions().find(a => a.id === action.id)?.retryCount).toBe(LOCAL_QUEUE_CONFIG.MAX_RETRIES);
    });

    it('should defer auth-pending errors without consuming retry budget', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = context.createMockAction({ retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES });
      ctx.pendingActions.set([action]);
      const scheduleRetrySpy = vi.spyOn(service, 'scheduleRetry');

      const result = service.handleRetry(action, {
        code: 'SYNC_AUTH_PENDING',
        message: '认证状态尚未就绪，请稍后重试',
        details: {
          reason: 'auth-pending',
        },
      } as never);

      expect(result).toBe('retry');
      expect(scheduleRetrySpy).toHaveBeenCalled();
      expect(service.hasDeadLetters()).toBe(false);
      expect(ctx.pendingActions().find(a => a.id === action.id)?.retryCount).toBe(LOCAL_QUEUE_CONFIG.MAX_RETRIES);
    });

    it('should defer sync RPC capability gaps without consuming retry budget', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = context.createMockAction({ retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES });
      ctx.pendingActions.set([action]);
      const scheduleRetrySpy = vi.spyOn(service, 'scheduleRetry');

      const result = service.handleRetry(action, {
        code: 'FOCUS_CONSOLE_INCREMENT_FAILED',
        message: '完成记录等待后台同步',
        details: {
          retryable: true,
          deferred: true,
          reason: 'sync-rpc-unavailable',
          operationId: action.operationId,
        },
      } as never);

      expect(result).toBe('retry');
      expect(scheduleRetrySpy).toHaveBeenCalled();
      expect(service.hasDeadLetters()).toBe(false);
      expect(ctx.pendingActions().find(a => a.id === action.id)?.retryCount).toBe(LOCAL_QUEUE_CONFIG.MAX_RETRIES);
      expect(ctx.pendingActions().find(a => a.id === action.id)?.syncState).toBe('retry_scheduled');
    });

    it('should dead-letter structured stale payload terminal errors without scheduling retry', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = context.createMockAction({ retryCount: 1 });
      ctx.pendingActions.set([action]);
      const scheduleRetrySpy = vi.spyOn(service, 'scheduleRetry');

      const result = service.handleRetry(action, {
        code: 'FOCUS_CONSOLE_INCREMENT_FAILED',
        message: '远端已保留更新版本，本地旧操作不可继续重试',
        details: {
          retryable: false,
          reason: 'stale-payload-preserved-remotely',
          operationId: action.operationId,
        },
      });

      expect(result).toBe('dead-letter');
      expect(scheduleRetrySpy).not.toHaveBeenCalled();
      expect(service.hasDeadLetters()).toBe(true);
      expect(ctx.pendingActions().find(a => a.id === action.id)?.retryCount).toBe(1);
    });

    it('should defer 5xx server pressure without consuming retry budget', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = context.createMockAction({ retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES });
      ctx.pendingActions.set([action]);
      const scheduleRetrySpy = vi.spyOn(service, 'scheduleRetry');

      const result = service.handleRetry(action, {
        code: 'HTTP_503',
        message: 'Service Unavailable',
        details: {
          status: 503,
          reason: 'server-pressure',
          retryAfterMs: 876,
        },
      } as never);

      expect(result).toBe('retry');
      expect(scheduleRetrySpy).toHaveBeenCalledWith(876);
      expect(service.hasDeadLetters()).toBe(false);
      expect(ctx.pendingActions().find(a => a.id === action.id)?.retryCount)
        .toBe(LOCAL_QUEUE_CONFIG.MAX_RETRIES);
      expect(ctx.pendingActions().find(a => a.id === action.id)?.syncState).toBe('retry_scheduled');
    });

    it('durably retries A without overwriting concurrently persisted B', async () => {
      const service = context.getService();
      const ctx = context.getContext();
      const actionA = context.createMockAction({ id: 'retry-a', retryCount: 0 });
      const actionB = context.createMockAction({ id: 'concurrent-b' });
      await service.persistQueueSnapshotForOwner('user-a', [actionA, actionB]);
      ctx.pendingActions.set([actionA]);
      vi.spyOn(service, 'scheduleRetry').mockImplementation(() => undefined);

      expect(await service.handleRetryDurably(actionA, 'Network timeout')).toBe('retry');

      const durableQueue = await service.loadQueueSnapshotForOwner('user-a');
      expect(durableQueue.map(action => action.id)).toEqual(['retry-a', 'concurrent-b']);
      expect(durableQueue[0]?.retryCount).toBe(1);
      expect(ctx.pendingActions().map(action => action.id)).toEqual(['retry-a', 'concurrent-b']);
    });

    it('durably dead-letters only A while preserving concurrently persisted B', async () => {
      const service = context.getService();
      const ctx = context.getContext();
      const actionA = context.createMockAction({ id: 'terminal-a' });
      const actionB = context.createMockAction({ id: 'concurrent-b' });
      await service.persistQueueSnapshotForOwner('user-a', [actionA, actionB]);
      ctx.pendingActions.set([actionA]);

      expect(await service.handleRetryDurably(actionA, {
        code: 'FOCUS_CONSOLE_INCREMENT_FAILED',
        message: 'stale payload preserved remotely',
        details: { retryable: false, reason: 'stale-payload-preserved-remotely' },
      })).toBe('dead-letter');

      expect((await service.loadQueueSnapshotForOwner('user-a')).map(action => action.id))
        .toEqual(['concurrent-b']);
      expect(service.deadLetterQueue().filter(item =>
        item.action.id === actionA.id && item.action.operationId === actionA.operationId
      )).toHaveLength(1);
    });
  });
}

export function registerActionQueueStoragePureHelperSpecs(
  createMockAction: (overrides?: Partial<QueuedAction>) => QueuedAction,
): void {
  describe('classifyQueueRetryError', () => {
    it('classifies structured auth-pending retry errors as deferred', () => {
      expect(classifyQueueRetryError({
        code: 'SYNC_AUTH_PENDING',
        message: '认证状态尚未就绪，请稍后重试',
        details: { reason: 'auth-pending' },
      })).toBe('deferred');
    });

    it('classifies auth-expired sync errors as deferred instead of permanent permission failure', () => {
      expect(classifyQueueRetryError('SYNC_AUTH_EXPIRED | 登录已过期，请重新登录 | [AuthError:42501]'))
        .toBe('deferred');
    });

    it('classifies sync RPC capability gaps as deferred', () => {
      expect(classifyQueueRetryError({
        code: 'FOCUS_CONSOLE_INCREMENT_FAILED',
        message: '完成记录等待后台同步',
        details: {
          retryable: true,
          deferred: true,
          reason: 'sync-rpc-unavailable',
          operationId: '11111111-1111-4111-8111-111111111111',
        },
      })).toBe('deferred');
    });

    it('classifies structured stale payload terminal reasons as business errors', () => {
      expect(classifyQueueRetryError({
        code: 'FOCUS_CONSOLE_INCREMENT_FAILED',
        message: '远端已保留更新版本，本地旧操作不可继续重试',
        details: {
          retryable: false,
          reason: 'stale-payload-preserved-remotely',
        },
      })).toBe('business');
    });

    it('classifies structured operation-id payload mismatches as business errors', () => {
      expect(classifyQueueRetryError({
        code: 'FOCUS_CONSOLE_INCREMENT_FAILED',
        message: '操作幂等键与既有远端载荷不一致',
        details: {
          retryable: false,
          rpcReason: 'operation_id_payload_mismatch',
        },
      })).toBe('business');
    });

    it('classifies structured and flattened 5xx server pressure as deferred', () => {
      expect(classifyQueueRetryError({
        code: 'HTTP_504',
        message: 'Gateway Timeout',
        details: { statusCode: 504, retryable: true },
      })).toBe('deferred');
      expect(classifyQueueRetryError('HTTP 502 Bad Gateway')).toBe('deferred');
      expect(classifyQueueRetryError({
        code: 'HTTP_503',
        message: 'Service Unavailable',
        details: { status: 503, retryable: false },
      })).toBe('unknown');
    });

    it('classifies invalid sync operation ids as business errors so the outbox does not retry forever', () => {
      expect(classifyQueueRetryError('Invalid sync operationId: expected UUID-shaped idempotency key'))
        .toBe('business');
    });
  });

  describe('resolveQueueRetryDelay', () => {
    it('uses the existing retry delay strategy for network, timeout, and unknown errors', () => {
      expect(resolveQueueRetryDelay('network', 4))
        .toBe(Math.min(LOCAL_QUEUE_CONFIG.RETRY_BASE_DELAY * 5, 5000));
      expect(resolveQueueRetryDelay('timeout', 2))
        .toBe(LOCAL_QUEUE_CONFIG.RETRY_BASE_DELAY * Math.pow(1.5, 2));
      expect(resolveQueueRetryDelay('unknown', 2))
        .toBe(LOCAL_QUEUE_CONFIG.RETRY_BASE_DELAY * Math.pow(2, 2));
    });
  });

  describe('dead letter pure helpers', () => {
    it('builds owner dead-letter reasons for permanent and retry-budget failures', () => {
      expect(buildFailedOwnerDeadLetterReason('business', 'not found')).toBe('业务错误: not found');
      expect(buildFailedOwnerDeadLetterReason('permission', 'jwt expired')).toBe('权限错误: jwt expired');
      expect(buildFailedOwnerDeadLetterReason('network', 'Network timeout'))
        .toBe(`超过最大重试次数 (${LOCAL_QUEUE_CONFIG.MAX_RETRIES}): Network timeout`);
    });

    it('appends a dead-letter item while keeping the configured queue size cap', () => {
      const queue: DeadLetterItem[] = Array.from(
        { length: LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE },
        (_, index) => ({
          action: createMockAction({ id: `existing-${index}` }),
          failedAt: new Date(0).toISOString(),
          reason: `existing-${index}`,
        }),
      );
      const nextItem: DeadLetterItem = {
        action: createMockAction({ id: 'next' }),
        failedAt: new Date(1).toISOString(),
        reason: 'next',
      };

      const result = appendCappedDeadLetterItem(queue, nextItem);

      expect(result.overflow).toBe(1);
      expect(result.queue).toHaveLength(LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE);
      expect(result.queue[0].action.id).toBe('existing-1');
      expect(result.queue.at(-1)?.action.id).toBe('next');
    });
  });

  describe('escape export pure helpers', () => {
    it('builds stable escape export JSON payloads', () => {
      const action = createMockAction({ id: 'escape-action' });
      const json = buildActionQueueEscapeExportJson({
        exportedAt: '2026-06-15T00:00:00.000Z',
        pendingActions: [action],
        deadLetterQueue: [],
        frozenState: true,
        freezeReason: 'storage_failure',
      });
      const parsed = JSON.parse(json) as {
        exportedAt: string;
        pendingActions: Array<{ id: string }>;
        frozenState: boolean;
        freezeReason: string;
        metadata: { version: number; source: string };
      };

      expect(parsed.exportedAt).toBe('2026-06-15T00:00:00.000Z');
      expect(parsed.pendingActions[0].id).toBe('escape-action');
      expect(parsed.frozenState).toBe(true);
      expect(parsed.freezeReason).toBe('storage_failure');
      expect(parsed.metadata).toEqual({ version: 1, source: 'action-queue-escape' });
    });

    it('builds filesystem-safe escape export filenames', () => {
      expect(buildActionQueueEscapeExportFilename('2026-06-15T01:02:03.000Z'))
        .toBe('nanoflow-pending-sync-2026-06-15T01-02-03.json');
    });
  });
}
