import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../models';
import type { ActionQueueService, EnqueueParams, TaskPayload } from './action-queue.service';

export interface ActionQueueOutboxStateSpecContext {
  service: () => ActionQueueService;
  setNetworkStatus: (online: boolean) => void;
  createTestTaskAction: () => EnqueueParams;
  createMockTask: (overrides?: Partial<Task>) => Task;
}

export function registerActionQueueOutboxStateSpecs(context: ActionQueueOutboxStateSpecContext): void {
  describe('Outbox operationId', () => {
    it('缺少 crypto.randomUUID 时应使用 Web Crypto fallback 继续生成本地 id 和 operationId', () => {
      const originalCrypto = globalThis.crypto;
      const task = context.createMockTask({ id: 'task-web-crypto-fallback' });
      const action: EnqueueParams = {
        type: 'update',
        entityType: 'task',
        entityId: task.id,
        payload: { task, projectId: 'proj-1' },
      };
      let callCount = 0;
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: {
          getRandomValues: (array: Uint8Array) => {
            callCount += 1;
            array.fill(callCount);
            return array;
          },
        },
      });

      try {
        const service = context.service();
        context.setNetworkStatus(false);
        const actionId = service.enqueue(action);
        const [queued] = service.pendingActions();

        expect(actionId).toBe(queued.id);
        expect(queued.id).toBe('01010101-0101-4101-8101-010101010101');
        expect(queued.operationId).toBe('02020202-0202-4202-8202-020202020202');
        expect(queued.operationId).not.toBe(queued.id);
      } finally {
        Object.defineProperty(globalThis, 'crypto', {
          configurable: true,
          value: originalCrypto,
        });
      }
    });

    it('新入队操作应同时拥有本地 id 和远端 operationId', () => {
      const service = context.service();
      context.setNetworkStatus(false);
      const actionId = service.enqueue(context.createTestTaskAction());
      const [queued] = service.pendingActions();

      expect(actionId).toBe(queued.id);
      expect(queued.id).toEqual(expect.any(String));
      expect(queued.operationId).toEqual(expect.any(String));
      expect(queued.operationId).not.toBe(queued.id);
      expect(queued.syncState).toBe('pending_sync');
      expect(queued.localCommittedAt).toEqual(expect.any(Number));
    });

    it('连续 update 合并时应保留原 operationId 作为幂等键', () => {
      const service = context.service();
      context.setNetworkStatus(false);
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-op-merge',
        payload: { task: context.createMockTask({ id: 'task-op-merge', title: 'first' }), projectId: 'proj-1' },
      });
      const original = service.pendingActions()[0];

      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-op-merge',
        payload: { task: context.createMockTask({ id: 'task-op-merge', title: 'second' }), projectId: 'proj-1' },
      });

      const [merged] = service.pendingActions();
      expect(merged.id).toBe(original.id);
      expect(merged.operationId).toBe(original.operationId);
      expect((merged.payload as TaskPayload).task.title).toBe('second');
    });

    it('同一实体 update 后 delete 应合并为最终删除意图并保留原幂等键', () => {
      const service = context.service();
      context.setNetworkStatus(false);
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-update-delete-merge',
        payload: {
          task: context.createMockTask({ id: 'task-update-delete-merge', title: 'will be deleted' }),
          projectId: 'proj-1',
          sourceUserId: 'user-1',
        },
      });
      const original = service.pendingActions()[0];

      service.enqueue({
        type: 'delete',
        entityType: 'task',
        entityId: 'task-update-delete-merge',
        payload: {
          taskId: 'task-update-delete-merge',
          projectId: 'proj-1',
          sourceUserId: 'user-1',
          baseUpdatedAt: '2026-06-15T01:00:00.000Z',
        },
      });

      const [merged] = service.pendingActions();
      expect(service.queueSize()).toBe(1);
      expect(merged.id).toBe(original.id);
      expect(merged.operationId).toBe(original.operationId);
      expect(merged.type).toBe('delete');
      expect(merged.payload).toEqual(expect.objectContaining({
        taskId: 'task-update-delete-merge',
        baseUpdatedAt: '2026-06-15T01:00:00.000Z',
      }));
    });

    it('相同 operationId 的重复 create 入队应复用已有 Outbox 动作', () => {
      const service = context.service();
      context.setNetworkStatus(false);
      const task = context.createMockTask({
        id: 'task-idempotent-create',
        title: 'first create',
      });
      const operationId = 'op-idempotent-create-task';

      const firstActionId = service.enqueue({
        operationId,
        type: 'create',
        entityType: 'task',
        entityId: task.id,
        payload: { task, projectId: 'proj-1' },
      });
      const secondActionId = service.enqueue({
        operationId,
        type: 'create',
        entityType: 'task',
        entityId: task.id,
        payload: {
          task: context.createMockTask({
            id: task.id,
            title: 'duplicate create should be ignored',
          }),
          projectId: 'proj-1',
        },
      });

      expect(secondActionId).toBe(firstActionId);
      expect(service.queueSize()).toBe(1);
      expect(service.pendingActions()[0]).toEqual(expect.objectContaining({
        id: firstActionId,
        operationId,
        type: 'create',
      }));
      expect((service.pendingActions()[0].payload as TaskPayload).task.title).toBe('first create');
    });

    it('从持久化恢复队列时应保留 operationId', () => {
      const service = context.service();
      context.setNetworkStatus(false);
      service.enqueue(context.createTestTaskAction());
      const originalOperationId = service.pendingActions()[0].operationId;

      service.clearCurrentView();
      service.reloadFromStorageForCurrentOwner();

      expect(service.pendingActions()[0].operationId).toBe(originalOperationId);
    });
  });

  describe('Outbox syncState', () => {
    it('处理中的操作应持久化标记为 syncing', async () => {
      const service = context.service();
      let resolveStarted = () => {};
      let resolveProcessor = () => {};
      const processorStarted = new Promise<void>(resolve => {
        resolveStarted = resolve;
      });
      const processorGate = new Promise<void>(resolve => {
        resolveProcessor = resolve;
      });
      const processor = vi.fn(async () => {
        resolveStarted();
        await processorGate;
        return true;
      });

      service.registerProcessor('task:update', processor);
      context.setNetworkStatus(false);
      service.enqueue(context.createTestTaskAction());

      context.setNetworkStatus(true);
      const processPromise = service.processQueue();
      await processorStarted;

      expect(service.pendingActions()[0].syncState).toBe('syncing');
      const saved = JSON.parse(localStorage.getItem('nanoflow.action-queue.test-user') ?? '[]') as Array<{ syncState?: string }>;
      expect(saved[0]?.syncState).toBe('syncing');

      resolveProcessor();
      await processPromise;

      expect(service.pendingActions()).toEqual([]);
    });
  });

  describe('项目删除收口', () => {
    it('当前 owner 项目删除成功后应同时清理 task 与 connection 待同步项', async () => {
      const service = context.service();
      context.setNetworkStatus(false);
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-project-delete',
        payload: { task: context.createMockTask({ id: 'task-project-delete' }), projectId: 'project-delete' },
      });
      service.enqueue({
        type: 'update',
        entityType: 'connection',
        entityId: 'connection-project-delete',
        payload: {
          connection: { id: 'connection-project-delete', source: 'task-a', target: 'task-b' },
          projectId: 'project-delete',
        },
      });
      service.enqueue({
        type: 'update',
        entityType: 'connection',
        entityId: 'connection-keep',
        payload: {
          connection: { id: 'connection-keep', source: 'task-a', target: 'task-c' },
          projectId: 'project-keep',
        },
      });

      const removed = await service.settleProjectDeleteSuccessForOwner('test-user', 'project-delete');

      expect(removed).toBe(2);
      expect(service.pendingActions().map(action => action.entityId)).toEqual(['connection-keep']);
    });
  });
}
