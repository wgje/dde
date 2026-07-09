import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { APP_LIFECYCLE_CONFIG } from '../config';
import type { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';
import { flushResumeWithoutDrainingLongTimers } from './app-lifecycle-orchestrator.test-harness';

type SpecMock = ReturnType<typeof vi.fn>;

export interface AppLifecycleResumeQueueSpecContext {
  service: () => AppLifecycleOrchestratorService;
  simpleSync: () => {
    recoverAfterResume: SpecMock;
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
  });
}
