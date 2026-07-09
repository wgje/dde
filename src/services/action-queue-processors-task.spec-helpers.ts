import { describe, expect, it } from 'vitest';

import { PermanentFailureError } from '../utils/permanent-failure-error';
import {
  getProcessor,
  mockActionQueueService,
  mockConflictStorageService,
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

    it('task:update should call pushTask with sourceUserId', async () => {
      const handler = getProcessor('task:update');
      const task = { id: 't-2', title: 'Task update' };

      const result = await handler({
        operationId: 'op-task-update',
        payload: { task, projectId: 'p-2', sourceUserId: 'test-user' },
      } as QueuedAction);

      expect(mockSyncService.pushTask).toHaveBeenCalledWith(
        task,
        'p-2',
        false,
        false,
        'test-user',
        true,
        undefined,
        'op-task-update',
      );
      expect(result).toBe(true);
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
        },
      } as QueuedAction);

      expect(result).toBe(true);
      expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
      expect(mockActionQueueService.markActionResolvedWithoutRemote).toHaveBeenCalledOnce();
    });

    it('task:update should persist remote-newer conflicts before resolving the ActionQueue item locally', async () => {
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
      const handler = getProcessor('task:update');

      const result = await handler({
        id: 'action-remote-newer',
        operationId: 'op-task-remote-newer',
        payload: {
          task: { id: 'task-remote-newer', title: 'Local task title', updatedAt: '2026-06-25T00:00:00.000Z' },
          projectId: 'project-1',
          sourceUserId: 'test-user',
        },
      } as QueuedAction);

      expect(result).toBe(true);
      expect(mockConflictStorageService.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'project-1',
        ownerUserId: 'test-user',
        reason: 'version_mismatch',
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
      });
      const handler = getProcessor('task:update');

      const result = await handler({
        payload: { task, projectId: 'project-1', sourceUserId: 'test-user' },
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
        operationId: 'op-old-task-handoff',
      });
      const handler = getProcessor('task:update');

      const result = await handler({
        operationId: 'op-new-task-handoff',
        payload: { task, projectId: 'project-1', sourceUserId: 'test-user' },
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
        operationId: 'retry-op-task-handoff',
      });
      const handler = getProcessor('task:update');

      const result = await handler({
        payload: { task, projectId: 'project-1', sourceUserId: 'test-user' },
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
