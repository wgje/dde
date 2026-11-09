import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '../models';
import type { ActionQueueService } from './action-queue.service';
import { mockQueueBackupService } from './action-queue-service-test-harness.spec-helpers';

interface ActionQueueDependentPauseSpecContext {
  service(): ActionQueueService;
  setNetworkStatus(online: boolean): void;
  createMockTask(overrides?: Partial<Task>): Task;
  createMockProject(overrides?: Partial<Project>): Project;
}

export function registerActionQueueDependentPauseSpecs(
  context: ActionQueueDependentPauseSpecContext,
): void {
  let service: ActionQueueService;
  const {
    setNetworkStatus,
    createMockTask,
    createMockProject,
  } = context;

  beforeEach(() => {
    service = context.service();
  });

  describe('依赖操作暂停 (pauseDependentActions)', () => {
    it('Create 失败后应暂停同一实体的 Update 操作', async () => {
      const createProcessor = vi.fn().mockRejectedValue(new Error('Create failed'));
      const updateProcessor = vi.fn().mockResolvedValue(true);

      service.registerProcessor('task:create', createProcessor);
      service.registerProcessor('task:update', updateProcessor);

      setNetworkStatus(false);

      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: createMockTask({ id: 'task-1', title: 'New Task' }), projectId: 'proj-1' },
      });
      const createAction = service.pendingActions()[0];
      if (!createAction) throw new Error('queued create action is required');
      const dependentAction = {
        ...createAction,
        id: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        type: 'update' as const,
        payload: { task: createMockTask({ id: 'task-1', title: 'Updated Task' }), projectId: 'proj-1' },
        timestamp: createAction.timestamp + 1,
        localCommittedAt: (createAction.localCommittedAt ?? createAction.timestamp) + 1,
      };
      service.pendingActions.set([createAction, dependentAction]);
      service.queueSize.set(2);
      await service.storage.persistQueueSnapshotForOwner('test-user', [createAction, dependentAction]);

      setNetworkStatus(true);

      await service.processQueue();

      expect(createProcessor).toHaveBeenCalled();
      expect(updateProcessor).not.toHaveBeenCalled();
      expect(mockQueueBackupService.updateQueueStrictly).toHaveBeenCalledTimes(2);
      expect(mockQueueBackupService.updateQueue).not.toHaveBeenCalled();
      expect(await service.storage.loadQueueSnapshotForOwner('test-user')).toContainEqual(dependentAction);
    });

    it('Create 失败不应影响其他实体的操作', async () => {
      const createProcessor = vi.fn().mockRejectedValue(new Error('Create failed'));
      const updateProcessor = vi.fn().mockResolvedValue(true);

      service.registerProcessor('task:create', createProcessor);
      service.registerProcessor('task:update', updateProcessor);

      setNetworkStatus(false);

      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: createMockTask({ id: 'task-1', title: 'Task 1' }), projectId: 'proj-1' },
      });

      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-2',
        payload: { task: createMockTask({ id: 'task-2', title: 'Task 2 Updated' }), projectId: 'proj-1' },
      });

      setNetworkStatus(true);

      await service.processQueue();

      expect(updateProcessor).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'task-2' }),
        expect.objectContaining({ leaseSignal: expect.any(AbortSignal) }),
      );
    });

    it('不同实体类型的操作互不影响', async () => {
      const taskCreateProcessor = vi.fn().mockRejectedValue(new Error('Create failed'));
      const projectUpdateProcessor = vi.fn().mockResolvedValue(true);

      service.registerProcessor('task:create', taskCreateProcessor);
      service.registerProcessor('project:update', projectUpdateProcessor);

      setNetworkStatus(false);

      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: createMockTask({ id: 'task-1', title: 'Task 1' }), projectId: 'proj-1' },
      });

      service.enqueue({
        type: 'update',
        entityType: 'project',
        entityId: 'proj-1',
        payload: { project: createMockProject({ id: 'proj-1', name: 'Updated' }) },
      });

      setNetworkStatus(true);

      await service.processQueue();

      expect(projectUpdateProcessor).toHaveBeenCalled();
    });
  });
}
