import { expect, it, vi } from 'vitest';

import { APP_LIFECYCLE_CONFIG } from '../config';
import type { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';
import {
  flushResumeWithoutDrainingLongTimers,
  setVisibilityState,
} from './app-lifecycle-orchestrator.test-harness';

type SpecMock = ReturnType<typeof vi.fn>;

interface AppLifecycleVersionPromptSpecContext {
  service: () => AppLifecycleOrchestratorService;
  toast: () => {
    info: SpecMock;
  };
  reloadViaForceClearCache: SpecMock;
}

function simulateLongBackgroundResume(): void {
  setVisibilityState('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  vi.setSystemTime(new Date(Date.now() + APP_LIFECYCLE_CONFIG.NEW_VERSION_PROMPT_THRESHOLD_MS + 1));
  setVisibilityState('visible');
  document.dispatchEvent(new Event('visibilitychange'));
}

export function registerAppLifecycleVersionPromptSpecs(
  context: AppLifecycleVersionPromptSpecContext,
): void {
  it('「检测到新版本」prompt: 后台超阈值 + 有 pending version 时应弹 toast', async () => {
    const service = context.service();
    service.initialize();
    service.markVersionReady();

    simulateLongBackgroundResume();
    await flushResumeWithoutDrainingLongTimers();

    expect(context.toast().info).toHaveBeenCalledWith(
      '检测到新版本',
      expect.any(String),
      expect.objectContaining({
        action: expect.objectContaining({
          label: '立即刷新',
          pendingLabel: '正在刷新…',
        }),
      }),
    );
  });

  it('「检测到新版本」prompt: 点击 onClick 失败后应复位抑制 flag，下一次 resume 仍能弹', async () => {
    const service = context.service();
    service.initialize();
    service.markVersionReady();

    simulateLongBackgroundResume();
    await flushResumeWithoutDrainingLongTimers();

    expect(context.toast().info).toHaveBeenCalledTimes(1);
    const firstCall = context.toast().info.mock.calls[0];
    const action = firstCall[2].action;

    // The force-clear-cache module is mocked in the root spec. Throwing here
    // exercises triggerVersionReload's catch path and resets the suppression flag.
    context.reloadViaForceClearCache.mockImplementationOnce(() => {
      throw new Error('reload blocked');
    });

    try {
      await action.onClick();
    } catch {
      // triggerVersionReload catches internally; the click handler should not leak.
    }

    simulateLongBackgroundResume();
    await flushResumeWithoutDrainingLongTimers();

    expect(context.toast().info).toHaveBeenCalledTimes(2);
  });
}
