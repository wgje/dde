import { describe, expect, it, vi } from 'vitest';

import {
  LOCAL_QUEUE_CONFIG,
  type ActionQueueContext,
  type ActionQueueStorageService,
} from './action-queue-storage.service';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import { isSyncOperationId } from '../utils/sync-operation-id';

interface ActionQueueStorageDeadLetterRestoreSpecContext {
  getService: () => ActionQueueStorageService;
  createMockAction: (overrides?: Partial<QueuedAction>) => QueuedAction;
  setCurrentUserId: (userId: string | null) => void;
  backupDeadLetters: (ownerUserId: string, items: DeadLetterItem[]) => Promise<boolean>;
  backupDeadLettersMock: ReturnType<typeof vi.fn>;
  flushBackupRestore: () => Promise<void>;
  getContext: () => ActionQueueContext;
  setRestoreDeadLettersResult: (result: Promise<DeadLetterItem[]>) => void;
}

export function registerActionQueueStorageDeadLetterRestoreSpecs(
  context: ActionQueueStorageDeadLetterRestoreSpecContext,
): void {
  describe('dead letter backup restore', () => {
    it('restoreDeadLettersFromBackupItems should merge owner dead letters without duplicating or reviving stale entries', () => {
      const service = context.getService();
      const existingAction = context.createMockAction({
        id: 'existing-dead-letter',
        operationId: 'op-existing-dead-letter',
      });
      const restoredAction = context.createMockAction({
        id: 'restored-dead-letter',
        operationId: 'op-restored-dead-letter',
      });
      const duplicateAction = context.createMockAction({
        id: 'duplicate-dead-letter',
        operationId: 'op-existing-dead-letter',
      });
      const foreignAction = context.createMockAction({
        id: 'foreign-dead-letter',
        operationId: 'op-foreign-dead-letter',
        payload: {
          task: { id: 'task-foreign', title: 'Foreign' },
          projectId: 'project-foreign',
          sourceUserId: 'other-user',
        } as never,
      });
      const expiredAction = context.createMockAction({
        id: 'expired-dead-letter',
        operationId: 'op-expired-dead-letter',
      });
      const now = Date.now();
      const backupDeadLetters: DeadLetterItem[] = [
        {
          action: duplicateAction,
          failedAt: new Date(now).toISOString(),
          reason: 'duplicate',
        },
        {
          action: restoredAction,
          failedAt: new Date(now).toISOString(),
          reason: 'restored',
        },
        {
          action: foreignAction,
          failedAt: new Date(now).toISOString(),
          reason: 'foreign',
        },
        {
          action: expiredAction,
          failedAt: new Date(now - LOCAL_QUEUE_CONFIG.DEAD_LETTER_TTL - 1).toISOString(),
          reason: 'expired',
        },
      ];

      service.moveToDeadLetter(existingAction, 'existing');

      const restoredCount = (service as unknown as {
        restoreDeadLettersFromBackupItems(items: unknown[], ownerUserId: string): number;
      }).restoreDeadLettersFromBackupItems(backupDeadLetters, 'user-a');

      // §5.6：超龄死信备份同样保留（不再按 TTL 静默丢弃），去重与 owner 过滤保持不变
      expect(restoredCount).toBe(2);
      expect(service.deadLetterQueue().map(item => item.action.id)).toEqual([
        'existing-dead-letter',
        'restored-dead-letter',
        'expired-dead-letter',
      ]);
      const saved = localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`);
      expect(saved).toContain('restored-dead-letter');
      expect(saved).not.toContain('foreign-dead-letter');
      expect(saved).toContain('expired-dead-letter');
    });

    it('restoreDeadLettersFromBackupItems should not evict current local dead letters when backup exceeds capacity', () => {
      const service = context.getService();
      for (let index = 0; index < LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE; index += 1) {
        service.moveToDeadLetter(context.createMockAction({
          id: `current-dead-letter-${index}`,
          operationId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
        }), `current-${index}`);
      }
      const backupOnlyAction = context.createMockAction({
        id: 'backup-only-dead-letter',
        operationId: '11111111-1111-4111-8111-111111111111',
      });
      const backupDeadLetter: DeadLetterItem = {
        action: backupOnlyAction,
        failedAt: new Date().toISOString(),
        reason: 'backup-only',
      };

      const restoredCount = (service as unknown as {
        restoreDeadLettersFromBackupItems(items: unknown[], ownerUserId: string): number;
      }).restoreDeadLettersFromBackupItems([backupDeadLetter], 'user-a');

      const restoredIds = service.deadLetterQueue().map(item => item.action.id);
      expect(restoredCount).toBe(0);
      expect(restoredIds).toHaveLength(LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE);
      expect(restoredIds).toContain('current-dead-letter-0');
      expect(restoredIds).toContain(`current-dead-letter-${LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE - 1}`);
      expect(restoredIds).not.toContain('backup-only-dead-letter');
    });

    it('loadDeadLetterFromStorage should restore dead letters from IndexedDB backup when localStorage is corrupt', async () => {
      const service = context.getService();
      const restoredAction = context.createMockAction({
        id: 'restored-dead-letter-from-idb',
        operationId: 'op-restored-dead-letter-from-idb',
      });
      const backupDeadLetter: DeadLetterItem = {
        action: {
          ...restoredAction,
          syncState: 'dead_letter',
        },
        failedAt: new Date().toISOString(),
        reason: 'backup restore',
      };
      await context.backupDeadLetters('user-a', [backupDeadLetter]);
      localStorage.setItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`, '{bad json');

      service.loadDeadLetterFromStorage();
      await context.flushBackupRestore();

      expect(service.deadLetterQueue()).toEqual([
        expect.objectContaining({
          action: expect.objectContaining({
            id: 'restored-dead-letter-from-idb',
            syncState: 'dead_letter',
          }),
          reason: 'backup restore',
        }),
      ]);
      expect(service.deadLetterSize()).toBe(1);
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`))
        .toContain('restored-dead-letter-from-idb');
    });

    it('loadDeadLetterFromStorage should not clear current owner freeze when backup restore resolves after owner switch', async () => {
      const service = context.getService();
      const restoredAction = context.createMockAction({
        id: 'stale-owner-dead-letter-from-idb',
        entityId: 'task-stale-owner-dead-letter',
        payload: {
          task: { id: 'task-stale-owner-dead-letter', title: 'Stale owner restore' },
          projectId: 'project-stale-owner',
          sourceUserId: 'user-a',
        } as never,
      });
      const backupDeadLetter: DeadLetterItem = {
        action: {
          ...restoredAction,
          syncState: 'dead_letter',
        },
        failedAt: new Date().toISOString(),
        reason: 'backup restore',
      };
      await context.backupDeadLetters('user-a', [backupDeadLetter]);
      (service as unknown as { freezeQueueWrites(reason: string): void })
        .freezeQueueWrites('storage_failure');

      service.loadDeadLetterFromStorage();
      context.setCurrentUserId('user-b');
      await context.flushBackupRestore();

      expect(service.queueFrozen()).toBe(true);
      expect(service.queueFreezeReason()).toBe('storage_failure');
      expect(service.deadLetterQueue()).toEqual([]);
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`))
        .toContain('stale-owner-dead-letter-from-idb');
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-b`))
        .toBeNull();
    });

    it('restoreDeadLettersFromBackupItems should preserve legacy dead letters missing operationId', () => {
      const service = context.getService();
      const legacyAction = context.createMockAction({
        id: 'legacy-dead-letter',
      });
      const legacyActionWithoutOperationId = { ...legacyAction } as Record<string, unknown>;
      delete legacyActionWithoutOperationId['operationId'];
      const legacyDeadLetter = {
        action: legacyActionWithoutOperationId,
        failedAt: new Date().toISOString(),
        reason: 'legacy backup',
      };

      const restoredCount = (service as unknown as {
        restoreDeadLettersFromBackupItems(items: unknown[], ownerUserId: string): number;
      }).restoreDeadLettersFromBackupItems([legacyDeadLetter], 'user-a');

      expect(restoredCount).toBe(1);
      const [restored] = service.deadLetterQueue();
      expect(restored).toEqual(expect.objectContaining({
        action: expect.objectContaining({
          id: 'legacy-dead-letter',
          syncState: 'dead_letter',
        }),
        reason: 'legacy backup',
      }));
      expect(isSyncOperationId(restored?.action.operationId)).toBe(true);
    });

    it('restoreDeadLettersFromBackupItems should repair legacy non-UUID operationId', () => {
      const service = context.getService();
      const legacyAction = context.createMockAction({
        id: 'legacy-non-uuid-dead-letter',
        operationId: 'op-legacy-non-uuid',
      });
      const legacyDeadLetter: DeadLetterItem = {
        action: legacyAction,
        failedAt: new Date().toISOString(),
        reason: 'legacy non UUID backup',
      };

      const restoredCount = (service as unknown as {
        restoreDeadLettersFromBackupItems(items: unknown[], ownerUserId: string): number;
      }).restoreDeadLettersFromBackupItems([legacyDeadLetter], 'user-a');

      expect(restoredCount).toBe(1);
      const [restored] = service.deadLetterQueue();
      expect(restored?.action.id).toBe('legacy-non-uuid-dead-letter');
      expect(restored?.action.operationId).not.toBe('op-legacy-non-uuid');
      expect(isSyncOperationId(restored?.action.operationId)).toBe(true);
    });

    it('loadDeadLetterFromStorage should guard transient saves and processing until backup restore settles', async () => {
      const service = context.getService();
      const durableDeadLetter: DeadLetterItem = {
        action: {
          ...context.createMockAction({ id: 'durable-dead-letter-hidden-during-restore' }),
          syncState: 'dead_letter',
        },
        failedAt: new Date().toISOString(),
        reason: 'durable backup',
      };
      let resolveRestore: (items: DeadLetterItem[]) => void = () => {};
      const restorePromise = new Promise<DeadLetterItem[]>((resolve) => {
        resolveRestore = resolve;
      });
      context.setRestoreDeadLettersResult(restorePromise);

      service.loadDeadLetterFromStorage();
      const savedWhileRestoring = service.saveDeadLetterToStorage();
      service.requestQueueProcessing('dead-letter-restore-pending');

      expect(savedWhileRestoring).toBe(false);
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`)).toBeNull();
      expect(context.backupDeadLettersMock).not.toHaveBeenCalled();
      expect(context.getContext().processQueue).not.toHaveBeenCalled();

      resolveRestore([durableDeadLetter]);
      await context.flushBackupRestore();

      expect(service.deadLetterQueue()).toEqual([durableDeadLetter]);
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`))
        .toContain('durable-dead-letter-hidden-during-restore');
      expect(context.backupDeadLettersMock)
        .toHaveBeenLastCalledWith([durableDeadLetter], 'user-a');
      expect(context.getContext().processQueue).toHaveBeenCalledOnce();
    });

    it('saveDeadLetterToStorage should persist dead letter queue', () => {
      const service = context.getService();
      service.moveToDeadLetter(context.createMockAction(), 'test');

      const saved = localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`);
      expect(saved).toBeTruthy();
      expect(JSON.parse(saved!)).toHaveLength(1);
    });

    it('saveDeadLetterToStorage should freeze and expose escape data when dead-letter persistence fails', () => {
      const service = context.getService();
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
        removeItem: (key: string) => storageData.delete(key),
        clear: () => storageData.clear(),
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
        const action = context.createMockAction({ id: 'dead-letter-save-failure' });
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
  });
}
