import { beforeEach, expect, it, vi } from 'vitest';

import type { SimpleSyncService } from './simple-sync.service';
import {
  createMockProject,
  createMockTask,
  expectDeferredCallback,
} from './simple-sync.test-harness';

export interface SimpleSyncBatchRetryHandoffSpecContext {
  service(): SimpleSyncService;
  mockBatchSync(): any;
  mockChangeTracker(): any;
  mockRetryQueueService(): any;
}

export function registerSimpleSyncBatchRetryHandoffSpecs(
  context: SimpleSyncBatchRetryHandoffSpecContext,
): void {
  let service: SimpleSyncService;
  let mockBatchSync: any;
  let mockChangeTracker: any;
  let mockRetryQueueService: any;

  beforeEach(() => {
    service = context.service();
    mockBatchSync = context.mockBatchSync();
    mockChangeTracker = context.mockChangeTracker();
    mockRetryQueueService = context.mockRetryQueueService();
  });

    it('saveProjectToCloud 在项目级重试已接管时应将最新折叠快照刷新到 RetryQueue', async () => {
      const firstProject = createMockProject({
        id: 'project-failure-collapse',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const queuedProject = createMockProject({
        id: 'project-failure-collapse',
        updatedAt: '2026-04-11T08:00:02.000Z',
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      const failedResult = {
        success: false,
        failureReason: 'project sync deferred by network awareness',
        retryEnqueued: ['project:project-failure-collapse'],
        failedTaskIds: [],
        failedConnectionIds: [],
        projectPushed: false,
      };
      let resolveFirstSave: ((value: typeof failedResult) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstSave = resolve;
      }));
      mockChangeTracker.getProjectChanges.mockReturnValueOnce({
        projectId: 'project-failure-collapse',
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: ['task-delete-newest'],
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: true,
        totalChanges: 1,
        taskUpdateFieldsById: {},
      });

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const queuedPromise = service.saveProjectToCloud(queuedProject, 'test-user-id');

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')(failedResult);

      const [firstResult, queuedResult] = await Promise.all([firstPromise, queuedPromise]);

      expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(1);
      expect(mockRetryQueueService.add).toHaveBeenCalledWith(
        'project',
        'upsert',
        queuedProject,
        undefined,
        'test-user-id',
        ['task-delete-newest'],
        undefined,
        undefined,
        undefined,
      );
      expect(firstResult).toEqual(failedResult);
      expect(queuedResult).toEqual(failedResult);
    });

    it('saveProjectToCloud 在最新折叠快照未 durably 刷新到 RetryQueue 时不应复用旧 project retry marker', async () => {
      const firstProject = createMockProject({
        id: 'project-refresh-persistence-guard',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const queuedProject = createMockProject({
        id: 'project-refresh-persistence-guard',
        updatedAt: '2026-04-11T08:00:02.000Z',
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      const failedResult = {
        success: false,
        failureReason: 'project sync deferred by network awareness',
        retryEnqueued: ['project:project-refresh-persistence-guard'],
        failedTaskIds: [],
        failedConnectionIds: [],
        projectPushed: false,
      };
      const queuedSuccess = {
        success: true,
        newVersion: 12,
      };
      let resolveFirstSave: ((value: typeof failedResult) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFirstSave = resolve;
        }))
        .mockResolvedValueOnce(queuedSuccess);
      mockRetryQueueService.persistNow.mockResolvedValueOnce(false);
      mockChangeTracker.getProjectChanges.mockReturnValueOnce({
        projectId: 'project-refresh-persistence-guard',
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: ['task-delete-newest'],
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: true,
        totalChanges: 1,
        taskUpdateFieldsById: {},
      });

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const queuedPromise = service.saveProjectToCloud(queuedProject, 'test-user-id');

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')(failedResult);

      const [firstResult, queuedResult] = await Promise.all([firstPromise, queuedPromise]);

      expect(mockRetryQueueService.add).toHaveBeenCalledWith(
        'project',
        'upsert',
        queuedProject,
        undefined,
        'test-user-id',
        ['task-delete-newest'],
        undefined,
        undefined,
        undefined,
      );
      expect(mockRetryQueueService.persistNow).toHaveBeenCalled();
      expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(2);
      expect(firstResult).toEqual(failedResult);
      expect(queuedResult).toEqual(queuedSuccess);
    });

    it('saveProjectToCloud 在折叠重试刷新时应保留显式 taskIdsToDelete payload', async () => {
      const firstProject = createMockProject({
        id: 'project-explicit-delete-payload',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const queuedProject = createMockProject({
        id: 'project-explicit-delete-payload',
        updatedAt: '2026-04-11T08:00:02.000Z',
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      const failedResult = {
        success: false,
        failureReason: 'project sync deferred by network awareness',
        retryEnqueued: ['project:project-explicit-delete-payload'],
        failedTaskIds: [],
        failedConnectionIds: [],
        projectPushed: false,
      };
      let resolveFirstSave: ((value: typeof failedResult) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstSave = resolve;
      }));
      mockChangeTracker.getProjectChanges.mockReturnValueOnce({
        projectId: 'project-explicit-delete-payload',
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: [],
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: false,
        totalChanges: 0,
        taskUpdateFieldsById: {},
      });

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id', ['task-delete-original']);
      const queuedPromise = service.saveProjectToCloud(queuedProject, 'test-user-id', ['task-delete-explicit']);

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')(failedResult);

      const [firstResult, queuedResult] = await Promise.all([firstPromise, queuedPromise]);

      expect(mockRetryQueueService.add).toHaveBeenCalledWith(
        'project',
        'upsert',
        queuedProject,
        undefined,
        'test-user-id',
        ['task-delete-explicit'],
        undefined,
        undefined,
        undefined,
      );
      expect(firstResult).toEqual(failedResult);
      expect(queuedResult).toEqual(failedResult);
    });

    it('saveProjectToCloud 在折叠重试刷新时不应因 ChangeTracker 清空而丢失已捕获的 taskIdsToDelete payload', async () => {
      const firstProject = createMockProject({
        id: 'project-preserve-captured-delete-payload',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const queuedProject = createMockProject({
        id: 'project-preserve-captured-delete-payload',
        updatedAt: '2026-04-11T08:00:02.000Z',
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      const failedResult = {
        success: false,
        failureReason: 'project sync deferred by network awareness',
        retryEnqueued: ['project:project-preserve-captured-delete-payload'],
        failedTaskIds: [],
        failedConnectionIds: [],
        projectPushed: false,
      };
      let resolveFirstSave: ((value: typeof failedResult) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstSave = resolve;
      }));
      mockChangeTracker.getProjectChanges
        .mockReturnValueOnce({
          projectId: 'project-preserve-captured-delete-payload',
          tasksToCreate: [],
          tasksToUpdate: [],
          taskIdsToDelete: ['task-delete-captured'],
          connectionsToCreate: [],
          connectionsToUpdate: [],
          connectionsToDelete: [],
          hasChanges: true,
          totalChanges: 1,
          taskUpdateFieldsById: {},
        })
        .mockReturnValueOnce({
          projectId: 'project-preserve-captured-delete-payload',
          tasksToCreate: [],
          tasksToUpdate: [],
          taskIdsToDelete: [],
          connectionsToCreate: [],
          connectionsToUpdate: [],
          connectionsToDelete: [],
          hasChanges: false,
          totalChanges: 0,
          taskUpdateFieldsById: {},
        });

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const queuedPromise = service.saveProjectToCloud(queuedProject, 'test-user-id');

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')(failedResult);

      const [firstResult, queuedResult] = await Promise.all([firstPromise, queuedPromise]);

      expect(mockRetryQueueService.add).toHaveBeenCalledWith(
        'project',
        'upsert',
        queuedProject,
        undefined,
        'test-user-id',
        ['task-delete-captured'],
        undefined,
        undefined,
        undefined,
      );
      expect(firstResult).toEqual(failedResult);
      expect(queuedResult).toEqual(failedResult);
    });

    it('saveProjectToCloud 在多次折叠后应保留最后一次请求的 taskIdsToDelete payload', async () => {
      const firstProject = createMockProject({
        id: 'project-folded-delete-payload',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const secondProject = createMockProject({
        id: 'project-folded-delete-payload',
        updatedAt: '2026-04-11T08:00:01.000Z',
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:01.000Z' })],
        connections: [],
      });
      const thirdProject = createMockProject({
        id: 'project-folded-delete-payload',
        updatedAt: '2026-04-11T08:00:02.000Z',
        tasks: [createMockTask({ id: 'task-3', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      const failedResult = {
        success: false,
        failureReason: 'project sync deferred by network awareness',
        retryEnqueued: ['project:project-folded-delete-payload'],
        failedTaskIds: [],
        failedConnectionIds: [],
        projectPushed: false,
      };
      let resolveFirstSave: ((value: typeof failedResult) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstSave = resolve;
      }));

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id', ['task-delete-a']);
      const secondPromise = service.saveProjectToCloud(secondProject, 'test-user-id', ['task-delete-b']);
      const thirdPromise = service.saveProjectToCloud(thirdProject, 'test-user-id', ['task-delete-c']);

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')(failedResult);

      const [firstResult, secondResult, thirdResult] = await Promise.all([firstPromise, secondPromise, thirdPromise]);

      expect(mockRetryQueueService.addDurably).toHaveBeenCalledWith(
        'project',
        'upsert',
        thirdProject,
        undefined,
        'test-user-id',
        ['task-delete-c'],
        undefined,
        undefined,
        undefined,
      );
      expect(firstResult).toEqual(failedResult);
      expect(secondResult).toEqual(failedResult);
      expect(thirdResult).toEqual(failedResult);
    });

    it('saveProjectToCloud 在 sessionExpired 的项目级 handoff 下仍应保留最新折叠快照', async () => {
      service['syncStateService'].update({ sessionExpired: true });

      const firstProject = createMockProject({
        id: 'project-session-expired-collapse',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const queuedProject = createMockProject({
        id: 'project-session-expired-collapse',
        updatedAt: '2026-04-11T08:00:02.000Z',
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      const failedResult = {
        success: false,
        failureReason: 'project sync session expired',
        retryEnqueued: ['project:project-session-expired-collapse'],
        failedTaskIds: [],
        failedConnectionIds: [],
        projectPushed: false,
      };
      let resolveFirstSave: ((value: typeof failedResult) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstSave = resolve;
      }));
      mockChangeTracker.getProjectChanges.mockReturnValueOnce({
        projectId: 'project-session-expired-collapse',
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: ['task-delete-after-expiry'],
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: true,
        totalChanges: 1,
        taskUpdateFieldsById: {},
      });

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const queuedPromise = service.saveProjectToCloud(queuedProject, 'test-user-id');

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')(failedResult);

      const [firstResult, queuedResult] = await Promise.all([firstPromise, queuedPromise]);

      expect(mockRetryQueueService.queue.at(-1)).toEqual(expect.objectContaining({
        type: 'project',
        data: queuedProject,
        taskIdsToDelete: ['task-delete-after-expiry'],
      }));
      expect(firstResult).toEqual(failedResult);
      expect(queuedResult).toEqual(failedResult);
    });
}
