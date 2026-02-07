/**
 * ActionQueueStorageService 单元测试
 *
 * 测试覆盖：
 * 1. 错误分类（classifyError）
 * 2. 死信队列操作（移入、重试、放弃、清空）
 * 3. localStorage 持久化（保存/加载队列、保存/加载死信队列）
 * 4. 死信队列 TTL 清理
 * 5. 重试逻辑（handleRetry）
 * 6. 回调注册（onFailure / onStorageFailure）
 * 7. 网络监听器管理
 * 8. 状态重置
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { ActionQueueStorageService, LOCAL_QUEUE_CONFIG, ActionQueueContext } from './action-queue-storage.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import type { QueuedAction, DeadLetterItem } from './action-queue.types';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

function createMockAction(overrides: Partial<QueuedAction> = {}): QueuedAction {
  return {
    id: crypto.randomUUID(),
    type: 'update',
    entityType: 'task',
    entityId: 'task-1',
    payload: { task: { id: 'task-1', title: 'Test' } as any, projectId: 'proj-1' },
    timestamp: Date.now(),
    retryCount: 0,
    priority: 'normal',
    ...overrides,
  };
}

function createMockContext(overrides: Partial<ActionQueueContext> = {}): ActionQueueContext {
  return {
    dequeue: vi.fn(),
    syncSentryContext: vi.fn(),
    processQueue: vi.fn().mockResolvedValue(undefined),
    pendingActions: signal<QueuedAction[]>([]),
    queueSize: signal(0),
    ...overrides,
  };
}

describe('ActionQueueStorageService', () => {
  let service: ActionQueueStorageService;
  let ctx: ActionQueueContext;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();

    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const injector = Injector.create({
      providers: [
        ActionQueueStorageService,
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ToastService, useValue: mockToastService },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
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

  // ==================== 错误分类 ====================

  describe('classifyError', () => {
    it('should classify network errors', () => {
      expect(service.classifyError('Network timeout')).toBe('network');
      expect(service.classifyError('Failed to fetch')).toBe('network');
      expect(service.classifyError('NetworkError occurred')).toBe('network');
      expect(service.classifyError('connection refused')).toBe('network');
      expect(service.classifyError('device offline')).toBe('network');
    });

    it('should classify timeout errors', () => {
      expect(service.classifyError('request timeout')).toBe('timeout');
      expect(service.classifyError('operation timed out')).toBe('timeout');
      expect(service.classifyError('deadline exceeded')).toBe('timeout');
    });

    it('should classify permission errors', () => {
      expect(service.classifyError('permission denied')).toBe('permission');
      expect(service.classifyError('unauthorized access')).toBe('permission');
      expect(service.classifyError('forbidden resource')).toBe('permission');
      expect(service.classifyError('invalid jwt token')).toBe('permission');
      expect(service.classifyError('policy violation')).toBe('permission');
    });

    it('should classify business errors', () => {
      expect(service.classifyError('not found')).toBe('business');
      expect(service.classifyError('duplicate key value')).toBe('business');
      expect(service.classifyError('unique constraint failed')).toBe('business');
      expect(service.classifyError('violates check constraint')).toBe('business');
      expect(service.classifyError('invalid input syntax')).toBe('business');
    });

    it('should return unknown for unrecognized errors', () => {
      expect(service.classifyError('something unexpected')).toBe('unknown');
      expect(service.classifyError('')).toBe('unknown');
    });
  });

  // ==================== 死信队列操作 ====================

  describe('dead letter queue operations', () => {
    it('moveToDeadLetter should add action to dead letter queue', () => {
      const action = createMockAction();

      service.moveToDeadLetter(action, 'test reason');

      expect(service.deadLetterQueue().length).toBe(1);
      expect(service.deadLetterSize()).toBe(1);
      expect(service.hasDeadLetters()).toBe(true);
      expect(ctx.dequeue).toHaveBeenCalledWith(action.id);
    });

    it('moveToDeadLetter should silently discard low priority actions', () => {
      const action = createMockAction({ priority: 'low' });

      service.moveToDeadLetter(action, 'test reason');

      expect(service.deadLetterQueue().length).toBe(0);
      expect(ctx.dequeue).toHaveBeenCalledWith(action.id);
    });

    it('moveToDeadLetter should notify user for critical actions', () => {
      const action = createMockAction({ priority: 'critical' });

      service.moveToDeadLetter(action, 'critical failure');

      expect(mockToastService.warning).toHaveBeenCalled();
    });

    it('dismissDeadLetter should remove item from dead letter queue', () => {
      const action = createMockAction();
      service.moveToDeadLetter(action, 'test');

      service.dismissDeadLetter(action.id);

      expect(service.deadLetterSize()).toBe(0);
      expect(service.hasDeadLetters()).toBe(false);
    });

    it('retryDeadLetter should move item back to pending actions', () => {
      const action = createMockAction({ retryCount: 3 });
      service.moveToDeadLetter(action, 'test');

      service.retryDeadLetter(action.id);

      expect(service.deadLetterSize()).toBe(0);
      expect(ctx.pendingActions().length).toBe(1);
      // retry count should be reset
      expect(ctx.pendingActions()[0].retryCount).toBe(0);
    });

    it('clearDeadLetterQueue should remove all items', () => {
      service.moveToDeadLetter(createMockAction(), 'r1');
      service.moveToDeadLetter(createMockAction(), 'r2');
      expect(service.deadLetterSize()).toBe(2);

      service.clearDeadLetterQueue();

      expect(service.deadLetterSize()).toBe(0);
      expect(service.hasDeadLetters()).toBe(false);
    });

    it('moveToDeadLetter should enforce max size', () => {
      for (let i = 0; i < LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE + 10; i++) {
        service.moveToDeadLetter(createMockAction(), `reason-${i}`);
      }

      expect(service.deadLetterQueue().length).toBeLessThanOrEqual(LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE);
    });
  });

  // ==================== 失败回调 ====================

  describe('failure callbacks', () => {
    it('onFailure callback should be called when action is moved to dead letter', () => {
      const callback = vi.fn();
      service.onFailure(callback);

      const action = createMockAction();
      service.moveToDeadLetter(action, 'test reason');

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          reason: 'test reason',
        })
      );
    });

    it('onStorageFailure callback should be registered', () => {
      const callback = vi.fn();
      service.onStorageFailure(callback);

      // Callback is stored but not triggered until storage actually fails
      // We verify it is registered by checking it does not throw
      expect(() => service.onStorageFailure(callback)).not.toThrow();
    });
  });

  // ==================== 持久化操作 ====================

  describe('storage persistence', () => {
    it('saveQueueToStorage should persist pending actions to localStorage', () => {
      const action = createMockAction();
      ctx.pendingActions.set([action]);

      service.saveQueueToStorage();

      const saved = localStorage.getItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
      expect(saved).toBeTruthy();
      const parsed = JSON.parse(saved!);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe(action.id);
    });

    it('loadQueueFromStorage should restore queue from localStorage', () => {
      const action = createMockAction();
      localStorage.setItem(
        LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY,
        JSON.stringify([action])
      );

      service.loadQueueFromStorage();

      expect(ctx.pendingActions().length).toBe(1);
      expect(ctx.queueSize()).toBe(1);
    });

    it('loadQueueFromStorage should handle corrupted data gracefully', () => {
      localStorage.setItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, '{invalid json}');

      expect(() => service.loadQueueFromStorage()).not.toThrow();
      expect(mockLoggerCategory.warn).toHaveBeenCalled();
    });

    it('saveDeadLetterToStorage should persist dead letter queue', () => {
      const action = createMockAction();
      service.moveToDeadLetter(action, 'test');

      const saved = localStorage.getItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY);
      expect(saved).toBeTruthy();
      const parsed = JSON.parse(saved!);
      expect(parsed).toHaveLength(1);
    });

    it('loadDeadLetterFromStorage should restore dead letter queue with TTL filtering', () => {
      const recentItem: DeadLetterItem = {
        action: createMockAction(),
        failedAt: new Date().toISOString(),
        reason: 'recent',
      };
      const expiredItem: DeadLetterItem = {
        action: createMockAction(),
        failedAt: new Date(Date.now() - LOCAL_QUEUE_CONFIG.DEAD_LETTER_TTL - 1000).toISOString(),
        reason: 'expired',
      };

      localStorage.setItem(
        LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY,
        JSON.stringify([recentItem, expiredItem])
      );

      service.loadDeadLetterFromStorage();

      // Only the recent item should survive TTL filtering
      expect(service.deadLetterQueue().length).toBe(1);
      expect(service.deadLetterQueue()[0].reason).toBe('recent');
    });
  });

  // ==================== 重试逻辑 ====================

  describe('handleRetry', () => {
    it('should move business errors directly to dead letter queue', () => {
      const action = createMockAction({ retryCount: 0 });

      const result = service.handleRetry(action, 'not found');

      expect(result).toBe('dead-letter');
      expect(service.hasDeadLetters()).toBe(true);
    });

    it('should move permission errors directly to dead letter queue', () => {
      const action = createMockAction({ retryCount: 0 });

      const result = service.handleRetry(action, 'unauthorized');

      expect(result).toBe('dead-letter');
      expect(service.hasDeadLetters()).toBe(true);
    });

    it('should retry on network errors when under max retries', () => {
      const action = createMockAction({ retryCount: 0 });
      ctx.pendingActions.set([action]);

      const result = service.handleRetry(action, 'Network timeout');

      expect(result).toBe('retry');
      expect(service.hasDeadLetters()).toBe(false);
    });

    it('should move to dead letter when max retries exceeded', () => {
      const action = createMockAction({
        retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES,
      });

      const result = service.handleRetry(action, 'Network timeout');

      expect(result).toBe('dead-letter');
      expect(service.hasDeadLetters()).toBe(true);
    });

    it('should increment retry count on retriable errors', () => {
      const action = createMockAction({ retryCount: 1 });
      ctx.pendingActions.set([action]);

      service.handleRetry(action, 'Network timeout');

      const updated = ctx.pendingActions().find(a => a.id === action.id);
      expect(updated?.retryCount).toBe(2);
    });
  });

  // ==================== 辅助方法 ====================

  describe('helper methods', () => {
    it('getActionDescription should return human-readable description', () => {
      const action = createMockAction({ type: 'create', entityType: 'task' });
      expect(service.getActionDescription(action)).toContain('任务');
    });

    it('getActionLabel should return human-readable label', () => {
      const action = createMockAction({ type: 'update', entityType: 'project' });
      expect(service.getActionLabel(action)).toContain('项目');
    });
  });

  // ==================== pauseDependentActions ====================

  describe('pauseDependentActions', () => {
    it('should log warning when dependent actions exist', () => {
      const queue: QueuedAction[] = [
        createMockAction({ type: 'update', entityType: 'task', entityId: 'task-1' }),
        createMockAction({ type: 'delete', entityType: 'task', entityId: 'task-1' }),
      ];

      service.pauseDependentActions('task', 'task-1', queue);

      expect(mockLoggerCategory.warn).toHaveBeenCalled();
      expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalled();
    });

    it('should not log when there are no dependent actions', () => {
      const queue: QueuedAction[] = [
        createMockAction({ type: 'create', entityType: 'task', entityId: 'task-1' }),
      ];

      service.pauseDependentActions('task', 'task-1', queue);

      // create type is excluded from dependents
      expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    });

    it('should show toast when critical actions are blocked', () => {
      const queue: QueuedAction[] = [
        createMockAction({
          type: 'update',
          entityType: 'task',
          entityId: 'task-1',
          priority: 'critical',
        }),
      ];

      service.pauseDependentActions('task', 'task-1', queue);

      expect(mockToastService.warning).toHaveBeenCalled();
    });
  });

  // ==================== 网络监听 / 重置 ====================

  describe('network and reset', () => {
    it('should track online status', () => {
      service.isOnline = false;
      expect(service.isOnline).toBe(false);

      service.isOnline = true;
      expect(service.isOnline).toBe(true);
    });

    it('reset should clear all state', () => {
      service.moveToDeadLetter(createMockAction(), 'reason');
      expect(service.hasDeadLetters()).toBe(true);

      service.reset();

      expect(service.hasDeadLetters()).toBe(false);
      expect(service.deadLetterSize()).toBe(0);
      expect(service.storageFailure()).toBe(false);
      expect(service.isOnline).toBe(true);
    });
  });
});
