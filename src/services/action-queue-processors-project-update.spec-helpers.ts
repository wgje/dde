import { expect, it } from 'vitest';

import {
  getProcessor,
  mockActionQueueService,
  mockAuthService,
  mockLoggerCategory,
  mockRetryQueueService,
  mockSyncService,
  type QueuedAction,
} from './action-queue-processors.spec-helpers';

export function registerProjectUpdateRetryHandoffSpecs(): void {
  it('project:update should acknowledge RetryQueue handoff even after queue view becomes stale', async () => {
    const project = { id: 'p-stale-retry-transfer', syncSource: 'synced' };
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: false,
      retryEnqueued: ['project:p-stale-retry-transfer'],
      failureReason: 'offline sync deferred',
    });
    mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
      type: 'project',
      data: project,
      sourceUserId: 'test-user',
      taskIdsToDelete: [],
    });
    mockActionQueueService.isQueueViewCurrent.mockReturnValueOnce(false);
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project,
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
  });

  it('project:update should quietly discard stale terminal task-conflict results', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-stale-a'],
      retryEnqueued: [],
      failureReason: 'project batch sync finished with terminal conflicts',
    });
    mockActionQueueService.getProjectMutationViewGeneration
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1);
    const handler = getProcessor('project:update');

    const result = await handler({
      id: 'action-stale-terminal',
      payload: {
        project: { id: 'p-stale-terminal', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockActionQueueService.markActionResolvedWithoutRemote).toHaveBeenCalledWith('action-stale-terminal');
    expect(mockLoggerCategory.error).not.toHaveBeenCalledWith(
      'project:update 异常',
      expect.objectContaining({ projectId: 'p-stale-terminal' }),
    );
  });

  it('project:update should keep stale owner-handoff failures retryable', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-owner-handoff'],
      retryEnqueued: [],
      failureReason: 'transient network failure',
    });
    mockActionQueueService.isQueueViewCurrent.mockReturnValueOnce(false);
    const handler = getProcessor('project:update');

    const result = await handler({
      id: 'action-owner-handoff-failure',
      payload: {
        project: { id: 'p-owner-handoff', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'transient network failure',
        details: expect.objectContaining({
          actionType: 'project:update',
          projectId: 'p-owner-handoff',
        }),
      }),
    });
    expect(mockActionQueueService.markActionResolvedWithoutRemote)
      .not.toHaveBeenCalledWith('action-owner-handoff-failure');
  });

  it('project:update should acknowledge RetryQueue handoff when the retry item is hidden under the source owner', async () => {
    const project = { id: 'p-hidden-owner-retry-transfer', syncSource: 'synced' };
    mockAuthService.currentUserId.mockReturnValue('old-owner');
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: false,
      retryEnqueued: ['project:p-hidden-owner-retry-transfer'],
      failureReason: 'offline sync deferred',
    });
    mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
      type: 'project',
      data: project,
      sourceUserId: 'old-owner',
      taskIdsToDelete: [],
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project,
        sourceUserId: 'old-owner',
      },
    } as QueuedAction);

    expect(mockRetryQueueService.findItemForOwner).toHaveBeenCalledWith(
      'project',
      'p-hidden-owner-retry-transfer',
      'old-owner',
    );
    expect(result).toBe(true);
  });

  it('project:update should keep failing when persisted project retry payload loses deferred task deletes', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: false,
      retryEnqueued: ['project:p-mismatched-delete-payload'],
      failureReason: 'offline sync deferred',
    });
    mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
      type: 'project',
      data: { id: 'p-mismatched-delete-payload' },
      sourceUserId: 'test-user',
      taskIdsToDelete: ['task-delete-stale'],
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-mismatched-delete-payload', syncSource: 'synced' },
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-delete-current'],
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'offline sync deferred',
      }),
    });
  });

  it('project:update should keep classified failure when persisted project retry snapshot differs from the action snapshot', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: false,
      retryEnqueued: ['project:p-mismatched-project-snapshot'],
      failureReason: 'offline sync deferred',
    });
    mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
      type: 'project',
      data: { id: 'p-mismatched-project-snapshot', syncSource: 'synced', name: 'stale-project' },
      sourceUserId: 'test-user',
      taskIdsToDelete: ['task-delete-current'],
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-mismatched-project-snapshot', syncSource: 'synced', name: 'fresh-project' },
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-delete-current'],
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'offline sync deferred',
      }),
    });
  });
}
