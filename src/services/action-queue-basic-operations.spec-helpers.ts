import { beforeEach, describe, expect, it, type Mock } from 'vitest';

import type { Project, Task } from '../models';
import type { ActionQueueService, EnqueueParams } from './action-queue.service';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';

export interface ActionQueueBasicOperationsSpecContext {
  service(): ActionQueueService;
  setNetworkStatus(online: boolean): void;
  createTestProjectAction(): EnqueueParams;
  createMockProject(overrides?: Partial<Project>): Project;
  mockToastService: {
    warning: Mock;
  };
}

export function registerActionQueueBasicOperationSpecs(context: ActionQueueBasicOperationsSpecContext): void {
  let service: ActionQueueService;
  const {
    setNetworkStatus,
    createTestProjectAction,
    createMockProject,
    mockToastService,
  } = context;

  beforeEach(() => {
    service = context.service();
  });

  describe('基本队列操作', () => {
    it('应该能够入队一个操作', () => {
      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());

      expect(actionId).toBeDefined();
      expect(service.queueSize()).toBe(1);
      expect(service.hasPendingActions()).toBe(true);
    });

    it('应该能够出队一个操作', () => {
      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());

      service.dequeue(actionId);

      expect(service.queueSize()).toBe(0);
      expect(service.hasPendingActions()).toBe(false);
    });

    it('达到软上限后应继续接收写入（避免离线丢写）', () => {
      setNetworkStatus(false);
      const actionCount = LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE + 50;
      for (let i = 0; i < actionCount; i += 1) {
        service.enqueue({
          type: 'update',
          entityType: 'task',
          entityId: `task-${i}`,
          payload: { task: createMockTaskForQueue(i), projectId: 'proj-1' },
        });
      }

      expect(service.queueSize()).toBe(actionCount);
      expect(mockToastService.warning).toHaveBeenCalled();
    });

    it('队列冻结时同步 enqueue 应拒绝新写入，避免产生仅内存待同步项', () => {
      setNetworkStatus(false);
      const control = service.storage as unknown as {
        freezeQueueWrites(reason: string): void;
      };

      control.freezeQueueWrites('storage_failure');
      const actionId = service.enqueue(createTestProjectAction());

      expect(actionId).toBe('');
      expect(service.queueSize()).toBe(0);
      expect(service.hasPendingActions()).toBe(false);
      expect(mockToastService.warning).toHaveBeenCalledWith(
        '同步队列已暂停',
        '当前浏览器存储不可用，本次操作未写入本地队列。请先导出或释放存储空间。',
      );
    });

    it('应该能够清空队列', () => {
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      service.enqueue(createTestProjectAction());

      service.clearQueue();

      expect(service.queueSize()).toBe(0);
    });

    it('项目冲突收口应只失效对应 project mutation 视图，不影响全局队列视图', () => {
      setNetworkStatus(false);
      const beforeQueueGeneration = service.getCurrentQueueViewGeneration();
      const beforeProjectGeneration = service.getProjectMutationViewGeneration('proj-stale', 'test-user');

      const nextProjectGeneration = service.invalidateProjectMutationView('proj-stale', 'test-user');

      expect(nextProjectGeneration).toBe(beforeProjectGeneration + 1);
      expect(service.getProjectMutationViewGeneration('proj-stale', 'test-user')).toBe(nextProjectGeneration);
      expect(service.getCurrentQueueViewGeneration()).toBe(beforeQueueGeneration);
    });

    it('切账号时清空当前视图不应覆盖已持久化的队列和死信', () => {
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      const queuedAction = service.pendingActions()[0];
      service.moveToDeadLetter(queuedAction, 'test dead letter');

      const queueStorageKey = 'nanoflow.action-queue.test-user';
      const deadLetterStorageKey = 'nanoflow.dead-letter-queue.test-user';

      expect(localStorage.getItem(queueStorageKey)).toBe('[]');
      expect(localStorage.getItem(deadLetterStorageKey)).toContain('test dead letter');

      service.clearCurrentView();

      expect(service.queueSize()).toBe(0);
      expect(service.deadLetterSize()).toBe(0);
      expect(localStorage.getItem(queueStorageKey)).toBe('[]');
      expect(localStorage.getItem(deadLetterStorageKey)).toContain('test dead letter');
    });

    it('project update 合并时应保留 sourceUserId、删除 CAS 并以最后一次 taskIdsToDelete 为准', () => {
      setNetworkStatus(false);
      const projectId = 'proj-merge-delete-intent';

      service.enqueue({
        type: 'update',
        entityType: 'project',
        entityId: projectId,
        payload: {
          project: createMockProject({ id: projectId, name: 'Before Merge' }),
          sourceUserId: 'owner-a',
          taskIdsToDelete: ['task-delete-a'],
          taskDeleteBaseUpdatedAtMap: {
            'task-delete-a': '2026-06-09T01:00:00.000Z',
          },
        },
      });

      service.enqueue({
        type: 'update',
        entityType: 'project',
        entityId: projectId,
        payload: {
          project: createMockProject({ id: projectId, name: 'After Merge' }),
          taskIdsToDelete: ['task-delete-b'],
          taskDeleteBaseUpdatedAtMap: {
            'task-delete-b': '2026-06-09T02:00:00.000Z',
          },
        },
      });

      expect(service.queueSize()).toBe(1);
      expect(service.pendingActions()[0]).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            sourceUserId: 'owner-a',
            project: expect.objectContaining({ id: projectId, name: 'After Merge' }),
            taskIdsToDelete: ['task-delete-b'],
            taskDeleteBaseUpdatedAtMap: {
              'task-delete-b': '2026-06-09T02:00:00.000Z',
            },
          }),
        }),
      );
    });

    it('project update 合并后续非删除 payload 时应保留已有删除 CAS 意图', () => {
      setNetworkStatus(false);
      const projectId = 'proj-merge-preserve-delete-cas';

      service.enqueue({
        type: 'update',
        entityType: 'project',
        entityId: projectId,
        payload: {
          project: createMockProject({ id: projectId, name: 'Before Non-delete Merge' }),
          sourceUserId: 'owner-a',
          taskIdsToDelete: ['task-delete-a'],
          taskDeleteBaseUpdatedAtMap: {
            'task-delete-a': '2026-06-09T01:00:00.000Z',
          },
        },
      });

      service.enqueue({
        type: 'update',
        entityType: 'project',
        entityId: projectId,
        payload: {
          project: createMockProject({ id: projectId, name: 'After Non-delete Merge' }),
        },
      });

      expect(service.queueSize()).toBe(1);
      expect(service.pendingActions()[0]).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            sourceUserId: 'owner-a',
            project: expect.objectContaining({ id: projectId, name: 'After Non-delete Merge' }),
            taskIdsToDelete: ['task-delete-a'],
            taskDeleteBaseUpdatedAtMap: {
              'task-delete-a': '2026-06-09T01:00:00.000Z',
            },
          }),
        }),
      );
    });

    it('foreign-owner project handoff 应复用同一 project 的合并语义并保留删除 CAS', async () => {
      const projectId = 'proj-foreign-owner-merge';

      await service.enqueueDurablyForOwner('owner-b', {
        type: 'update',
        entityType: 'project',
        entityId: projectId,
        payload: {
          project: createMockProject({ id: projectId, name: 'Before Foreign Merge' }),
          sourceUserId: 'owner-b',
          taskIdsToDelete: ['task-delete-a'],
          taskDeleteBaseUpdatedAtMap: {
            'task-delete-a': '2026-06-09T01:00:00.000Z',
          },
        },
      });

      await service.enqueueDurablyForOwner('owner-b', {
        type: 'update',
        entityType: 'project',
        entityId: projectId,
        payload: {
          project: createMockProject({ id: projectId, name: 'After Foreign Merge' }),
          sourceUserId: 'owner-b',
          taskIdsToDelete: ['task-delete-b'],
          taskDeleteBaseUpdatedAtMap: {
            'task-delete-b': '2026-06-09T02:00:00.000Z',
          },
        },
      });

      const ownerQueue = await service.storage.loadQueueSnapshotForOwner('owner-b');

      expect(ownerQueue).toHaveLength(1);
      expect(ownerQueue[0]).toEqual(
        expect.objectContaining({
          entityType: 'project',
          entityId: projectId,
          payload: expect.objectContaining({
            sourceUserId: 'owner-b',
            project: expect.objectContaining({ id: projectId, name: 'After Foreign Merge' }),
            taskIdsToDelete: ['task-delete-b'],
            taskDeleteBaseUpdatedAtMap: {
              'task-delete-b': '2026-06-09T02:00:00.000Z',
            },
          }),
        }),
      );
    });

    it('foreign-owner durable 入队重放相同 operationId 时不应重复创建 action', async () => {
      const projectId = 'proj-foreign-owner-idempotent-create';
      const operationId = '00000000-0000-4000-8000-000000000101';
      const action: EnqueueParams = {
        operationId,
        type: 'create',
        entityType: 'project',
        entityId: projectId,
        payload: {
          project: createMockProject({ id: projectId, name: 'Idempotent Create' }),
          sourceUserId: 'owner-b',
        },
      };

      const firstActionId = await service.enqueueDurablyForOwner('owner-b', action);
      const secondActionId = await service.enqueueDurablyForOwner('owner-b', action);

      const ownerQueue = await service.storage.loadQueueSnapshotForOwner('owner-b');

      expect(secondActionId).toBe(firstActionId);
      expect(ownerQueue).toHaveLength(1);
      expect(ownerQueue[0]).toEqual(expect.objectContaining({
        id: firstActionId,
        operationId,
        type: 'create',
        entityType: 'project',
        entityId: projectId,
      }));
    });

    it('legacy enqueueForOwner 也应复用 foreign-owner 合并语义和原 operationId', async () => {
      const projectId = 'proj-foreign-owner-legacy-merge';

      const firstActionId = await service.enqueueForOwner('owner-b', {
        type: 'update',
        entityType: 'project',
        entityId: projectId,
        payload: {
          project: createMockProject({ id: projectId, name: 'Legacy First' }),
          sourceUserId: 'owner-b',
          taskIdsToDelete: ['task-delete-a'],
          taskDeleteBaseUpdatedAtMap: {
            'task-delete-a': '2026-06-09T01:00:00.000Z',
          },
        },
      });
      const firstQueue = await service.storage.loadQueueSnapshotForOwner('owner-b');
      const firstOperationId = firstQueue[0].operationId;

      const secondActionId = await service.enqueueForOwner('owner-b', {
        type: 'update',
        entityType: 'project',
        entityId: projectId,
        payload: {
          project: createMockProject({ id: projectId, name: 'Legacy Second' }),
          sourceUserId: 'owner-b',
          taskIdsToDelete: ['task-delete-b'],
          taskDeleteBaseUpdatedAtMap: {
            'task-delete-b': '2026-06-09T02:00:00.000Z',
          },
        },
      });

      const ownerQueue = await service.storage.loadQueueSnapshotForOwner('owner-b');

      expect(secondActionId).toBe(firstActionId);
      expect(ownerQueue).toHaveLength(1);
      expect(ownerQueue[0].operationId).toBe(firstOperationId);
      expect(ownerQueue[0]).toEqual(
        expect.objectContaining({
          entityType: 'project',
          entityId: projectId,
          payload: expect.objectContaining({
            sourceUserId: 'owner-b',
            project: expect.objectContaining({ id: projectId, name: 'Legacy Second' }),
            taskIdsToDelete: ['task-delete-b'],
            taskDeleteBaseUpdatedAtMap: {
              'task-delete-b': '2026-06-09T02:00:00.000Z',
            },
          }),
        }),
      );
    });
  });
}

function createMockTaskForQueue(index: number): Task {
  return {
    id: `task-${index}`,
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 500,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
  };
}
