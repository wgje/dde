import { describe, expect, it, vi } from 'vitest';

import { APP_LIFECYCLE_CONFIG } from '../config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { FOCUS_CONFIG } from '../config/focus.config';
import type { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';
import {
  flushResumeWithoutDrainingLongTimers,
  setStandaloneDisplayMode,
  setVisibilityState,
} from './app-lifecycle-orchestrator.test-harness';

type SpecMock = ReturnType<typeof vi.fn>;

export interface AppLifecycleFocusGateSpecContext {
  service: () => AppLifecycleOrchestratorService;
  focusStartupProbe: () => {
    recheckGate: SpecMock;
    hasPendingGateWork: SpecMock;
  };
  simpleSync: () => {
    suspendTransport: SpecMock;
    recoverAfterResume: SpecMock;
  };
  sessionManager: () => {
    validateOrRefreshOnResume: SpecMock;
  };
  syncCoordinator: () => {
    refreshBlackBoxWatermarkIfNeeded: SpecMock;
  };
}

export function registerAppLifecycleFocusGateSpecs(
  context: AppLifecycleFocusGateSpecContext,
): void {
  describe('focus gate resume checks', () => {
    it('后台闲置超过大门阈值后恢复若本地已命中 gate，不应在黑匣子刷新后重复复核', async () => {
      context.focusStartupProbe().hasPendingGateWork.mockReturnValue(true);

      context.service().initialize();

      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));

      vi.setSystemTime(new Date(Date.now() + FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD + 1));

      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      await flushResumeWithoutDrainingLongTimers();

      expect(context.focusStartupProbe().recheckGate).toHaveBeenCalledTimes(1);
      expect(context.focusStartupProbe().recheckGate).toHaveBeenCalledWith({
        source: 'resume-local',
        reloadLocal: true,
      });
    });

    it('TWA 仅触发 window focus 兜底时也应在长后台后立即复核大门', async () => {
      setStandaloneDisplayMode();
      context.service().initialize();

      window.dispatchEvent(new Event('blur'));
      expect(context.simpleSync().suspendTransport).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date(Date.now() + FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD + 1));
      window.dispatchEvent(new Event('focus'));

      await flushResumeWithoutDrainingLongTimers();

      expect(context.focusStartupProbe().recheckGate).toHaveBeenNthCalledWith(1, {
        source: 'resume-local',
        reloadLocal: true,
      });
    });

    it('TWA 长后台恢复前先收到 online 时不应吞掉 foreground 大门复核', async () => {
      setStandaloneDisplayMode();
      context.service().initialize();

      window.dispatchEvent(new Event('blur'));
      vi.setSystemTime(new Date(Date.now() + FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD + 1));

      window.dispatchEvent(new Event('online'));
      await flushResumeWithoutDrainingLongTimers();

      expect(context.sessionManager().validateOrRefreshOnResume).not.toHaveBeenCalled();
      expect(context.focusStartupProbe().recheckGate).not.toHaveBeenCalled();

      window.dispatchEvent(new Event('focus'));
      await flushResumeWithoutDrainingLongTimers();

      expect(context.focusStartupProbe().recheckGate).toHaveBeenNthCalledWith(1, {
        source: 'resume-local',
        reloadLocal: true,
      });
    });

    it('TWA blur 后迟到的 hidden 事件不应覆盖长后台计时', async () => {
      setStandaloneDisplayMode();
      context.service().initialize();

      window.dispatchEvent(new Event('blur'));
      vi.setSystemTime(new Date(Date.now() + FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD + 1));

      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      await flushResumeWithoutDrainingLongTimers();

      expect(context.focusStartupProbe().recheckGate).toHaveBeenNthCalledWith(1, {
        source: 'resume-local',
        reloadLocal: true,
      });
    });

    it('后台闲置超过大门阈值后恢复若本地已命中 gate，即使远端黑匣子刷新拉到新数据也不应重复复核', async () => {
      context.focusStartupProbe().hasPendingGateWork.mockReturnValue(true);
      context.syncCoordinator().refreshBlackBoxWatermarkIfNeeded.mockResolvedValue({ skipped: false });

      context.service().initialize();

      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));

      vi.setSystemTime(new Date(Date.now() + FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD + 1));

      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      await flushResumeWithoutDrainingLongTimers();

      expect(context.focusStartupProbe().recheckGate).toHaveBeenCalledTimes(1);
      expect(context.focusStartupProbe().recheckGate).toHaveBeenCalledWith({
        source: 'resume-local',
        reloadLocal: true,
      });
    });

    it('后台闲置超过大门阈值后恢复若本地未命中 gate，应在黑匣子刷新后再次复核', async () => {
      context.service().initialize();

      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));

      vi.setSystemTime(new Date(Date.now() + FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD + 1));

      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      await flushResumeWithoutDrainingLongTimers();

      expect(context.focusStartupProbe().recheckGate).toHaveBeenCalledTimes(2);
      expect(context.focusStartupProbe().recheckGate).toHaveBeenNthCalledWith(1, {
        source: 'resume-local',
        reloadLocal: true,
      });
      expect(context.focusStartupProbe().recheckGate).toHaveBeenNthCalledWith(2, {
        source: 'resume-remote',
        reloadLocal: false,
      });
    });

    it('hidden>threshold 后 visible/focus/online 连续事件应仅触发一次 heavy', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_INTERACTION_FIRST_V1 = true;
      (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_PULSE_DEDUP_V1 = true;

      context.service().initialize();

      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      vi.setSystemTime(new Date(Date.now() + APP_LIFECYCLE_CONFIG.RESUME_THRESHOLD_MS + 10));
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await flushResumeWithoutDrainingLongTimers();

      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      await flushResumeWithoutDrainingLongTimers();

      const heavyCalls = context.simpleSync().recoverAfterResume.mock.calls.filter(
        ([, options]) => options?.mode === 'heavy'
      );
      expect(heavyCalls).toHaveLength(1);
    });
  });
}
