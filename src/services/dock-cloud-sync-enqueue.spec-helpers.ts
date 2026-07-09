import { describe, expect, it } from 'vitest';
import type { DockSnapshot } from '../models/parking-dock';
import { AUTH_CONFIG } from '../config/auth.config';
import type { CloudSyncEngineCallbacks, DockCloudSyncService } from './dock-cloud-sync.service';

type EnqueueDurablyForOwnerMock = (...args: unknown[]) => unknown;

interface DockCloudSyncEnqueueSpecContext {
  getService: () => DockCloudSyncService;
  makeCallbacks: () => CloudSyncEngineCallbacks;
  makeSnapshot: (overrides?: Partial<DockSnapshot>) => DockSnapshot;
  mockActionQueue: {
    enqueueDurablyForOwner: EnqueueDurablyForOwnerMock;
  };
}

export function registerDockCloudSyncEnqueueSpecs(context: DockCloudSyncEnqueueSpecContext): void {
  describe('enqueueFocusSessionSync', () => {
    it('should enqueue a focus-session action', () => {
      const service = context.getService();
      service.init(context.makeCallbacks());
      const snapshot = context.makeSnapshot();
      service.enqueueFocusSessionSync('user-1', snapshot);

      expect(context.mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          type: 'update',
          entityType: 'focus-session',
          payload: expect.objectContaining({
            sourceUserId: 'user-1',
            record: expect.objectContaining({ userId: 'user-1' }),
          }),
          priority: 'critical',
        }),
      );
    });

    it('相同快照仅在同一 owner 下去重，不应跨 owner 共享指纹', () => {
      const service = context.getService();
      service.init(context.makeCallbacks());
      const snapshot = context.makeSnapshot();

      service.enqueueFocusSessionSync('user-1', snapshot);
      service.enqueueFocusSessionSync('user-1', snapshot);
      service.enqueueFocusSessionSync('user-2', snapshot);

      expect(context.mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(2);
      expect(context.mockActionQueue.enqueueDurablyForOwner).toHaveBeenNthCalledWith(
        1,
        'user-1',
        expect.objectContaining({ entityType: 'focus-session' }),
      );
      expect(context.mockActionQueue.enqueueDurablyForOwner).toHaveBeenNthCalledWith(
        2,
        'user-2',
        expect.objectContaining({ entityType: 'focus-session' }),
      );
    });

    it('durable 入队失败后应允许相同 focus 快照再次入队', async () => {
      const service = context.getService();
      service.init(context.makeCallbacks());
      const snapshot = context.makeSnapshot();

      (context.mockActionQueue.enqueueDurablyForOwner as unknown as {
        mockResolvedValueOnce: (value: string) => unknown;
      }).mockResolvedValueOnce('');
      service.enqueueFocusSessionSync('user-1', snapshot);
      await Promise.resolve();
      service.enqueueFocusSessionSync('user-1', snapshot);

      expect(context.mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(2);
    });
  });

  describe('enqueueRoutineTaskSync', () => {
    it('should skip routine-task enqueue for local-user', () => {
      const service = context.getService();
      service.init(context.makeCallbacks());
      const routineTask = {
        routineId: 'r-local',
        title: 'Local only',
        triggerCondition: 'any-blank-period' as const,
        maxTimesPerDay: 1,
        isEnabled: true,
      };

      service.enqueueRoutineTaskSync(AUTH_CONFIG.LOCAL_MODE_USER_ID, routineTask);

      expect(context.mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();
    });

    it('should enqueue a routine-task action', () => {
      const service = context.getService();
      service.init(context.makeCallbacks());
      const routineTask = {
        routineId: 'r-1',
        title: 'Stretch',
        triggerCondition: 'any-blank-period' as const,
        maxTimesPerDay: 3,
        isEnabled: true,
      };
      service.enqueueRoutineTaskSync('user-1', routineTask);

      expect(context.mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          type: 'update',
          entityType: 'routine-task',
          entityId: 'r-1',
          payload: expect.objectContaining({
            userId: 'user-1',
            sourceUserId: 'user-1',
          }),
          priority: 'normal',
        }),
      );
    });
  });

  describe('enqueueRoutineCompletionSync', () => {
    it('should skip routine-completion enqueue for local-user', () => {
      const service = context.getService();
      service.init(context.makeCallbacks());
      const completion = {
        completionId: 'c-local',
        userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
        routineId: 'r-1',
        dateKey: '2025-01-01',
      };

      service.enqueueRoutineCompletionSync(completion);

      expect(context.mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();
    });

    it('should enqueue a routine-completion action', () => {
      const service = context.getService();
      service.init(context.makeCallbacks());
      const completion = {
        completionId: 'c-1',
        userId: 'user-1',
        routineId: 'r-1',
        dateKey: '2025-01-01',
      };
      service.enqueueRoutineCompletionSync(completion);

      expect(context.mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          type: 'create',
          entityType: 'routine-completion',
          entityId: 'c-1',
          payload: expect.objectContaining({
            completion: expect.objectContaining({ userId: 'user-1' }),
            sourceUserId: 'user-1',
          }),
          priority: 'normal',
        }),
      );
    });
  });

  describe('error paths', () => {
    it('should not throw when cancelTimers is called before any push/pull', () => {
      expect(() => context.getService().cancelTimers()).not.toThrow();
    });

    it('should not throw when scheduleCloudPush receives null snapshot', () => {
      expect(() => context.getService().scheduleCloudPush('user-1', null)).not.toThrow();
    });
  });
}
