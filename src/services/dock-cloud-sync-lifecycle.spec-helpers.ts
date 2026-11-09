import { describe, expect, it, vi } from 'vitest';
import type { DockSnapshot } from '../models/parking-dock';
import type { CloudSyncEngineCallbacks, DockCloudSyncService } from './dock-cloud-sync.service';

type MockFunction = ((...args: unknown[]) => unknown) & {
  mockReturnValueOnce: (value: unknown) => unknown;
  mockRejectedValueOnce: (value: unknown) => unknown;
  mockResolvedValueOnce: (value: unknown) => unknown;
};

type EnqueueDurablyForOwnerMock = {
  mockReturnValueOnce: (value: Promise<string>) => unknown;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface DockCloudSyncLifecycleSpecContext {
  getService: () => DockCloudSyncService;
  makeCallbacks: (overrides?: Partial<CloudSyncEngineCallbacks>) => CloudSyncEngineCallbacks;
  makeSnapshot: (overrides?: Partial<DockSnapshot>) => DockSnapshot;
  mockActionQueue: {
    enqueueDurablyForOwner: EnqueueDurablyForOwnerMock;
  };
  mockSyncService: {
    loadFocusSession: MockFunction;
    listRoutineTasks: MockFunction;
  };
}

export function registerDockCloudSyncLifecycleSpecs(context: DockCloudSyncLifecycleSpecContext): void {
  describe('cancelTimers', () => {
    it('should clear pending cloud push timer', () => {
      const service = context.getService();
      service.init(context.makeCallbacks());
      service.scheduleCloudPush('user-1', context.makeSnapshot());

      // Timer is pending but not yet fired
      service.cancelTimers();
      vi.advanceTimersByTime(5000);

      expect(context.mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();
    });

    it('should clear pending cloud pull timer', () => {
      const service = context.getService();
      service.init(context.makeCallbacks());
      service.scheduleCloudPull('user-1', true);

      service.cancelTimers();
      vi.advanceTimersByTime(5000);

      expect(context.mockSyncService.loadFocusSession).not.toHaveBeenCalled();
    });

    it('should be safe to call when no timers are pending', () => {
      expect(() => context.getService().cancelTimers()).not.toThrow();
    });

    it('should dispose direct widget notify timers and dedupe state', () => {
      const service = context.getService();
      const directWidgetNotify = (
        service as unknown as {
          directWidgetNotify: { dispose: ReturnType<typeof vi.fn> };
        }
      ).directWidgetNotify;
      directWidgetNotify.dispose = vi.fn();

      service.cancelTimers();

      expect(directWidgetNotify.dispose).toHaveBeenCalledTimes(1);
    });

    it('should reset cloud pull circuit breaker so owner switch can force a new pull', async () => {
      const service = context.getService();
      service.init(context.makeCallbacks());
      context.mockSyncService.loadFocusSession.mockRejectedValueOnce({
        status: 401,
        message: 'unauthorized',
      });

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);
      expect(context.mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);

      service.cancelTimers();

      context.mockSyncService.loadFocusSession.mockResolvedValueOnce({ ok: true, value: null });
      context.mockSyncService.listRoutineTasks.mockResolvedValueOnce({ ok: true, value: [] });

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);

      expect(context.mockSyncService.loadFocusSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('ngOnDestroy lifecycle', () => {
    it('should ignore cloud push and pull entries after destroy', async () => {
      const service = context.getService();
      const callbacks = context.makeCallbacks();
      service.init(callbacks);

      service.ngOnDestroy();

      service.scheduleCloudPush('user-1', context.makeSnapshot());
      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(5000);

      expect(context.mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();
      expect(context.mockSyncService.loadFocusSession).not.toHaveBeenCalled();
      expect(callbacks.scheduleLocalPersist).not.toHaveBeenCalled();
    });

    it('should ignore a completed durable enqueue after destroy', async () => {
      const service = context.getService();
      const callbacks = context.makeCallbacks();
      const enqueue = deferred<string>();
      context.mockActionQueue.enqueueDurablyForOwner.mockReturnValueOnce(enqueue.promise);
      service.init(callbacks);

      service.scheduleCloudPush('user-1', context.makeSnapshot());
      await vi.advanceTimersByTimeAsync(3000);

      service.ngOnDestroy();
      enqueue.resolve('queued-after-destroy');
      await Promise.resolve();

      expect(callbacks.scheduleLocalPersist).not.toHaveBeenCalled();
    });
  });

  describe('scheduleCloudPull owner lifecycle', () => {
    it('should skip a pending cloud push after the current snapshot owner changes', () => {
      const service = context.getService();
      let currentSnapshotUserId: string | null = 'user-1';
      const callbacks = context.makeCallbacks({
        getCurrentSnapshotUserId: vi.fn(() => currentSnapshotUserId),
      });
      service.init(callbacks);

      service.scheduleCloudPush('user-1', context.makeSnapshot());
      currentSnapshotUserId = 'user-2';
      vi.advanceTimersByTime(3000);

      expect(callbacks.scheduleLocalPersist).not.toHaveBeenCalled();
      expect(context.mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();
    });

    it('should skip a pending cloud pull after the current snapshot owner changes', async () => {
      const service = context.getService();
      let currentSnapshotUserId: string | null = 'user-1';
      service.init(context.makeCallbacks({
        getCurrentSnapshotUserId: vi.fn(() => currentSnapshotUserId),
      }));

      service.scheduleCloudPull('user-1', true);
      currentSnapshotUserId = 'user-2';
      await vi.advanceTimersByTimeAsync(250);

      expect(context.mockSyncService.loadFocusSession).not.toHaveBeenCalled();
    });

    it('should not let a stale owner pull error open the circuit breaker for the current owner', async () => {
      const service = context.getService();
      let currentSnapshotUserId: string | null = 'user-1';
      const stalePull = deferred<never>();
      service.init(context.makeCallbacks({
        getCurrentSnapshotUserId: vi.fn(() => currentSnapshotUserId),
      }));
      context.mockSyncService.loadFocusSession.mockReturnValueOnce(stalePull.promise);
      context.mockSyncService.loadFocusSession.mockResolvedValueOnce({ ok: true, value: null });
      context.mockSyncService.listRoutineTasks.mockResolvedValueOnce({ ok: true, value: [] });

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);
      currentSnapshotUserId = 'user-2';
      stalePull.reject({ status: 401, message: 'stale owner unauthorized' });
      await Promise.resolve();
      await Promise.resolve();

      service.scheduleCloudPull('user-2', true);
      await vi.advanceTimersByTimeAsync(250);

      expect(context.mockSyncService.loadFocusSession).toHaveBeenCalledTimes(2);
    });
  });
}
