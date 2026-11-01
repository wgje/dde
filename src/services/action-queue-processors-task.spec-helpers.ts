import { describe, expect, it } from 'vitest';

import { PermanentFailureError } from '../utils/permanent-failure-error';
import {
  getProcessor,
  mockActionQueueService,
  mockConflictStorageService,
  mockProjectStateService,
  mockRetryQueueService,
  mockSyncService,
  type QueuedAction,
} from './action-queue-processors.spec-helpers';

export function registerActionQueueProcessorsTaskSpecs(): void {
  describe('task processors', () => {
    it('task:create should call pushTask', async () => {
      const handler = getProcessor('task:create');
      const task = { id: 't-1', title: 'Task' };

      const result = await handler({
        operationId: 'op-task-create',
        payload: { task, projectId: 'p-1', sourceUserId: 'test-user' },
      });

      expect(mockSyncService.pushTask).toHaveBeenCalledWith(
        task,
        'p-1',
        false,
        false,
        'test-user',
        true,
        undefined,
        'op-task-create',
      );
      expect(result).toBe(true);
    });

    it('task:update should call pushTask with sourceUserId and explicit full intent', async () => {
      const handler = getProcessor('task:update');
      const task = { id: 't-2', title: 'Task update' };

      const result = await handler({
        operationId: 'op-task-update',
        payload: {
          task,
          projectId: 'p-2',
          sourceUserId: 'test-user',
          writeIntent: 'task_full_upsert',
        },
      } as QueuedAction);

      expect(mockSyncService.pushTask).toHaveBeenCalledWith(
        task,
        'p-2',
        false,
        false,
        'test-user',
        true,
        'task_full_upsert',
        'op-task-update',
      );
      expect(result).toBe(true);
    });

    it('task:update should quarantine a legacy full snapshot without writeIntent', async () => {
      const handler = getProcessor('task:update');
      const action = {
        id: 'action-missing-task-intent',
        operationId: 'op-missing-task-intent',
        entityType: 'task',
        entityId: 'task-missing-intent',
        payload: {
          task: { id: 'task-missing-intent', stage: null },
          projectId: 'project-1',
          sourceUserId: 'test-user',
        },
      } as QueuedAction;

      const result = await handler(action);

      expect(result).toBe(true);
      expect(mockSyncService.pushTask).not.toHaveBeenCalled();
      expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalledWith(
        action,
        expect.stringContaining('writeIntent'),
      );
    });

    it('task:update should pass queued writeIntent into pushTask', async () => {
      const handler = getProcessor('task:update');
      const task = { id: 't-write-intent', title: 'Task update' };

      const result = await handler({
        operationId: 'op-task-write-intent',
        payload: {
          task,
          projectId: 'p-write-intent',
          sourceUserId: 'test-user',
          writeIntent: 'task_text_update',
        },
      } as QueuedAction);

      expect(mockSyncService.pushTask).toHaveBeenCalledWith(
        task,
        'p-write-intent',
        false,
        false,
        'test-user',
        true,
        'task_text_update',
        'op-task-write-intent',
      );
      expect(result).toBe(true);
    });

    it('task:update should discard stale upserts when remote tombstone already exists', async () => {
      mockSyncService.pushTask.mockRejectedValueOnce(
        new PermanentFailureError(
          'Task tombstone prevented remote upsert',
          undefined,
          { operation: 'pushTaskTombstone', taskId: 'task-tombstoned', projectId: 'project-1' },
        ),
      );
      const handler = getProcessor('task:update');

      const result = await handler({
        payload: {
          task: { id: 'task-tombstoned' },
          projectId: 'project-1',
          sourceUserId: 'test-user',
          writeIntent: 'task_full_upsert',
        },
      } as QueuedAction);

      expect(result).toBe(true);
      expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
      expect(mockActionQueueService.markActionResolvedWithoutRemote).toHaveBeenCalledOnce();
    });

    it('task:update should persist remote-newer conflicts before resolving the ActionQueue item locally', async () => {
      const localTask = {
        id: 'task-remote-newer',
        title: 'Local task title',
        content: 'Current local content',
        stage: null,
        parentId: null,
        order: 0,
        rank: 0,
        status: 'active' as const,
        x: 0,
        y: 0,
        createdDate: '2026-06-25T00:00:00.000Z',
        updatedAt: '2026-06-25T00:00:00.000Z',
        displayId: 'T1',
      };
      const concurrentTask = {
        ...localTask,
        id: 'task-concurrent',
        title: 'Concurrent task',
        content: 'Content only present in TaskStore',
        order: 1,
        rank: 1,
        displayId: 'T2',
      };
      const currentConnection = {
        id: 'connection-current',
        source: localTask.id,
        target: concurrentTask.id,
      };
      const staleProjectShell = {
        id: 'project-1',
        name: 'Project',
        description: '',
        createdDate: '2026-06-25T00:00:00.000Z',
        tasks: [{ ...localTask, content: 'Stale shell content' }],
        connections: [],
      };
      const authoritativeProject = {
        ...staleProjectShell,
        tasks: [localTask, concurrentTask],
        connections: [currentConnection],
      };
      const remoteTask = {
        id: 'task-remote-newer',
        title: 'Remote task title',
        updatedAt: '2026-06-26T00:00:00.000Z',
      };
      const remoteNewerError = Object.assign(new Error('remote newer'), {
        name: 'VersionConflictError',
        code: 'TASK_REMOTE_NEWER',
        details: {
          remoteTask,
          remoteUpdatedAt: remoteTask.updatedAt,
        },
      });
      mockSyncService.pushTask.mockRejectedValueOnce(
        new PermanentFailureError(
          'Version conflict',
          remoteNewerError,
          { operation: 'pushTask', taskId: 'task-remote-newer', projectId: 'project-1' },
        ),
      );
      mockProjectStateService.getProject.mockReturnValueOnce(staleProjectShell);
      mockProjectStateService.getProjectWithCurrentData.mockReturnValueOnce(authoritativeProject);
      const handler = getProcessor('task:update');

      const result = await handler({
        id: 'action-remote-newer',
        operationId: 'op-task-remote-newer',
        payload: {
          task: localTask,
          projectId: 'project-1',
          sourceUserId: 'test-user',
          writeIntent: 'task_full_upsert',
        },
      } as QueuedAction);

      expect(result).toBe(true);
      expect(mockConflictStorageService.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'project-1',
        ownerUserId: 'test-user',
        reason: 'version_mismatch',
        localProject: expect.objectContaining({
          tasks: [localTask, concurrentTask],
          connections: [currentConnection],
        }),
        operationConflicts: [
          expect.objectContaining({
            actionId: 'action-remote-newer',
            actionType: 'task:update',
            entityType: 'task',
            entityId: 'task-remote-newer',
            operationId: 'op-task-remote-newer',
            code: 'TASK_REMOTE_NEWER',
            message: 'Version conflict',
            localEntity: expect.objectContaining({ title: 'Local task title' }),
            remoteEntity: expect.objectContaining({ title: 'Remote task title' }),
          }),
        ],
      }));
      expect(mockProjectStateService.getProjectWithCurrentData).toHaveBeenCalledWith('project-1');
      expect(mockActionQueueService.markActionResolvedWithoutRemote).toHaveBeenCalledWith('action-remote-newer');
      expect(mockActionQueueService.failRetry).not.toHaveBeenCalled();
    });

    it('task:update should complete ActionQueue item after matching RetryQueue handoff', async () => {
      const task = { id: 'task-handoff', title: 'Task update' };
      mockSyncService.pushTask.mockResolvedValueOnce(false);
      mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
        type: 'task',
        operation: 'upsert',
        data: task,
        projectId: 'project-1',
        sourceUserId: 'test-user',
        writeIntent: 'task_full_upsert',
      });
      const handler = getProcessor('task:update');

      const result = await handler({
        payload: {
          task,
          projectId: 'project-1',
          sourceUserId: 'test-user',
          writeIntent: 'task_full_upsert',
        },
      } as QueuedAction);

      expect(result).toBe(true);
      expect(mockRetryQueueService.findItemForOwner).toHaveBeenCalledWith('task', 'task-handoff', 'test-user');
      expect(mockActionQueueService.failRetry).not.toHaveBeenCalled();
    });

    it('task:update should not complete handoff when RetryQueue operationId differs', async () => {
      const task = { id: 'task-handoff-op-mismatch', title: 'Task update' };
      mockSyncService.pushTask.mockResolvedValueOnce(false);
      mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
        type: 'task',
        operation: 'upsert',
        data: task,
        projectId: 'project-1',
        sourceUserId: 'test-user',
        writeIntent: 'task_full_upsert',
        operationId: 'op-old-task-handoff',
      });
      const handler = getProcessor('task:update');

      const result = await handler({
        operationId: 'op-new-task-handoff',
        payload: {
          task,
          projectId: 'project-1',
          sourceUserId: 'test-user',
          writeIntent: 'task_full_upsert',
        },
      } as QueuedAction);

      expect(result).toEqual(expect.objectContaining({ outcome: 'failed' }));
      expect(mockActionQueueService.failRetry).toHaveBeenCalledWith(expect.objectContaining({
        code: 'SYNC_TASK_WRITE_FAILED',
        details: expect.objectContaining({
          taskId: 'task-handoff-op-mismatch',
          projectId: 'project-1',
        }),
      }));
    });

    it('task:update should not complete legacy handoff when RetryQueue has operationId', async () => {
      const task = { id: 'task-legacy-handoff-op', title: 'Task update' };
      mockSyncService.pushTask.mockResolvedValueOnce(false);
      mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
        type: 'task',
        operation: 'upsert',
        data: task,
        projectId: 'project-1',
        sourceUserId: 'test-user',
        writeIntent: 'task_full_upsert',
        operationId: 'retry-op-task-handoff',
      });
      const handler = getProcessor('task:update');

      const result = await handler({
        payload: {
          task,
          projectId: 'project-1',
          sourceUserId: 'test-user',
          writeIntent: 'task_full_upsert',
        },
      } as QueuedAction);

      expect(result).toEqual(expect.objectContaining({ outcome: 'failed' }));
      expect(mockActionQueueService.failRetry).toHaveBeenCalledWith(expect.objectContaining({
        code: 'SYNC_TASK_WRITE_FAILED',
        details: expect.objectContaining({
          taskId: 'task-legacy-handoff-op',
          projectId: 'project-1',
        }),
      }));
    });

    it('task:update should return structured failure when no RetryQueue handoff exists', async () => {
      mockSyncService.pushTask.mockResolvedValueOnce(false);
      const handler = getProcessor('task:update');

      const result = await handler({
        payload: {
          task: { id: 'task-no-handoff' },
          projectId: 'project-1',
          sourceUserId: 'test-user',
          writeIntent: 'task_full_upsert',
        },
      } as QueuedAction);

      expect(result).toEqual({
        outcome: 'failed',
        error: expect.objectContaining({
          code: 'SYNC_TASK_WRITE_FAILED',
          details: expect.objectContaining({
            reason: 'task-sync-failed',
            actionType: 'task:update',
            taskId: 'task-no-handoff',
            projectId: 'project-1',
          }),
        }),
      });
    });

    it('task:delete should call deleteTask with sourceUserId', async () => {
      const handler = getProcessor('task:delete');

      const result = await handler({
        operationId: 'op-task-delete',
        payload: { taskId: 't-1', projectId: 'p-1', sourceUserId: 'test-user' },
      } as QueuedAction);

      expect(mockSyncService.deleteTask).toHaveBeenCalledWith(
        't-1',
        'p-1',
        'test-user',
        false,
        undefined,
        'op-task-delete',
      );
      expect(result).toBe(true);
    });

    it('task:delete should pass baseUpdatedAt to deleteTask for CAS-protected replay', async () => {
      const handler = getProcessor('task:delete');

      const result = await handler({
        operationId: 'op-task-delete-cas',
        payload: {
          taskId: 't-delete-cas',
          projectId: 'p-1',
          sourceUserId: 'test-user',
          baseUpdatedAt: '2026-04-01T00:00:00.000Z',
        },
      } as QueuedAction);

      expect(mockSyncService.deleteTask).toHaveBeenCalledWith(
        't-delete-cas',
        'p-1',
        'test-user',
        false,
        '2026-04-01T00:00:00.000Z',
        'op-task-delete-cas',
      );
      expect(result).toBe(true);
    });

    it('task:delete should complete ActionQueue item after matching RetryQueue handoff', async () => {
      mockSyncService.deleteTask.mockResolvedValueOnce(false);
      mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
        type: 'task',
        operation: 'delete',
        data: { id: 'task-delete-handoff' },
        projectId: 'project-1',
        sourceUserId: 'test-user',
      });
      const handler = getProcessor('task:delete');

      const result = await handler({
        payload: { taskId: 'task-delete-handoff', projectId: 'project-1', sourceUserId: 'test-user' },
      } as QueuedAction);

      expect(result).toBe(true);
      expect(mockRetryQueueService.findItemForOwner).toHaveBeenCalledWith('task', 'task-delete-handoff', 'test-user');
      expect(mockActionQueueService.failRetry).not.toHaveBeenCalled();
    });
  });
}
