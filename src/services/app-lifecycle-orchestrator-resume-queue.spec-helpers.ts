import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { APP_LIFECYCLE_CONFIG } from '../config';
import type { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';
import { flushResumeWithoutDrainingLongTimers } from './app-lifecycle-orchestrator.test-harness';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';

type SpecMock = ReturnType<typeof vi.fn>;

export interface AppLifecycleResumeQueueSpecContext {
  service: () => AppLifecycleOrchestratorService;
  simpleSync: () => {
    recoverAfterResume: SpecMock;
  };
  sessionManager: () => {
    validateOrRefreshOnResume: SpecMock;
  };
}

export function registerAppLifecycleResumeQueueSpecs(
  context: AppLifecycleResumeQueueSpecContext,
): void {
  describe('resume queue lifecycle', () => {
    it('should single-flight concurrent resume requests', async () => {
      let resolveRecovery: (() => void) | null = null;
      context.simpleSync().recoverAfterResume.mockReturnValue(
        new Promise<void>(resolve => {
          resolveRecovery = resolve;
        })
      );

      const p1 = context.service().triggerResume('visibility-threshold');
      const p2 = context.service().triggerResume('visibility-threshold');

      await Promise.resolve();
      await Promise.resolve();

      expect(context.simpleSync().recoverAfterResume).toHaveBeenCalledTimes(1);

      resolveRecovery!();
      await Promise.all([p1, p2]);
    });

    it('should run queued heavy recovery when online arrives during quick resume', async () => {
      let resolveQuickRecovery: (() => void) | null = null;
      context.simpleSync().recoverAfterResume.mockImplementationOnce(
        () => new Promise<void>(resolve => {
          resolveQuickRecovery = resolve;
        })
      );

      const quickResume = context.service().triggerResume('visibility-quick');
      await Promise.resolve();
      await Promise.resolve();

      expect(resolveQuickRecovery).toBeTypeOf('function');
      expect(context.simpleSync().recoverAfterResume).toHaveBeenCalledWith(
        'visibility-quick',
        expect.objectContaining({ mode: 'light' }),
      );

      const onlineResume = context.service().triggerResume('online');
      resolveQuickRecovery!();
      await Promise.all([quickResume, onlineResume]);
      await flushResumeWithoutDrainingLongTimers();

      const onlineHeavyCalls = context.simpleSync().recoverAfterResume.mock.calls.filter(
        ([reason, options]) => reason === 'online' && options?.mode === 'heavy',
      );
      expect(onlineHeavyCalls).toHaveLength(1);
    });

    it('quick resume 期间连续收到 online/pageshow 时应保留更高优先级 pageshow 恢复语义', async () => {
      let resolveQuickRecovery: (() => void) | null = null;
      context.simpleSync().recoverAfterResume.mockImplementationOnce(
        () => new Promise<void>(resolve => {
          resolveQuickRecovery = resolve;
        })
      );

      const quickResume = context.service().triggerResume('visibility-quick');
      await Promise.resolve();
      await Promise.resolve();

      expect(resolveQuickRecovery).toBeTypeOf('function');

      const onlineResume = context.service().triggerResume('online');
      const pageshowResume = context.service().triggerResume('pageshow');
      resolveQuickRecovery!();
      await Promise.all([quickResume, onlineResume, pageshowResume]);
      await flushResumeWithoutDrainingLongTimers();

      const heavyCalls = context.simpleSync().recoverAfterResume.mock.calls.filter(
        ([, options]) => options?.mode === 'heavy',
      );
      expect(heavyCalls).toHaveLength(1);
      expect(heavyCalls[0]?.[0]).toBe('pageshow');
    });

    it('heavy resume 的 light 阶段运行期间收到更高优先级 pageshow 时应追加一次 pageshow 恢复', async () => {
      let resolveOnlineRecovery: (() => void) | null = null;
      context.simpleSync().recoverAfterResume.mockImplementationOnce(
        () => new Promise<void>(resolve => {
          resolveOnlineRecovery = resolve;
        })
      );

      const onlineResume = context.service().triggerResume('online');
      await Promise.resolve();
      await Promise.resolve();

      expect(resolveOnlineRecovery).toBeTypeOf('function');
      expect(context.simpleSync().recoverAfterResume).toHaveBeenCalledWith(
        'online',
        expect.objectContaining({ mode: 'light', stage: 'full' }),
      );

      const pageshowResume = context.service().triggerResume('pageshow');
      resolveOnlineRecovery!();
      await Promise.all([onlineResume, pageshowResume]);
      await flushResumeWithoutDrainingLongTimers();

      const heavyCalls = context.simpleSync().recoverAfterResume.mock.calls.filter(
        ([, options]) => options?.mode === 'light' && options?.stage === 'full',
      );
      expect(heavyCalls.map(([reason]) => reason)).toEqual(['online', 'pageshow']);
    });

    it('queued resume 运行期间再次入队应继续衔接下一轮恢复', async () => {
      let resolveQuickRecovery: (() => void) | null = null;
      let resolveOnlineRecovery: (() => void) | null = null;
      context.simpleSync().recoverAfterResume
        .mockImplementationOnce(() => new Promise<void>(resolve => {
          resolveQuickRecovery = resolve;
        }))
        .mockImplementationOnce(() => new Promise<void>(resolve => {
          resolveOnlineRecovery = resolve;
        }));

      const quickResume = context.service().triggerResume('visibility-quick');
      await Promise.resolve();
      await Promise.resolve();
      const onlineResume = context.service().triggerResume('online');

      resolveQuickRecovery!();
      await flushResumeWithoutDrainingLongTimers();
      expect(resolveOnlineRecovery).toBeTypeOf('function');

      const pageshowResume = context.service().triggerResume('pageshow');
      resolveOnlineRecovery!();
      await Promise.all([quickResume, onlineResume, pageshowResume]);
      await flushResumeWithoutDrainingLongTimers();

      const fullResumeReasons = context.simpleSync().recoverAfterResume.mock.calls
        .filter(([, options]) => options?.mode === 'light' && options?.stage === 'full')
        .map(([reason]) => reason);
      expect(fullResumeReasons).toEqual(['visibility-quick', 'online', 'pageshow']);
    });

    it('destroy cleanup 后已排队的 heavy resume 不应在 quick resume 完成后继续执行', async () => {
      let resolveQuickRecovery: (() => void) | null = null;
      context.simpleSync().recoverAfterResume.mockImplementationOnce(
        () => new Promise<void>(resolve => {
          resolveQuickRecovery = resolve;
        })
      );

      const quickResume = context.service().triggerResume('visibility-quick');
      await Promise.resolve();
      await Promise.resolve();

      expect(resolveQuickRecovery).toBeTypeOf('function');
      expect(context.simpleSync().recoverAfterResume).toHaveBeenCalledWith(
        'visibility-quick',
        expect.objectContaining({ mode: 'light' }),
      );

      const queuedResume = context.service().triggerResume('online');
      TestBed.resetTestingModule();

      resolveQuickRecovery!();
      await Promise.allSettled([quickResume, queuedResume]);
      await flushResumeWithoutDrainingLongTimers();

      const onlineHeavyCalls = context.simpleSync().recoverAfterResume.mock.calls.filter(
        ([reason, options]) => reason === 'online' && options?.mode === 'heavy',
      );
      expect(onlineHeavyCalls).toHaveLength(0);
      expect(context.simpleSync().recoverAfterResume).toHaveBeenCalledTimes(1);
    });

    it('destroy cleanup 应立即清理进行中的恢复状态', async () => {
      context.simpleSync().recoverAfterResume.mockReturnValue(new Promise<void>(() => {
        // keep recovery in-flight until cleanup
      }));

      const resumePromise = context.service().triggerResume('visibility-threshold');
      await flushResumeWithoutDrainingLongTimers();

      expect(context.service().isResuming()).toBe(true);
      expect(context.service().getCurrentRecoveryTicket()).toBeTruthy();

      TestBed.resetTestingModule();

      expect(context.service().isResuming()).toBe(false);
      expect(context.service().getCurrentRecoveryTicket()).toBeNull();

      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.RESUME_TIMEOUT_MS + 10);
      await resumePromise;
    });

    it('owner reset 后旧 active/queued resume 不得阻塞或覆盖新会话恢复', async () => {
      let resolveOldRecovery: (() => void) | null = null;
      let resolveNewRecovery: (() => void) | null = null;
      let resolvePostResetQueuedRecoveryStarted: (() => void) | null = null;
      const postResetQueuedRecoveryStarted = new Promise<void>(resolve => {
        resolvePostResetQueuedRecoveryStarted = resolve;
      });
      context.simpleSync().recoverAfterResume
        .mockImplementationOnce(() => new Promise<void>(resolve => {
          resolveOldRecovery = resolve;
        }))
        .mockImplementationOnce(() => new Promise<void>(resolve => {
          resolveNewRecovery = resolve;
        }))
        .mockImplementationOnce(() => {
          resolvePostResetQueuedRecoveryStarted!();
          return Promise.resolve();
        });

      const oldResume = context.service().triggerResume('visibility-quick');
      await Promise.resolve();
      await Promise.resolve();
      const oldQueuedResume = context.service().triggerResume('online');

      TestBed.inject(SessionRuntimeResetRegistry).resetAll('owner-change');
      const newResume = context.service().triggerResume('visibility-quick');
      await Promise.resolve();
      await Promise.resolve();

      expect(context.simpleSync().recoverAfterResume).toHaveBeenCalledTimes(2);
      expect(resolveNewRecovery).toBeTypeOf('function');
      expect(context.service().isResuming()).toBe(true);
      const newQueuedResume = context.service().triggerResume('pageshow');

      resolveOldRecovery!();
      await Promise.allSettled([oldResume, oldQueuedResume]);
      await Promise.resolve();

      expect(context.simpleSync().recoverAfterResume).toHaveBeenCalledTimes(2);
      expect(context.service().isResuming()).toBe(true);

      resolveNewRecovery!();
      await Promise.all([newResume, newQueuedResume, postResetQueuedRecoveryStarted]);
      await flushResumeWithoutDrainingLongTimers();
      const postResetQueuedReasons = context.simpleSync().recoverAfterResume.mock.calls
        .slice(2)
        .map(([reason]) => reason);
      expect(postResetQueuedReasons).toContain('pageshow');
      expect(postResetQueuedReasons).not.toContain('online');
      expect(context.service().isResuming()).toBe(false);
    });

    it('owner reset 后旧 session 校验晚到 deferred 不得重新排队恢复', async () => {
      let resolveSessionValidation: ((result: {
        ok: boolean;
        refreshed: boolean;
        deferred: boolean;
        reason: string;
      }) => void) | null = null;
      context.sessionManager().validateOrRefreshOnResume.mockReturnValueOnce(
        new Promise(resolve => {
          resolveSessionValidation = resolve;
        }),
      );

      const oldResume = context.service().triggerResume('online');
      await Promise.resolve();
      TestBed.inject(SessionRuntimeResetRegistry).resetAll('owner-change');
      resolveSessionValidation!({
        ok: false,
        refreshed: false,
        deferred: true,
        reason: 'browser-network-suspended',
      });

      await oldResume;
      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.RESUME_TIMEOUT_MS + 100);

      expect(context.sessionManager().validateOrRefreshOnResume).toHaveBeenCalledTimes(1);
      expect(context.simpleSync().recoverAfterResume).not.toHaveBeenCalled();
    });

    it.each(['owner-change', 'clear-local-data'] as const)(
      '%s reset 应取消已排入的 deferred retry timer',
      async resetReason => {
        context.sessionManager().validateOrRefreshOnResume.mockResolvedValueOnce({
          ok: false,
          refreshed: false,
          deferred: true,
          reason: 'browser-network-suspended',
        });

        await context.service().triggerResume('online');
        expect(context.sessionManager().validateOrRefreshOnResume).toHaveBeenCalledTimes(1);

        TestBed.inject(SessionRuntimeResetRegistry).resetAll(resetReason);
        await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.RESUME_TIMEOUT_MS + 100);

        expect(context.sessionManager().validateOrRefreshOnResume).toHaveBeenCalledTimes(1);
        expect(context.simpleSync().recoverAfterResume).not.toHaveBeenCalled();
      },
    );

    it.each(['owner-change', 'clear-local-data'] as const)(
      '%s reset 应清除旧会话 heavy cooldown',
      async resetReason => {
        await context.service().triggerResume('online');
        await flushResumeWithoutDrainingLongTimers();

        expect(context.service().lastHeavyRecoveryAt()).not.toBeNull();
        expect(context.service().isHeavyRecoveryInCooldown()).toBe(true);

        TestBed.inject(SessionRuntimeResetRegistry).resetAll(resetReason);

        expect(context.service().lastHeavyRecoveryAt()).toBeNull();
        expect(context.service().isHeavyRecoveryInCooldown()).toBe(false);
      },
    );
  });
}
