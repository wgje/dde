import { describe, expect, it } from 'vitest';

import {
  getProcessor,
  mockActionQueueService,
  mockAuthService,
  mockProjectStateService,
  mockSyncService,
  type QueuedAction,
} from './action-queue-processors.spec-helpers';

export function registerActionQueueProcessorsOwnerPreferenceSpecs(): void {
  describe('owner metadata and preferences', () => {
    it('task:create should move queue items from another user to dead letter', async () => {
      const handler = getProcessor('task:create');

      const result = await handler({
        payload: {
          task: { id: 't-foreign', title: 'Foreign Task' },
          projectId: 'p-1',
          sourceUserId: 'other-user',
        },
      } as QueuedAction);

      expect(result).toBe(true);
      expect(mockSyncService.pushTask).not.toHaveBeenCalled();
      expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
    });

    it('task:create should move legacy queue items without owner to dead letter', async () => {
      const handler = getProcessor('task:create');
      mockProjectStateService.getProject.mockReturnValueOnce({ id: 'p-1', syncSource: 'synced' });
      const action = {
        payload: {
          task: { id: 't-legacy', title: 'Legacy Task' },
          projectId: 'p-1',
        },
      } as QueuedAction;

      const result = await handler(action);

      expect(result).toBe(true);
      expect(mockSyncService.pushTask).not.toHaveBeenCalled();
      expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalledWith(
        action,
        expect.stringContaining('legacy 队列项缺少来源元数据')
      );
    });

    it('preference:update should move queue items from another user to dead letter', async () => {
      const handler = getProcessor('preference:update');

      const result = await handler({
        payload: {
          userId: 'other-user',
          preferences: { theme: 'dark' },
        },
      } as QueuedAction);

      expect(result).toBe(true);
      expect(mockSyncService.saveUserPreferences).not.toHaveBeenCalled();
      expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
    });

    it('preference:update should call saveUserPreferences with explicit source user', async () => {
      const handler = getProcessor('preference:update');

      const result = await handler({
        operationId: 'op-preference-update',
        payload: {
          userId: 'test-user',
          sourceUserId: 'test-user',
          preferences: { theme: 'dark' },
        },
      } as QueuedAction);

      expect(result).toBe(true);
      expect(mockSyncService.saveUserPreferences).toHaveBeenCalledWith(
        'test-user',
        { theme: 'dark' },
        'op-preference-update',
      );
    });

    it('preference:update should defer without remote write when auth is pending', async () => {
      mockAuthService.currentUserId.mockReturnValueOnce(null);
      const handler = getProcessor('preference:update');

      const result = await handler({
        payload: {
          userId: 'test-user',
          sourceUserId: 'test-user',
          preferences: { theme: 'dark' },
        },
      } as QueuedAction);

      expect(result).toEqual({
        outcome: 'defer-retry',
        error: expect.objectContaining({
          code: 'SYNC_AUTH_PENDING',
          details: expect.objectContaining({
            reason: 'auth-pending',
            actionType: 'preference:update',
            entityId: 'test-user',
          }),
        }),
      });
      expect(mockActionQueueService.deferRetry).toHaveBeenCalledWith(expect.objectContaining({
        code: 'SYNC_AUTH_PENDING',
      }));
      expect(mockSyncService.saveUserPreferences).not.toHaveBeenCalled();
      expect(mockActionQueueService.failRetry).not.toHaveBeenCalled();
      expect(mockActionQueueService.moveToDeadLetter).not.toHaveBeenCalled();
    });
  });
}
