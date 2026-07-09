import { describe, expect, it, vi } from 'vitest';

import type { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';
import { flushResumeWithoutDrainingLongTimers } from './app-lifecycle-orchestrator.test-harness';

type SpecMock = ReturnType<typeof vi.fn>;

interface AppLifecyclePendingPersistSpecContext {
  service: () => AppLifecycleOrchestratorService;
  sessionManager: () => {
    getRecentValidationSnapshot: SpecMock;
  };
  syncCoordinator: () => {
    hasPendingLocalChanges: SpecMock;
    flushPendingPersistToCloud: SpecMock;
  };
  sentry: () => {
    addBreadcrumb: SpecMock;
    captureException: SpecMock;
  };
  logger: () => {
    warn: SpecMock;
  };
}

export function registerAppLifecyclePendingPersistSpecs(
  context: AppLifecyclePendingPersistSpecContext,
): void {
  describe('pending persist recovery', () => {
    it('应在恢复时自动补发尚未完成的本地持久化', async () => {
      context.syncCoordinator().hasPendingLocalChanges.mockReturnValue(true);

      await context.service().triggerResume('visibility-quick');
      await Promise.resolve();

      expect(context.syncCoordinator().flushPendingPersistToCloud).toHaveBeenCalledWith(
        'resume:visibility-quick',
      );
    });

    it('online 恢复命中会话快照时也应异步补发 pending persist', async () => {
      context.syncCoordinator().hasPendingLocalChanges.mockReturnValue(true);
      context.sessionManager().getRecentValidationSnapshot.mockReturnValue({
        valid: true,
        userId: 'user-1',
        at: Date.now(),
      });

      await context.service().triggerResume('online');
      await Promise.resolve();

      expect(context.syncCoordinator().flushPendingPersistToCloud).toHaveBeenCalledWith(
        'resume:online',
      );
    });

    it('pending persist 补发 breadcrumb 失败时仍应调度云端持久化补偿', async () => {
      const breadcrumbError = new Error('breadcrumb failed');
      context.syncCoordinator().hasPendingLocalChanges.mockReturnValue(true);
      context.sentry().addBreadcrumb.mockImplementation((breadcrumb) => {
        if (breadcrumb.data?.step === 'resume-pending-persist-recovery') {
          throw breadcrumbError;
        }
      });

      await context.service().triggerResume('visibility-quick');
      await Promise.resolve();

      expect(context.logger().warn).toHaveBeenCalledWith(
        'Resume pending persist recovery breadcrumb failed',
        { reason: 'visibility-quick', error: breadcrumbError },
      );
      expect(context.syncCoordinator().flushPendingPersistToCloud).toHaveBeenCalledWith(
        'resume:visibility-quick',
      );
    });

    it('pending persist 补发 queueMicrotask 调度失败时应降级到 Promise 调度', async () => {
      const scheduleError = new Error('queueMicrotask failed');
      const originalQueueMicrotask = globalThis.queueMicrotask;
      context.syncCoordinator().hasPendingLocalChanges.mockReturnValue(true);
      globalThis.queueMicrotask = vi.fn(() => {
        throw scheduleError;
      }) as unknown as typeof queueMicrotask;

      try {
        await context.service().triggerResume('visibility-quick');
        await Promise.resolve();

        expect(context.logger().warn).toHaveBeenCalledWith(
          'Resume pending persist recovery scheduling failed',
          { reason: 'visibility-quick', error: scheduleError },
        );
        expect(context.syncCoordinator().flushPendingPersistToCloud).toHaveBeenCalledWith(
          'resume:visibility-quick',
        );
      } finally {
        globalThis.queueMicrotask = originalQueueMicrotask;
      }
    });

    it('pending persist 补发进行中又收到 online 且仍有本地变更时应追加补发 online', async () => {
      let resolveFirstFlush: ((value: boolean) => void) | null = null;
      context.syncCoordinator().hasPendingLocalChanges.mockReturnValue(true);
      context.syncCoordinator().flushPendingPersistToCloud
        .mockReturnValueOnce(new Promise<boolean>(resolve => {
          resolveFirstFlush = resolve;
        }))
        .mockResolvedValueOnce(true);

      const quickResume = context.service().triggerResume('visibility-quick');
      await flushResumeWithoutDrainingLongTimers();

      expect(context.syncCoordinator().flushPendingPersistToCloud).toHaveBeenCalledTimes(1);
      expect(context.syncCoordinator().flushPendingPersistToCloud).toHaveBeenCalledWith(
        'resume:visibility-quick',
      );

      await context.service().triggerResume('online');
      await flushResumeWithoutDrainingLongTimers();

      expect(context.syncCoordinator().flushPendingPersistToCloud).toHaveBeenCalledTimes(1);
      expect(resolveFirstFlush).toBeTypeOf('function');

      resolveFirstFlush!(false);
      await quickResume;
      await flushResumeWithoutDrainingLongTimers();

      expect(context.syncCoordinator().flushPendingPersistToCloud).toHaveBeenCalledTimes(2);
      expect(context.syncCoordinator().flushPendingPersistToCloud).toHaveBeenLastCalledWith(
        'resume:online',
      );
    });

    it('pending persist 补发失败且异常上报失败时不应产生未处理 rejection', async () => {
      const persistError = new Error('persist flush failed');
      const sentryError = new Error('sentry capture failed');
      const unhandled: unknown[] = [];
      const onUnhandledRejection = (event: PromiseRejectionEvent) => {
        unhandled.push(event.reason);
        event.preventDefault();
      };
      window.addEventListener('unhandledrejection', onUnhandledRejection);

      context.syncCoordinator().hasPendingLocalChanges.mockReturnValue(true);
      context.syncCoordinator().flushPendingPersistToCloud.mockRejectedValueOnce(persistError);
      context.sentry().captureException.mockImplementationOnce(() => {
        throw sentryError;
      });

      try {
        await context.service().triggerResume('visibility-quick');
        await flushResumeWithoutDrainingLongTimers();

        expect(context.logger().warn).toHaveBeenCalledWith(
          'Resume pending persist recovery failed',
          { reason: 'visibility-quick', error: persistError },
        );
        expect(context.logger().warn).toHaveBeenCalledWith(
          'Resume pending persist recovery telemetry failed',
          { reason: 'visibility-quick', error: sentryError },
        );
        expect(unhandled).toEqual([]);
      } finally {
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
      }
    });
  });
}
