import { describe, expect, it, vi, type Mock } from 'vitest';

import type { Task } from '../models';
import type { ActionQueueService, EnqueueParams } from './action-queue.service';
import type { QueuedAction } from './action-queue.types';

export interface ActionQueuePersistenceSpecContext {
  service(): ActionQueueService;
  setNetworkStatus(online: boolean): void;
  createTestProjectAction(): EnqueueParams;
  createTestTaskAction(): EnqueueParams;
  createMockTask(overrides?: Partial<Task>): Task;
  mockQueueBackupService: {
    updateQueue: Mock;
  };
  getMockQueueBackupPersistedQueue(): QueuedAction[];
  setMockQueueBackupPersistedQueue(queue: QueuedAction[]): void;
  setMockQueueBackupRecordFound(recordFound: boolean): void;
}

export function registerActionQueuePersistenceSpecs(context: ActionQueuePersistenceSpecContext): void {
  const {
    setNetworkStatus,
    createTestProjectAction,
    createTestTaskAction,
    createMockTask,
    mockQueueBackupService,
  } = context;

  const service = () => context.service();
  const persistedQueue = () => context.getMockQueueBackupPersistedQueue();
  const setPersistedQueue = (queue: QueuedAction[]) =>
    context.setMockQueueBackupPersistedQueue(queue);

  describe('队列持久化', () => {
    it('应该将队列持久化到 localStorage', () => {
      setNetworkStatus(false);
      service().enqueue(createTestProjectAction());

      const saved = localStorage.getItem('nanoflow.action-queue.test-user');
      expect(saved).toBeTruthy();

      const parsed = JSON.parse(saved!);
      expect(parsed).toHaveLength(1);
    });

    it('durable 入队持久化确认失败时不应留下本地队列残余', async () => {
      setNetworkStatus(false);
      vi.spyOn(service().storage, 'persistQueueMutationForOwner').mockResolvedValueOnce(null);

      const actionId = await service().enqueueDurably(createTestTaskAction());

      expect(actionId).toBe('');
      expect(service().pendingActions()).toEqual([]);
      expect(service().queueSize()).toBe(0);
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toBeNull();
    });

    it('enqueueForOwner 写入当前 owner 时应要求 durable 持久化确认', async () => {
      setNetworkStatus(false);
      vi.spyOn(service().storage, 'persistQueueMutationForOwner').mockResolvedValueOnce(null);

      const actionId = await service().enqueueForOwner('test-user', createTestTaskAction());

      expect(actionId).toBe('');
      expect(service().pendingActions()).toEqual([]);
      expect(service().queueSize()).toBe(0);
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toBeNull();
    });

    it('durable 入队应基于持久 Outbox 合并，避免覆盖其他标签页已写入操作', async () => {
      setNetworkStatus(false);
      const existingAction: QueuedAction = {
        id: 'existing-action',
        operationId: 'existing-operation',
        type: 'update',
        entityType: 'task',
        entityId: 'task-from-other-tab',
        payload: {
          task: createMockTask({ id: 'task-from-other-tab', title: 'other tab' }),
          projectId: 'proj-1',
        },
        timestamp: 1,
        localCommittedAt: 1,
        syncState: 'pending_sync',
        retryCount: 0,
        priority: 'normal',
      };
      setPersistedQueue([existingAction]);

      const actionId = await service().enqueueDurably({
        type: 'update',
        entityType: 'task',
        entityId: 'task-current-tab',
        payload: {
          task: createMockTask({ id: 'task-current-tab', title: 'current tab' }),
          projectId: 'proj-1',
        },
      });

      expect(actionId).toEqual(expect.any(String));
      expect(mockQueueBackupService.updateQueue).toHaveBeenCalledWith('test-user', expect.any(Function));
      expect(persistedQueue().map(action => action.entityId).sort()).toEqual([
        'task-current-tab',
        'task-from-other-tab',
      ]);
      expect(service().pendingActions().map(action => action.entityId).sort()).toEqual([
        'task-current-tab',
        'task-from-other-tab',
      ]);
    });

    it('durable 入队在 IndexedDB 已有空队列记录时不应复活滞后的 localStorage action', async () => {
      setNetworkStatus(false);
      const staleAction: QueuedAction = {
        id: 'stale-action',
        operationId: 'stale-operation',
        type: 'update',
        entityType: 'task',
        entityId: 'task-already-synced',
        payload: {
          task: createMockTask({ id: 'task-already-synced', title: 'already synced' }),
          projectId: 'proj-1',
        },
        timestamp: 1,
        localCommittedAt: 1,
        syncState: 'pending_sync',
        retryCount: 0,
        priority: 'normal',
      };
      localStorage.setItem('nanoflow.action-queue.test-user', JSON.stringify([staleAction]));
      setPersistedQueue([]);
      context.setMockQueueBackupRecordFound(true);

      const actionId = await service().enqueueDurably({
        type: 'update',
        entityType: 'task',
        entityId: 'task-current-tab',
        payload: {
          task: createMockTask({ id: 'task-current-tab', title: 'current tab' }),
          projectId: 'proj-1',
        },
      });

      expect(actionId).toEqual(expect.any(String));
      expect(persistedQueue().map(action => action.entityId)).toEqual(['task-current-tab']);
      expect(service().pendingActions().map(action => action.entityId)).toEqual(['task-current-tab']);
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).not.toContain('task-already-synced');
    });

    it('localStorage 快照损坏时应继续从 IndexedDB 备份恢复 Outbox', async () => {
      setNetworkStatus(false);
      const backupAction: QueuedAction = {
        id: 'backup-action',
        operationId: 'backup-operation',
        type: 'update',
        entityType: 'task',
        entityId: 'task-from-idb-backup',
        payload: {
          task: createMockTask({ id: 'task-from-idb-backup', title: 'from backup' }),
          projectId: 'proj-1',
        },
        timestamp: 1,
        localCommittedAt: 1,
        syncState: 'pending_sync',
        retryCount: 0,
        priority: 'normal',
      };
      setPersistedQueue([backupAction]);
      context.setMockQueueBackupRecordFound(true);
      localStorage.setItem('nanoflow.action-queue.test-user', '{bad json');

      service().reloadFromStorageForCurrentOwner();
      await Promise.resolve();
      await Promise.resolve();

      expect(service().pendingActions()).toEqual([
        expect.objectContaining({
          id: 'backup-action',
          entityId: 'task-from-idb-backup',
          syncState: 'pending_sync',
        }),
      ]);
      expect(service().queueSize()).toBe(1);
    });

    it('IndexedDB mutation 抛错但 localStorage 可用时 durable 入队应降级持久化成功', async () => {
      setNetworkStatus(false);
      mockQueueBackupService.updateQueue.mockRejectedValueOnce(new Error('idb transaction blocked'));

      const actionId = await service().enqueueDurably({
        type: 'update',
        entityType: 'task',
        entityId: 'task-idb-fallback',
        payload: {
          task: createMockTask({ id: 'task-idb-fallback', title: 'fallback to localStorage' }),
          projectId: 'proj-1',
        },
      });

      expect(actionId).toEqual(expect.any(String));
      expect(service().pendingActions()).toEqual([
        expect.objectContaining({
          id: actionId,
          entityId: 'task-idb-fallback',
          syncState: 'pending_sync',
        }),
      ]);
      expect(service().queueSize()).toBe(1);
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain('task-idb-fallback');
      expect(persistedQueue().map(action => action.entityId)).toEqual(['task-idb-fallback']);
    });

    it('foreign owner durable fallback 不应把当前 owner 队列混入目标 owner outbox', async () => {
      setNetworkStatus(false);
      await service().enqueueDurably({
        type: 'update',
        entityType: 'task',
        entityId: 'task-current-owner-only',
        payload: {
          task: createMockTask({ id: 'task-current-owner-only', title: 'current owner only' }),
          projectId: 'proj-1',
        },
      });
      mockQueueBackupService.updateQueue.mockRejectedValueOnce(new Error('idb blocked for owner-b'));

      const actionId = await service().enqueueDurablyForOwner('owner-b', {
        type: 'update',
        entityType: 'project',
        entityId: 'project-owner-b-only',
        payload: {
          project: {
            id: 'project-owner-b-only',
            name: 'Owner B only',
            description: '',
            createdDate: '2026-06-15T00:00:00.000Z',
            tasks: [],
            connections: [],
          },
          sourceUserId: 'owner-b',
        },
      });

      const ownerBQueue = await service().storage.loadQueueSnapshotForOwner('owner-b');

      expect(actionId).toEqual(expect.any(String));
      expect(service().pendingActions().map(action => action.entityId)).toEqual(['task-current-owner-only']);
      expect(ownerBQueue.map(action => action.entityId)).toEqual(['project-owner-b-only']);
      expect(localStorage.getItem('nanoflow.action-queue.owner-b')).not.toContain('task-current-owner-only');
    });

    it('foreign owner 批量 durable 入队在 IndexedDB 不可用时应写入目标 owner outbox 且不污染当前队列', async () => {
      setNetworkStatus(false);
      await service().enqueueDurably({
        type: 'update',
        entityType: 'task',
        entityId: 'task-current-owner-only',
        payload: {
          task: createMockTask({ id: 'task-current-owner-only', title: 'current owner only' }),
          projectId: 'proj-1',
        },
      });

      mockQueueBackupService.updateQueue.mockRejectedValueOnce(new Error('idb blocked for owner-b bulk'));

      const actionIds = await service().enqueueManyDurablyForOwner('owner-b', [
        {
          type: 'update',
          entityType: 'task',
          entityId: 'task-owner-b-bulk',
          payload: {
            task: createMockTask({ id: 'task-owner-b-bulk', title: 'owner b task' }),
            projectId: 'proj-owner-b',
            sourceUserId: 'owner-b',
          },
        },
        {
          type: 'update',
          entityType: 'connection',
          entityId: 'connection-owner-b-bulk',
          payload: {
            connection: {
              id: 'connection-owner-b-bulk',
              source: 'task-owner-b-bulk',
              target: 'task-owner-b-target',
            },
            projectId: 'proj-owner-b',
            sourceUserId: 'owner-b',
          },
        },
      ]);

      const ownerBQueue = await service().storage.loadQueueSnapshotForOwner('owner-b');

      expect(actionIds).toHaveLength(2);
      expect(mockQueueBackupService.updateQueue).toHaveBeenLastCalledWith('owner-b', expect.any(Function));
      expect(service().pendingActions().map(action => action.entityId)).toEqual(['task-current-owner-only']);
      expect(ownerBQueue.map(action => action.entityId).sort()).toEqual([
        'connection-owner-b-bulk',
        'task-owner-b-bulk',
      ]);
      expect(localStorage.getItem('nanoflow.action-queue.owner-b')).toContain('task-owner-b-bulk');
      expect(localStorage.getItem('nanoflow.action-queue.owner-b')).not.toContain('task-current-owner-only');
    });

    it('批量 durable 入队应在一次持久 Outbox mutation 中追加所有操作', async () => {
      setNetworkStatus(false);
      const existingAction: QueuedAction = {
        id: 'existing-action',
        operationId: 'existing-operation',
        type: 'update',
        entityType: 'task',
        entityId: 'task-from-other-tab',
        payload: {
          task: createMockTask({ id: 'task-from-other-tab', title: 'other tab' }),
          projectId: 'proj-1',
        },
        timestamp: 1,
        localCommittedAt: 1,
        syncState: 'pending_sync',
        retryCount: 0,
        priority: 'normal',
      };
      setPersistedQueue([existingAction]);

      const actionIds = await service().enqueueManyDurably([
        {
          type: 'update',
          entityType: 'task',
          entityId: 'task-bulk-a',
          payload: {
            task: createMockTask({ id: 'task-bulk-a', title: 'bulk a' }),
            projectId: 'proj-1',
          },
        },
        {
          type: 'update',
          entityType: 'connection',
          entityId: 'connection-bulk-b',
          payload: {
            connection: { id: 'connection-bulk-b', source: 'task-bulk-a', target: 'task-from-other-tab' },
            projectId: 'proj-1',
          },
        },
      ]);

      expect(actionIds).toHaveLength(2);
      expect(mockQueueBackupService.updateQueue).toHaveBeenCalledTimes(1);
      expect(persistedQueue().map(action => action.entityId).sort()).toEqual([
        'connection-bulk-b',
        'task-bulk-a',
        'task-from-other-tab',
      ]);
      expect(service().pendingActions().map(action => action.entityId).sort()).toEqual([
        'connection-bulk-b',
        'task-bulk-a',
        'task-from-other-tab',
      ]);
    });

    it('批量 durable 入队中任一操作被拒绝时不应留下部分持久化 action', async () => {
      setNetworkStatus(false);
      setPersistedQueue(Array.from({ length: 499 }, (_, index): QueuedAction => ({
        id: `existing-${index}`,
        operationId: `operation-${index}`,
        type: 'update',
        entityType: 'task',
        entityId: `existing-task-${index}`,
        payload: {
          task: createMockTask({ id: `existing-task-${index}` }),
          projectId: 'proj-1',
        },
        timestamp: index,
        localCommittedAt: index,
        syncState: 'pending_sync',
        retryCount: 0,
        priority: 'normal',
      })));

      const actionIds = await service().enqueueManyDurably([
        {
          type: 'update',
          entityType: 'task',
          entityId: 'task-bulk-overflow-a',
          payload: {
            task: createMockTask({ id: 'task-bulk-overflow-a' }),
            projectId: 'proj-1',
          },
        },
        {
          type: 'update',
          entityType: 'task',
          entityId: 'task-bulk-overflow-b',
          payload: {
            task: createMockTask({ id: 'task-bulk-overflow-b' }),
            projectId: 'proj-1',
          },
        },
      ]);

      expect(actionIds).toEqual([]);
      expect(persistedQueue()).toHaveLength(499);
      expect(persistedQueue().some(action => action.entityId === 'task-bulk-overflow-a')).toBe(false);
      expect(persistedQueue().some(action => action.entityId === 'task-bulk-overflow-b')).toBe(false);
      expect(service().pendingActions()).toEqual([]);
      expect(service().queueSize()).toBe(0);
    });

    it('处理成功后应从持久 IndexedDB Outbox 收口，避免刷新后重复提交', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service().registerProcessor('task:update', processor);
      setNetworkStatus(false);
      await service().enqueueDurably({
        type: 'update',
        entityType: 'task',
        entityId: 'task-durable-drained',
        payload: {
          task: createMockTask({ id: 'task-durable-drained', title: 'drain me' }),
          projectId: 'proj-1',
        },
      });
      expect(persistedQueue().map(action => action.entityId)).toEqual(['task-durable-drained']);

      setNetworkStatus(true);
      await service().processQueue();

      expect(processor).toHaveBeenCalledTimes(1);
      expect(service().pendingActions()).toEqual([]);
      expect(persistedQueue()).toEqual([]);
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toBe('[]');
    });

    it('处理成功但持久 Outbox 收口失败时应保留 action 等待恢复重放', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service().registerProcessor('task:update', processor);
      setNetworkStatus(false);
      const actionId = await service().enqueueDurably({
        type: 'update',
        entityType: 'task',
        entityId: 'task-durable-retained',
        payload: {
          task: createMockTask({ id: 'task-durable-retained', title: 'retain me' }),
          projectId: 'proj-1',
        },
      });
      expect(persistedQueue().map(action => action.entityId)).toEqual(['task-durable-retained']);

      vi.spyOn(service().storage, 'persistQueueMutationForOwner').mockResolvedValueOnce(null);

      setNetworkStatus(true);
      const result = await service().processQueue();

      expect(result.processed).toBe(1);
      expect(processor).toHaveBeenCalledTimes(1);
      expect(service().pendingActions()).toEqual([
        expect.objectContaining({
          id: actionId,
          entityId: 'task-durable-retained',
          syncState: 'pending_sync',
        }),
      ]);
      expect(service().queueSize()).toBe(1);
      expect(persistedQueue().map(action => action.entityId)).toEqual(['task-durable-retained']);
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain(actionId);
    });

    it('不可重试失败进入死信后应从持久 IndexedDB Outbox 删除主队列 action', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('invalid input'));
      service().registerProcessor('task:update', processor);
      setNetworkStatus(false);
      await service().enqueueDurably({
        type: 'update',
        entityType: 'task',
        entityId: 'task-dead-letter-drained',
        payload: {
          task: createMockTask({ id: 'task-dead-letter-drained', title: 'dead letter me' }),
          projectId: 'proj-1',
        },
      });
      expect(persistedQueue().map(action => action.entityId)).toEqual(['task-dead-letter-drained']);

      setNetworkStatus(true);
      await service().processQueue();

      expect(processor).toHaveBeenCalledTimes(1);
      expect(service().pendingActions()).toEqual([]);
      expect(service().deadLetterQueue()[0]?.action.entityId).toBe('task-dead-letter-drained');
      expect(persistedQueue()).toEqual([]);
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toBe('[]');
      expect(localStorage.getItem('nanoflow.dead-letter-queue.test-user')).toContain('task-dead-letter-drained');
    });

    it('应该持久化死信队列', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('invalid input'));
      service().registerProcessor('task:create', processor);

      setNetworkStatus(false);
      service().enqueue({
        type: 'create',
        entityType: 'task',
        entityId: `task-${Date.now()}`,
        payload: { task: createMockTask({ id: 'task-1' }), projectId: 'proj-1' },
      });

      setNetworkStatus(true);
      await service().processQueue();

      const savedDeadLetter = localStorage.getItem('nanoflow.dead-letter-queue.test-user');
      expect(savedDeadLetter).toBeTruthy();

      const parsed = JSON.parse(savedDeadLetter!);
      expect(parsed).toHaveLength(1);
    });
  });
}
