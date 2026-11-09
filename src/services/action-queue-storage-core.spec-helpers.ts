import { describe, it, expect, vi } from 'vitest';

import {
  ActionQueueStorageService,
  LOCAL_QUEUE_CONFIG,
  type ActionQueueContext,
} from './action-queue-storage.service';
import {
  createMockAction,
  mockLoggerCategory,
  mockToastService,
} from './action-queue-storage.spec-helpers';

interface ActionQueueStorageCoreSpecContext {
  getService: () => ActionQueueStorageService;
  getContext: () => ActionQueueContext;
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

export function registerActionQueueStorageCoreSpecs(
  context: ActionQueueStorageCoreSpecContext,
): void {
  describe('classifyError', () => {
    it('should classify network errors', () => {
      const service = context.getService();

      expect(service.classifyError('Network timeout')).toBe('network');
      expect(service.classifyError('Failed to fetch')).toBe('network');
      expect(service.classifyError('NetworkError occurred')).toBe('network');
      expect(service.classifyError('connection refused')).toBe('network');
      expect(service.classifyError('device offline')).toBe('network');
    });

    it('should classify timeout errors', () => {
      const service = context.getService();

      expect(service.classifyError('request timeout')).toBe('timeout');
      expect(service.classifyError('operation timed out')).toBe('timeout');
      expect(service.classifyError('deadline exceeded')).toBe('timeout');
    });

    it('should classify permission errors', () => {
      const service = context.getService();

      expect(service.classifyError('permission denied')).toBe('permission');
      expect(service.classifyError('unauthorized access')).toBe('permission');
      expect(service.classifyError('forbidden resource')).toBe('permission');
      expect(service.classifyError('invalid jwt token')).toBe('permission');
      expect(service.classifyError('policy violation')).toBe('permission');
    });

    it('should classify business errors', () => {
      const service = context.getService();

      expect(service.classifyError('not found')).toBe('business');
      expect(service.classifyError('duplicate key value')).toBe('business');
      expect(service.classifyError('unique constraint failed')).toBe('business');
      expect(service.classifyError('violates check constraint')).toBe('business');
      expect(service.classifyError('invalid input syntax')).toBe('business');
    });

    it('should return unknown for unrecognized errors', () => {
      const service = context.getService();

      expect(service.classifyError('something unexpected')).toBe('unknown');
      expect(service.classifyError('')).toBe('unknown');
    });
  });

  describe('dead letter queue operations', () => {
    it('moveToDeadLetter should add action to dead letter queue', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = createMockAction();

      service.moveToDeadLetter(action, 'test reason');

      expect(service.deadLetterQueue().length).toBe(1);
      expect(service.deadLetterSize()).toBe(1);
      expect(service.hasDeadLetters()).toBe(true);
      expect(service.deadLetterQueue()[0].action.syncState).toBe('dead_letter');
      expect(ctx.dequeue).toHaveBeenCalledWith(action.id);
    });

    it('moveToDeadLetter should not dequeue pending action when dead-letter persistence fails', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const originalLocalStorage = globalThis.localStorage;
      const action = createMockAction({ id: 'dead-letter-persist-failure-retained' });
      const storageFailureCallback = vi.fn();
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
      ctx.pendingActions.set([action]);
      ctx.queueSize.set(1);
      service.onStorageFailure(storageFailureCallback);

      Object.defineProperty(globalThis, 'localStorage', {
        value: failingStorage,
        configurable: true,
        writable: true,
      });

      try {
        service.moveToDeadLetter(action, 'quota');

        expect(ctx.dequeue).not.toHaveBeenCalled();
        expect(ctx.pendingActions()).toEqual([action]);
        expect(ctx.queueSize()).toBe(1);
        expect(storageFailureCallback).toHaveBeenCalledWith({
          queue: [action],
          deadLetter: [
            expect.objectContaining({
              action: expect.objectContaining({
                id: action.id,
                syncState: 'dead_letter',
              }),
              reason: 'quota',
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

    it('moveToDeadLetter should keep low priority actions in dead letter queue', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = createMockAction({ priority: 'low' });

      service.moveToDeadLetter(action, 'test reason');

      expect(service.deadLetterQueue().length).toBe(1);
      expect(ctx.dequeue).toHaveBeenCalledWith(action.id);
    });

    it('moveToDeadLetter should notify user for critical actions', () => {
      const service = context.getService();
      const action = createMockAction({ priority: 'critical' });

      service.moveToDeadLetter(action, 'critical failure');

      expect(mockToastService.warning).toHaveBeenCalled();
    });

    it('dismissDeadLetter should remove item from dead letter queue', () => {
      const service = context.getService();
      const action = createMockAction();
      service.moveToDeadLetter(action, 'test');

      service.dismissDeadLetter(action.id);

      expect(service.deadLetterSize()).toBe(0);
      expect(service.hasDeadLetters()).toBe(false);
    });

    it('dismissDeadLetter should remove item when dead-letter save throws', () => {
      const service = context.getService();
      const action = createMockAction({ id: 'dismiss-save-throws' });
      service.moveToDeadLetter(action, 'test');
      const saveSpy = vi.spyOn(service, 'saveDeadLetterToStorage')
        .mockImplementationOnce(() => {
          throw new Error('dead-letter save unavailable');
        });

      try {
        expect(() => service.dismissDeadLetter(action.id)).not.toThrow();
      } finally {
        saveSpy.mockRestore();
      }

      expect(service.deadLetterQueue()).toEqual([]);
      expect(service.deadLetterSize()).toBe(0);
    });

    it('dismissDeadLetter should remove item when sentry context sync throws', () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = createMockAction({ id: 'dismiss-sentry-throws' });
      service.moveToDeadLetter(action, 'test');
      vi.mocked(ctx.syncSentryContext).mockImplementationOnce(() => {
        throw new Error('sentry unavailable');
      });

      expect(() => service.dismissDeadLetter(action.id)).not.toThrow();

      expect(service.deadLetterQueue()).toEqual([]);
      expect(service.deadLetterSize()).toBe(0);
    });

    it('retryDeadLetter should move item back to pending actions', async () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = createMockAction({ retryCount: 3, syncState: 'dead_letter' });
      service.moveToDeadLetter(action, 'test');

      const retrySucceeded = await service.retryDeadLetter(action.id);

      expect(retrySucceeded).toBe(true);
      expect(service.deadLetterSize()).toBe(0);
      expect(ctx.pendingActions().length).toBe(1);
      expect(ctx.pendingActions()[0].retryCount).toBe(0);
      expect(ctx.pendingActions()[0].syncState).toBe('pending_sync');
    });

    it('retryDeadLetter should keep item in dead letter when pending queue persistence fails', async () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = createMockAction({
        id: 'dead-letter-retry-persist-fail',
        retryCount: 3,
        syncState: 'dead_letter',
      });
      service.moveToDeadLetter(action, 'test');
      const persistSpy = vi.spyOn(service, 'persistQueueMutationForOwner')
        .mockResolvedValueOnce(null);

      let retried = true;
      try {
        retried = await service.retryDeadLetter(action.id);
      } finally {
        persistSpy.mockRestore();
      }

      expect(retried).toBe(false);
      expect(ctx.pendingActions()).toEqual([]);
      expect(service.deadLetterQueue()).toEqual([
        expect.objectContaining({
          action: expect.objectContaining({
            id: action.id,
            syncState: 'dead_letter',
          }),
          reason: 'test',
        }),
      ]);
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`))
        .toContain(action.id);
    });

    it('retryDeadLetter should keep item in dead letter when persistence warning logging fails', async () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = createMockAction({
        id: 'dead-letter-retry-warn-fail',
        retryCount: 2,
        syncState: 'dead_letter',
      });
      service.moveToDeadLetter(action, 'test');
      const persistSpy = vi.spyOn(service, 'persistQueueMutationForOwner')
        .mockResolvedValueOnce(null);
      mockLoggerCategory.warn.mockImplementationOnce(() => {
        throw new Error('logger unavailable');
      });

      try {
        await expect(service.retryDeadLetter(action.id)).resolves.toBe(false);
      } finally {
        persistSpy.mockRestore();
        mockLoggerCategory.warn.mockReset();
      }

      expect(ctx.pendingActions()).toEqual([]);
      expect(service.deadLetterQueue()).toEqual([
        expect.objectContaining({
          action: expect.objectContaining({
            id: action.id,
            syncState: 'dead_letter',
          }),
          reason: 'test',
        }),
      ]);
    });

    it('retryDeadLetter should finish after pending persistence when dead-letter save throws', async () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = createMockAction({
        id: 'dead-letter-retry-save-throws',
        retryCount: 2,
        syncState: 'dead_letter',
      });
      service.moveToDeadLetter(action, 'test');
      const saveError = new Error('dead-letter storage unavailable');
      const saveSpy = vi.spyOn(service, 'saveDeadLetterToStorage')
        .mockImplementationOnce(() => {
          throw saveError;
        });

      try {
        await expect(service.retryDeadLetter(action.id)).resolves.toBe(true);
      } finally {
        saveSpy.mockRestore();
      }

      expect(ctx.pendingActions()).toEqual([
        expect.objectContaining({
          id: action.id,
          retryCount: 0,
          syncState: 'pending_sync',
        }),
      ]);
      expect(service.deadLetterQueue()).toEqual([]);
      expect(service.deadLetterSize()).toBe(0);
    });

    it('retryDeadLetter should finish after state mutation when sentry context sync throws', async () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = createMockAction({
        id: 'dead-letter-retry-sentry-throws',
        retryCount: 2,
        syncState: 'dead_letter',
      });
      service.moveToDeadLetter(action, 'test');
      vi.mocked(ctx.syncSentryContext).mockImplementationOnce(() => {
        throw new Error('sentry context unavailable');
      });

      await expect(service.retryDeadLetter(action.id)).resolves.toBe(true);

      expect(ctx.pendingActions()).toEqual([
        expect.objectContaining({
          id: action.id,
          retryCount: 0,
          syncState: 'pending_sync',
        }),
      ]);
      expect(service.deadLetterQueue()).toEqual([]);
      expect(service.deadLetterSize()).toBe(0);
    });

    it('retryDeadLetter should isolate online processQueue rejection', async () => {
      const service = context.getService();
      const ctx = context.getContext();
      const processError = new Error('dead-letter process failed');
      const unhandledRejection = vi.fn();
      const action = createMockAction({
        id: 'dead-letter-retry-process-rejects',
        retryCount: 2,
        syncState: 'dead_letter',
      });
      service.moveToDeadLetter(action, 'test');
      vi.mocked(ctx.processQueue).mockRejectedValueOnce(processError);
      window.addEventListener('unhandledrejection', unhandledRejection);

      try {
        await expect(service.retryDeadLetter(action.id)).resolves.toBe(true);
        await flushMicrotasks();
      } finally {
        window.removeEventListener('unhandledrejection', unhandledRejection);
      }

      expect(ctx.processQueue).toHaveBeenCalledTimes(1);
      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        '死信重试后台处理失败，已保留 pending 队列等待后续触发',
        expect.objectContaining({ actionId: action.id, error: processError }),
      );
    });

    it('retryDeadLetter should repair legacy non-UUID operationId before requeueing', async () => {
      const service = context.getService();
      const ctx = context.getContext();
      const action = createMockAction({
        operationId: 'legacy-op-id',
        retryCount: 3,
        syncState: 'dead_letter',
      });
      service.moveToDeadLetter(action, 'invalid sync operation id');

      const retrySucceeded = await service.retryDeadLetter(action.id);

      expect(retrySucceeded).toBe(true);
      const [retriedAction] = ctx.pendingActions();
      expect(retriedAction.id).toBe(action.id);
      expect(retriedAction.payload).toEqual(action.payload);
      expect(retriedAction.operationId).not.toBe('legacy-op-id');
      expect(retriedAction.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('clearDeadLetterQueue should remove all items', () => {
      const service = context.getService();
      service.moveToDeadLetter(createMockAction(), 'r1');
      service.moveToDeadLetter(createMockAction(), 'r2');
      expect(service.deadLetterSize()).toBe(2);

      service.clearDeadLetterQueue();

      expect(service.deadLetterSize()).toBe(0);
      expect(service.hasDeadLetters()).toBe(false);
    });

    it('clearDeadLetterQueue should clear in-memory state when dead-letter save throws', () => {
      const service = context.getService();
      service.moveToDeadLetter(createMockAction({ id: 'clear-save-throws-a' }), 'r1');
      service.moveToDeadLetter(createMockAction({ id: 'clear-save-throws-b' }), 'r2');
      const saveSpy = vi.spyOn(service, 'saveDeadLetterToStorage')
        .mockImplementationOnce(() => {
          throw new Error('dead-letter save unavailable');
        });

      try {
        expect(() => service.clearDeadLetterQueue()).not.toThrow();
      } finally {
        saveSpy.mockRestore();
      }

      expect(service.deadLetterQueue()).toEqual([]);
      expect(service.deadLetterSize()).toBe(0);
      expect(service.hasDeadLetters()).toBe(false);
    });

    it('clearDeadLetterQueue should clear in-memory state when sentry context sync throws', () => {
      const service = context.getService();
      const ctx = context.getContext();
      service.moveToDeadLetter(createMockAction({ id: 'clear-sentry-throws-a' }), 'r1');
      service.moveToDeadLetter(createMockAction({ id: 'clear-sentry-throws-b' }), 'r2');
      vi.mocked(ctx.syncSentryContext).mockImplementationOnce(() => {
        throw new Error('sentry unavailable');
      });

      expect(() => service.clearDeadLetterQueue()).not.toThrow();

      expect(service.deadLetterQueue()).toEqual([]);
      expect(service.deadLetterSize()).toBe(0);
      expect(service.hasDeadLetters()).toBe(false);
    });

    it('moveToDeadLetter should cap dead letter queue at MAX_DEAD_LETTER_SIZE', () => {
      const service = context.getService();

      for (let i = 0; i < LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE + 10; i++) {
        service.moveToDeadLetter(createMockAction(), `reason-${i}`);
      }

      expect(service.deadLetterQueue().length).toBe(LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE);
    });
  });

  describe('failure callbacks', () => {
    it('onFailure callback should be called when action is moved to dead letter', () => {
      const service = context.getService();
      const callback = vi.fn();
      service.onFailure(callback);

      const action = createMockAction();
      service.moveToDeadLetter(action, 'test reason');

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({
            id: action.id,
            syncState: 'dead_letter',
          }),
          reason: 'test reason',
        })
      );
    });

    it('onStorageFailure callback should be registered', () => {
      const service = context.getService();
      const callback = vi.fn();
      service.onStorageFailure(callback);

      expect(() => service.onStorageFailure(callback)).not.toThrow();
    });
  });
}
