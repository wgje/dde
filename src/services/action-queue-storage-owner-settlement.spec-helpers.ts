import { describe, expect, it, vi } from 'vitest';

import { AUTH_CONFIG } from '../config/auth.config';
import {
  LOCAL_QUEUE_CONFIG,
  type ActionQueueStorageService,
} from './action-queue-storage.service';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';

interface ActionQueueStorageOwnerSettlementSpecContext {
  getService: () => ActionQueueStorageService;
  createMockAction: (overrides?: Partial<QueuedAction>) => QueuedAction;
  getCurrentUserId: () => {
    set(value: string | null): void;
  };
  backupDeadLetters: (ownerUserId: string, items: DeadLetterItem[]) => Promise<boolean>;
}

export function registerActionQueueStorageOwnerSettlementSpecs(
  context: ActionQueueStorageOwnerSettlementSpecContext,
): void {
  describe('owner queue recovery', () => {
    it('loadQueueSnapshotForOwner should restore IndexedDB backup when owner localStorage mirror is malformed', async () => {
      const durableAction = context.createMockAction({
        id: 'old-owner-malformed-local-idb-action',
        entityType: 'task',
        entityId: 'task-malformed-local-idb-action',
        payload: {
          task: { id: 'task-malformed-local-idb-action', title: 'Durable offline action' },
          projectId: 'project-malformed-local-idb-action',
        } as never,
      });
      const ownerQueueKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.old-owner`;
      await context.getService().persistQueueSnapshotForOwner('old-owner', [durableAction]);
      localStorage.setItem(ownerQueueKey, '{malformed-owner-queue');

      await expect(context.getService().loadQueueSnapshotForOwner('old-owner'))
        .resolves.toEqual([durableAction]);
    });

    it('loadQueueSnapshotForOwner should prefer newer IndexedDB backup over valid stale owner localStorage mirror', async () => {
      const staleLocalAction = context.createMockAction({
        id: 'old-owner-valid-stale-local-action',
        entityType: 'task',
        entityId: 'task-valid-stale-local-action',
        timestamp: 1_000,
        localCommittedAt: 1_000,
        payload: {
          task: { id: 'task-valid-stale-local-action', title: 'Stale local mirror action' },
          projectId: 'project-valid-stale-local-action',
        } as never,
      });
      const durableAction = context.createMockAction({
        id: 'old-owner-newer-idb-action',
        entityType: 'task',
        entityId: 'task-newer-idb-action',
        timestamp: 2_000,
        localCommittedAt: 2_000,
        payload: {
          task: { id: 'task-newer-idb-action', title: 'Newer durable action' },
          projectId: 'project-newer-idb-action',
        } as never,
      });
      const ownerQueueKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.old-owner`;
      await context.getService().persistQueueSnapshotForOwner('old-owner', [durableAction]);
      localStorage.setItem(ownerQueueKey, JSON.stringify([staleLocalAction]));

      await expect(context.getService().loadQueueSnapshotForOwner('old-owner'))
        .resolves.toEqual([durableAction]);
    });
  });

  describe('owner successful action settlement', () => {
    it('settleSuccessfulActionForOwner should preserve newer IndexedDB-only owner actions when localStorage is stale', async () => {
      const successfulAction = context.createMockAction({
        id: 'old-owner-successful-action',
        entityType: 'task',
        entityId: 'task-successful-action',
        payload: {
          task: { id: 'task-successful-action', title: 'Synced task' },
          projectId: 'project-synced',
        } as never,
      });
      const idbOnlyNewerAction = context.createMockAction({
        id: 'old-owner-success-idb-only-newer-action',
        entityType: 'task',
        entityId: 'task-success-idb-only-newer',
        payload: {
          task: { id: 'task-success-idb-only-newer', title: 'Newer local task' },
          projectId: 'project-keep',
        } as never,
      });
      const ownerQueueKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.old-owner`;
      await context.getService().persistQueueSnapshotForOwner('old-owner', [
        successfulAction,
        idbOnlyNewerAction,
      ]);
      localStorage.setItem(ownerQueueKey, JSON.stringify([successfulAction]));

      const settled = await context.getService().settleSuccessfulActionForOwner(
        'old-owner',
        'old-owner-successful-action',
      );

      expect(settled).toBe(true);
      expect(JSON.parse(localStorage.getItem(ownerQueueKey)!) as QueuedAction[])
        .toEqual([idbOnlyNewerAction]);
      await expect(context.getService().loadQueueSnapshotForOwner('old-owner'))
        .resolves.toEqual([idbOnlyNewerAction]);
    });

    it('settleSuccessfulActionForOwner should preserve localStorage-only newer actions when IndexedDB record is stale', async () => {
      const successfulAction = context.createMockAction({
        id: 'old-owner-successful-action-stale-idb',
        entityType: 'task',
        entityId: 'task-successful-action-stale-idb',
        payload: {
          task: { id: 'task-successful-action-stale-idb', title: 'Synced task' },
          projectId: 'project-synced',
        } as never,
      });
      const localStorageOnlyNewerAction = context.createMockAction({
        id: 'old-owner-success-localstorage-only-newer-action',
        entityType: 'task',
        entityId: 'task-success-localstorage-only-newer',
        payload: {
          task: { id: 'task-success-localstorage-only-newer', title: 'Newer local task' },
          projectId: 'project-keep',
        } as never,
      });
      const ownerQueueKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.old-owner`;
      await context.getService().persistQueueSnapshotForOwner('old-owner', [
        successfulAction,
      ]);
      localStorage.setItem(ownerQueueKey, JSON.stringify([
        successfulAction,
        localStorageOnlyNewerAction,
      ]));

      const settled = await context.getService().settleSuccessfulActionForOwner(
        'old-owner',
        'old-owner-successful-action-stale-idb',
      );

      expect(settled).toBe(true);
      expect(JSON.parse(localStorage.getItem(ownerQueueKey)!) as QueuedAction[])
        .toEqual([localStorageOnlyNewerAction]);
      await expect(context.getService().loadQueueSnapshotForOwner('old-owner'))
        .resolves.toEqual([localStorageOnlyNewerAction]);
    });
  });

  describe('owner project delete settlement', () => {
    it('settleProjectDeleteSuccessForOwner should remove connection actions for the deleted project', async () => {
      const taskAction = context.createMockAction({
        id: 'old-owner-task-delete-project',
        entityType: 'task',
        entityId: 'task-delete-project',
        payload: { task: { id: 'task-delete-project', title: 'Task' }, projectId: 'project-delete' } as never,
      });
      const connectionAction = context.createMockAction({
        id: 'old-owner-connection-delete-project',
        entityType: 'connection',
        entityId: 'connection-delete-project',
        payload: {
          connection: { id: 'connection-delete-project', source: 'task-a', target: 'task-b' },
          projectId: 'project-delete',
        } as never,
      });
      const keptConnectionAction = context.createMockAction({
        id: 'old-owner-connection-keep',
        entityType: 'connection',
        entityId: 'connection-keep',
        payload: {
          connection: { id: 'connection-keep', source: 'task-a', target: 'task-c' },
          projectId: 'project-keep',
        } as never,
      });
      const ownerQueueKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.old-owner`;
      localStorage.setItem(ownerQueueKey, JSON.stringify([
        taskAction,
        connectionAction,
        keptConnectionAction,
      ]));

      const removed = await context.getService().settleProjectDeleteSuccessForOwner(
        'old-owner',
        'project-delete',
      );

      expect(removed).toBe(2);
      expect(JSON.parse(localStorage.getItem(ownerQueueKey)!) as QueuedAction[])
        .toEqual([keptConnectionAction]);
    });

    it('settleProjectDeleteSuccessForOwner should preserve newer IndexedDB-only owner actions when localStorage is stale', async () => {
      const projectDeleteAction = context.createMockAction({
        id: 'old-owner-project-delete',
        entityType: 'project',
        entityId: 'project-delete',
        payload: { projectId: 'project-delete' } as never,
      });
      const idbOnlyNewerAction = context.createMockAction({
        id: 'old-owner-idb-only-newer-action',
        entityType: 'task',
        entityId: 'task-idb-only-newer',
        payload: {
          task: { id: 'task-idb-only-newer', title: 'Newer local task' },
          projectId: 'project-keep',
        } as never,
      });
      const ownerQueueKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.old-owner`;
      await context.getService().persistQueueSnapshotForOwner('old-owner', [
        projectDeleteAction,
        idbOnlyNewerAction,
      ]);
      localStorage.setItem(ownerQueueKey, JSON.stringify([projectDeleteAction]));

      const removed = await context.getService().settleProjectDeleteSuccessForOwner(
        'old-owner',
        'project-delete',
        'old-owner-project-delete',
      );

      expect(removed).toBe(1);
      expect(JSON.parse(localStorage.getItem(ownerQueueKey)!) as QueuedAction[])
        .toEqual([idbOnlyNewerAction]);
      await expect(context.getService().loadQueueSnapshotForOwner('old-owner'))
        .resolves.toEqual([idbOnlyNewerAction]);
    });
  });

  describe('owner failed action settlement', () => {
    it('settleFailedActionForOwner should persist retryable owner action as retry_scheduled', async () => {
      const action = context.createMockAction({
        id: 'owner-retry-state',
        retryCount: 1,
        syncState: 'syncing',
      });
      const ownerQueueKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.old-owner`;
      localStorage.setItem(ownerQueueKey, JSON.stringify([action]));

      const result = await context.getService().settleFailedActionForOwner(
        'old-owner',
        action,
        'Network timeout',
      );

      const [storedAction] = JSON.parse(localStorage.getItem(ownerQueueKey)!) as QueuedAction[];
      expect(result).toBe('retry');
      expect(storedAction.retryCount).toBe(2);
      expect(storedAction.syncState).toBe('retry_scheduled');
    });

    it('settleFailedActionForOwner should preserve newer IndexedDB-only owner actions when retrying', async () => {
      const failedAction = context.createMockAction({
        id: 'owner-retry-stale-mirror',
        retryCount: 1,
        syncState: 'syncing',
      });
      const idbOnlyNewerAction = context.createMockAction({
        id: 'owner-retry-idb-only-newer-action',
        entityType: 'task',
        entityId: 'task-retry-idb-only-newer',
        payload: {
          task: { id: 'task-retry-idb-only-newer', title: 'Newer local task' },
          projectId: 'project-keep',
        } as never,
      });
      const ownerQueueKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.old-owner`;
      await context.getService().persistQueueSnapshotForOwner('old-owner', [
        failedAction,
        idbOnlyNewerAction,
      ]);
      localStorage.setItem(ownerQueueKey, JSON.stringify([failedAction]));

      const result = await context.getService().settleFailedActionForOwner(
        'old-owner',
        failedAction,
        'Network timeout',
      );

      const stored = JSON.parse(localStorage.getItem(ownerQueueKey)!) as QueuedAction[];
      expect(result).toBe('retry');
      expect(stored.map(action => action.id)).toEqual([
        'owner-retry-stale-mirror',
        'owner-retry-idb-only-newer-action',
      ]);
      expect(stored[0]).toEqual(expect.objectContaining({
        retryCount: 2,
        syncState: 'retry_scheduled',
      }));
      expect(stored[1]).toEqual(idbOnlyNewerAction);
      await expect(context.getService().loadQueueSnapshotForOwner('old-owner'))
        .resolves.toEqual(stored);
    });

    it('settleFailedActionForOwner should keep auth-expired owner action blocked without consuming retry budget', async () => {
      const action = context.createMockAction({
        id: 'owner-auth-blocked-state',
        retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES,
        syncState: 'syncing',
      });
      const ownerQueueKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.old-owner`;
      localStorage.setItem(ownerQueueKey, JSON.stringify([action]));

      const result = await context.getService().settleFailedActionForOwner(
        'old-owner',
        action,
        'SYNC_AUTH_EXPIRED | 登录已过期，请重新登录 | [AuthError:42501]',
      );

      const [storedAction] = JSON.parse(localStorage.getItem(ownerQueueKey)!) as QueuedAction[];
      expect(result).toBe('retry');
      expect(storedAction.retryCount).toBe(LOCAL_QUEUE_CONFIG.MAX_RETRIES);
      expect(storedAction.syncState).toBe('blocked_by_auth');
    });

    it('settleFailedActionForOwner should preserve dead-lettered owner actions as dead_letter', async () => {
      const action = context.createMockAction({
        id: 'owner-dead-letter-state',
        retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES,
        syncState: 'syncing',
      });
      const ownerQueueKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.old-owner`;
      const ownerDeadLetterKey = `${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.old-owner`;
      localStorage.setItem(ownerQueueKey, JSON.stringify([action]));

      const result = await context.getService().settleFailedActionForOwner(
        'old-owner',
        action,
        'Network timeout',
      );

      const deadLetters = JSON.parse(localStorage.getItem(ownerDeadLetterKey)!) as DeadLetterItem[];
      expect(result).toBe('dead-letter');
      expect(JSON.parse(localStorage.getItem(ownerQueueKey)!) as QueuedAction[]).toEqual([]);
      expect(deadLetters[0].action.syncState).toBe('dead_letter');
    });

    it('settleFailedActionForOwner should not remove owner action when dead-letter persistence fails', async () => {
      const originalLocalStorage = globalThis.localStorage;
      const action = context.createMockAction({
        id: 'owner-dead-letter-save-failure',
        retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES,
      });
      const ownerQueueKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.old-owner`;
      const ownerDeadLetterKey = `${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.old-owner`;
      const storageData = new Map<string, string>([
        [ownerQueueKey, JSON.stringify([action])],
      ]);
      const failingStorage = {
        getItem: (key: string) => storageData.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (key === ownerDeadLetterKey) {
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
      const service = context.getService();

      Object.defineProperty(globalThis, 'localStorage', {
        value: failingStorage,
        configurable: true,
        writable: true,
      });

      try {
        service.onStorageFailure(storageFailureCallback);

        await expect(
          service.settleFailedActionForOwner('old-owner', action, 'Network timeout'),
        ).rejects.toThrow('owner-scoped dead-letter 保存失败');

        expect(JSON.parse(globalThis.localStorage.getItem(ownerQueueKey)!) as QueuedAction[])
          .toEqual([action]);
        expect(globalThis.localStorage.getItem(ownerDeadLetterKey)).toBeNull();
        expect(service.queueFrozen()).toBe(true);
        expect(service.queueFreezeReason()).toBe('storage_failure');
        expect(storageFailureCallback).toHaveBeenCalled();
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          value: originalLocalStorage,
          configurable: true,
          writable: true,
        });
      }
    });

    it('settleFailedActionForOwner should preserve newer IndexedDB-only owner actions when dead-lettering', async () => {
      const failedAction = context.createMockAction({
        id: 'owner-dead-letter-stale-mirror',
        retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES,
        syncState: 'syncing',
      });
      const idbOnlyNewerAction = context.createMockAction({
        id: 'owner-dead-letter-idb-only-newer-action',
        entityType: 'task',
        entityId: 'task-dead-letter-idb-only-newer',
        payload: {
          task: { id: 'task-dead-letter-idb-only-newer', title: 'Newer local task' },
          projectId: 'project-keep',
        } as never,
      });
      const ownerQueueKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.old-owner`;
      const ownerDeadLetterKey = `${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.old-owner`;
      await context.getService().persistQueueSnapshotForOwner('old-owner', [
        failedAction,
        idbOnlyNewerAction,
      ]);
      localStorage.setItem(ownerQueueKey, JSON.stringify([failedAction]));

      const result = await context.getService().settleFailedActionForOwner(
        'old-owner',
        failedAction,
        'Network timeout',
      );

      expect(result).toBe('dead-letter');
      expect(JSON.parse(localStorage.getItem(ownerQueueKey)!) as QueuedAction[])
        .toEqual([idbOnlyNewerAction]);
      await expect(context.getService().loadQueueSnapshotForOwner('old-owner'))
        .resolves.toEqual([idbOnlyNewerAction]);
      const deadLetters = JSON.parse(localStorage.getItem(ownerDeadLetterKey)!) as DeadLetterItem[];
      expect(deadLetters[0].action.id).toBe('owner-dead-letter-stale-mirror');
      expect(deadLetters[0].action.syncState).toBe('dead_letter');
    });

    it('settleFailedActionForOwner should merge IndexedDB dead-letter backup when local dead-letter mirror is corrupt', async () => {
      const existingDeadLetterAction = context.createMockAction({
        id: 'owner-existing-dead-letter-backup',
        entityType: 'task',
        entityId: 'task-existing-dead-letter-backup',
        payload: {
          task: { id: 'task-existing-dead-letter-backup', title: 'Existing dead letter' },
          projectId: 'project-existing-dead-letter-backup',
        } as never,
      });
      const failedAction = context.createMockAction({
        id: 'owner-new-dead-letter-after-corrupt-local',
        retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES,
        syncState: 'syncing',
      });
      const ownerQueueKey = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-a`;
      const ownerDeadLetterKey = `${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`;
      const existingDeadLetter: DeadLetterItem = {
        action: {
          ...existingDeadLetterAction,
          syncState: 'dead_letter',
        },
        failedAt: new Date().toISOString(),
        reason: 'existing backup',
      };
      await context.backupDeadLetters('user-a', [existingDeadLetter]);
      localStorage.setItem(ownerQueueKey, JSON.stringify([failedAction]));
      localStorage.setItem(ownerDeadLetterKey, '{corrupt-owner-dead-letter');

      const result = await context.getService().settleFailedActionForOwner(
        'user-a',
        failedAction,
        'Network timeout',
      );

      const deadLetters = JSON.parse(localStorage.getItem(ownerDeadLetterKey)!) as DeadLetterItem[];
      expect(result).toBe('dead-letter');
      expect(deadLetters.map(item => item.action.id)).toEqual([
        'owner-existing-dead-letter-backup',
        'owner-new-dead-letter-after-corrupt-local',
      ]);
      expect(deadLetters.every(item => item.action.syncState === 'dead_letter')).toBe(true);
    });
  });

  describe('owner dead-letter persistence', () => {
    it('saveDeadLetterToStorage should not delete untouched legacy global dead-letter queue for signed-in owners', () => {
      localStorage.setItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY, JSON.stringify([
        {
          action: context.createMockAction({ id: 'legacy-dead-letter' }),
          failedAt: new Date().toISOString(),
          reason: 'legacy',
        },
      ]));

      context.getService().moveToDeadLetter(
        context.createMockAction({ id: 'scoped-dead-letter' }),
        'scoped',
      );

      expect(localStorage.getItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY))
        .toContain('legacy-dead-letter');
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`))
        .toContain('scoped-dead-letter');
    });

    it('loadDeadLetterFromStorage 超龄死信应保留并修复非法 failedAt，而不是静默删除', () => {
      // §5.6：死信是失败写入的最后一份副本，必须随时可导出/可重放；
      // 24h TTL 到期静默删除等效于替用户 dismiss，容量上限 MAX_DEAD_LETTER_SIZE 负责封顶
      const recentItem: DeadLetterItem = {
        action: context.createMockAction({ id: 'recent-dead-letter' }),
        failedAt: new Date().toISOString(),
        reason: 'recent',
      };
      const agedItem: DeadLetterItem = {
        action: context.createMockAction({ id: 'aged-dead-letter' }),
        failedAt: new Date(Date.now() - LOCAL_QUEUE_CONFIG.DEAD_LETTER_TTL - 1000).toISOString(),
        reason: 'aged',
      };
      const corruptTimestampItem: DeadLetterItem = {
        action: context.createMockAction({ id: 'corrupt-failed-at-dead-letter' }),
        failedAt: 'not-a-timestamp',
        reason: 'corrupt-failed-at',
      };
      const service = context.getService();

      localStorage.setItem(
        `${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`,
        JSON.stringify([recentItem, agedItem, corruptTimestampItem]),
      );

      service.loadDeadLetterFromStorage();

      expect(service.deadLetterQueue().map(item => item.reason)).toEqual([
        'recent',
        'aged',
        'corrupt-failed-at',
      ]);
      const repaired = service.deadLetterQueue().find(item => item.reason === 'corrupt-failed-at');
      expect(repaired).toBeDefined();
      expect(Number.isFinite(new Date(repaired!.failedAt).getTime())).toBe(true);
    });

    it('loadDeadLetterFromStorage should quarantine signed-in legacy global dead-letter into unknown-owner bucket', () => {
      const legacyDeadLetter: DeadLetterItem = {
        action: context.createMockAction({ id: 'legacy-global-dead-letter' }),
        failedAt: new Date().toISOString(),
        reason: 'legacy failed',
      };
      localStorage.setItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY, JSON.stringify([legacyDeadLetter]));

      context.getService().loadDeadLetterFromStorage();

      expect(context.getService().deadLetterQueue()).toEqual([]);
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-a`)).toBeNull();
      expect(localStorage.getItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY)).toBeNull();
    });

    it('loadDeadLetterFromStorage should quarantine legacy global dead-letter even for local-user', () => {
      context.getCurrentUserId().set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      const legacyDeadLetter: DeadLetterItem = {
        action: context.createMockAction({ id: 'legacy-local-dead-letter' }),
        failedAt: new Date().toISOString(),
        reason: 'legacy local failed',
      };
      localStorage.setItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY, JSON.stringify([legacyDeadLetter]));

      context.getService().loadDeadLetterFromStorage();

      expect(context.getService().deadLetterQueue()).toEqual([]);
      expect(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.${AUTH_CONFIG.LOCAL_MODE_USER_ID}`)).toBeNull();
      expect(localStorage.getItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY)).toBeNull();
    });

    it('restoreDeadLettersFromBackupItems should merge owner dead letters without duplicating or reviving stale entries', () => {
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
      const service = context.getService();

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
  });
}
