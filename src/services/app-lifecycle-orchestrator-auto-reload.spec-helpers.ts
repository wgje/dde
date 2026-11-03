import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';
import { flushResumeWithoutDrainingLongTimers } from './app-lifecycle-orchestrator.test-harness';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';

type SpecMock = ReturnType<typeof vi.fn>;

interface AppLifecycleAutoReloadSpecContext {
  service: () => AppLifecycleOrchestratorService;
  sessionManager: () => {
    validateOrRefreshOnResume: SpecMock;
  };
  simpleSync: () => {
    recoverAfterResume: SpecMock;
  };
  sentry: () => {
    addBreadcrumb: SpecMock;
    captureMessage: SpecMock;
  };
  toast: () => {
    warning: SpecMock;
  };
  reloadViaForceClearCache: SpecMock;
}

export function registerAppLifecycleAutoReloadSpecs(context: AppLifecycleAutoReloadSpecContext): void {
  describe('auto-reload 仅在 pipeline 真异常时触发', () => {
    /** 找到带指定 message 的 lifecycle.resume.fail breadcrumb，断言 data.failureKind */
    const findFailBreadcrumbs = () =>
      context.sentry().addBreadcrumb.mock.calls
        .map(([entry]) => entry as { message?: string; data?: Record<string, unknown> })
        .filter(entry => entry.message === 'lifecycle.resume.fail');

    const expectNoAutoReload = (): void => {
      expect(context.reloadViaForceClearCache).not.toHaveBeenCalled();
      const reloadMessageCalls = context.sentry().captureMessage.mock.calls.filter(
        ([message]) => message === 'Lifecycle auto reload scheduled'
      );
      expect(reloadMessageCalls).toHaveLength(0);
      expect(context.toast().warning).not.toHaveBeenCalledWith(
        '恢复失败',
        expect.anything(),
        expect.anything()
      );
    };

    it('regression: 连续 no-session 不应触发 auto-reload，且 breadcrumb 含 failureKind', async () => {
      context.sessionManager().validateOrRefreshOnResume.mockResolvedValue({
        ok: false,
        refreshed: false,
        deferred: false,
        reason: 'no-session',
      });

      await context.service().triggerResume('visibility-quick');
      await context.service().triggerResume('visibility-quick');
      await flushResumeWithoutDrainingLongTimers();

      expectNoAutoReload();

      const failCrumbs = findFailBreadcrumbs();
      expect(failCrumbs.length).toBeGreaterThanOrEqual(2);
      for (const crumb of failCrumbs) {
        expect(crumb.data?.['failureKind']).toBe('no-session');
        expect(crumb.data?.['sessionFailureReason']).toBe('no-session');
      }
    });

    it('regression: 连续 refresh-failed 不应触发 auto-reload', async () => {
      context.sessionManager().validateOrRefreshOnResume.mockResolvedValue({
        ok: false,
        refreshed: false,
        deferred: false,
        reason: 'refresh-failed',
      });

      await context.service().triggerResume('visibility-quick');
      await context.service().triggerResume('visibility-quick');
      await flushResumeWithoutDrainingLongTimers();

      expectNoAutoReload();
      const failCrumbs = findFailBreadcrumbs();
      expect(failCrumbs.length).toBeGreaterThanOrEqual(2);
      for (const crumb of failCrumbs) {
        expect(crumb.data?.['failureKind']).toBe('refresh-failed');
      }
    });

    it('pipeline 真异常达到阈值后应触发 auto-reload，并标记 failureKind=pipeline-exception', async () => {
      context.simpleSync().recoverAfterResume.mockRejectedValue(new Error('boom'));

      await context.service().triggerResume('visibility-quick');
      await context.service().triggerResume('visibility-quick');
      await flushResumeWithoutDrainingLongTimers();

      const reloadMessageCalls = context.sentry().captureMessage.mock.calls.filter(
        ([message]) => message === 'Lifecycle auto reload scheduled'
      );
      expect(reloadMessageCalls).toHaveLength(1);
      const [, options] = reloadMessageCalls[0] as [string, { tags?: Record<string, unknown> }];
      expect(options.tags?.['failureKind']).toBe('pipeline-exception');

      expect(context.toast().warning).toHaveBeenCalledWith(
        '恢复失败',
        expect.any(String),
        expect.any(Object)
      );

      await vi.advanceTimersByTimeAsync(2000);
      expect(context.reloadViaForceClearCache).toHaveBeenCalledTimes(1);

      const failCrumbs = findFailBreadcrumbs();
      expect(failCrumbs.length).toBeGreaterThanOrEqual(2);
      for (const crumb of failCrumbs) {
        expect(crumb.data?.['failureKind']).toBe('pipeline-exception');
      }
    });

    it('counter-isolation: no-session 不会累加 pipeline 计数，真异常仍按 catch 计数升级', async () => {
      // 先两次 no-session 失败：consecutiveSessionFailures = 2，consecutiveFailures = 0
      context.sessionManager().validateOrRefreshOnResume
        .mockResolvedValueOnce({ ok: false, refreshed: false, deferred: false, reason: 'no-session' })
        .mockResolvedValueOnce({ ok: false, refreshed: false, deferred: false, reason: 'no-session' });

      await context.service().triggerResume('visibility-quick');
      await context.service().triggerResume('visibility-quick');
      await flushResumeWithoutDrainingLongTimers();

      expectNoAutoReload();

      // 第三次：一次 pipeline 真异常 → consecutiveFailures = 1，仍未达到阈值 2
      context.sessionManager().validateOrRefreshOnResume.mockResolvedValueOnce({
        ok: true,
        refreshed: false,
        deferred: false,
      });
      context.simpleSync().recoverAfterResume.mockRejectedValueOnce(new Error('boom-1'));

      await context.service().triggerResume('visibility-quick');
      await flushResumeWithoutDrainingLongTimers();

      expect(context.reloadViaForceClearCache).not.toHaveBeenCalled();
      const beforeReloadCalls = context.sentry().captureMessage.mock.calls.filter(
        ([message]) => message === 'Lifecycle auto reload scheduled'
      );
      expect(beforeReloadCalls).toHaveLength(0);

      // 第四次：第二次 pipeline 真异常 → consecutiveFailures = 2，触发 reload
      context.sessionManager().validateOrRefreshOnResume.mockResolvedValueOnce({
        ok: true,
        refreshed: false,
        deferred: false,
      });
      context.simpleSync().recoverAfterResume.mockRejectedValueOnce(new Error('boom-2'));

      await context.service().triggerResume('visibility-quick');
      await flushResumeWithoutDrainingLongTimers();

      const afterReloadCalls = context.sentry().captureMessage.mock.calls.filter(
        ([message]) => message === 'Lifecycle auto reload scheduled'
      );
      expect(afterReloadCalls).toHaveLength(1);
    });

    it('deferred 路径不应累加任何失败计数器', async () => {
      context.sessionManager().validateOrRefreshOnResume.mockResolvedValue({
        ok: false,
        refreshed: false,
        deferred: true,
        reason: 'client-unready',
      });

      await context.service().triggerResume('visibility-quick');
      await context.service().triggerResume('visibility-quick');
      await flushResumeWithoutDrainingLongTimers();

      expectNoAutoReload();

      // deferred 应记 success breadcrumb（带 deferred: true），不应记 fail
      expect(findFailBreadcrumbs()).toHaveLength(0);
    });

    it.each(['owner-change', 'clear-local-data'] as const)(
      '%s reset 应清除旧 pipeline failure 计数',
      async resetReason => {
        context.simpleSync().recoverAfterResume.mockRejectedValue(new Error('boom'));

        await context.service().triggerResume('visibility-quick');
        await flushResumeWithoutDrainingLongTimers();
        expectNoAutoReload();

        TestBed.inject(SessionRuntimeResetRegistry).resetAll(resetReason);
        await context.service().triggerResume('visibility-quick');
        await flushResumeWithoutDrainingLongTimers();

        expectNoAutoReload();
      },
    );

    it.each(['owner-change', 'clear-local-data'] as const)(
      '%s reset 应清除旧 session failure 计数',
      async resetReason => {
        context.sessionManager().validateOrRefreshOnResume.mockResolvedValue({
          ok: false,
          refreshed: false,
          deferred: false,
          reason: 'no-session',
        });

        await context.service().triggerResume('visibility-quick');
        TestBed.inject(SessionRuntimeResetRegistry).resetAll(resetReason);
        await context.service().triggerResume('visibility-quick');
        await flushResumeWithoutDrainingLongTimers();

        const failCrumbs = findFailBreadcrumbs();
        expect(failCrumbs).toHaveLength(2);
        expect(failCrumbs[1]?.data?.['consecutiveSessionFailures']).toBe(1);
      },
    );

    it.each(['owner-change', 'clear-local-data'] as const)(
      '%s reset 应取消旧 auto-reload timer 且允许新会话重新安排',
      async resetReason => {
        context.simpleSync().recoverAfterResume.mockRejectedValue(new Error('boom'));

        await context.service().triggerResume('visibility-quick');
        await context.service().triggerResume('visibility-quick');
        TestBed.inject(SessionRuntimeResetRegistry).resetAll(resetReason);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(context.reloadViaForceClearCache).not.toHaveBeenCalled();

        await context.service().triggerResume('visibility-quick');
        await context.service().triggerResume('visibility-quick');
        const reloadMessageCalls = context.sentry().captureMessage.mock.calls.filter(
          ([message]) => message === 'Lifecycle auto reload scheduled',
        );
        expect(reloadMessageCalls).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(context.reloadViaForceClearCache).toHaveBeenCalledTimes(1);
      },
    );
  });
}
