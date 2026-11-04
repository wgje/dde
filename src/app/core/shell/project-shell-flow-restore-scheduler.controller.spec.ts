import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STARTUP_PERF_CONFIG } from '../../../config/startup-performance.config';
import {
  ProjectShellFlowRestoreSchedulerController,
  type ProjectShellFlowRestoreSchedulerControllerOptions,
} from './project-shell-flow-restore-scheduler.controller';

function createOptions(
  overrides: Partial<ProjectShellFlowRestoreSchedulerControllerOptions> = {},
): ProjectShellFlowRestoreSchedulerControllerOptions {
  return {
    activateFlowIntent: vi.fn(),
    flowIntentActivated: () => false,
    reportFlowRestoreMode: vi.fn(),
    setActiveView: vi.fn(),
    setFlowPrefetchOnlyActivated: vi.fn(),
    ...overrides,
  };
}

describe('ProjectShellFlowRestoreSchedulerController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits for the restore delay before entering the browser idle queue', () => {
    const activateFlowIntent = vi.fn();
    const setActiveView = vi.fn();
    const reportFlowRestoreMode = vi.fn();
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 42;
    });
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const controller = new ProjectShellFlowRestoreSchedulerController(createOptions({
      activateFlowIntent,
      reportFlowRestoreMode,
      setActiveView,
    }));

    controller.scheduleFlowIdleRestore('project-1');
    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FLOW_RESTORE_IDLE_DELAY_MS - 1);

    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(activateFlowIntent).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(activateFlowIntent).toHaveBeenCalledWith('restore-idle');
    expect(setActiveView).toHaveBeenCalledWith('flow');
    expect(reportFlowRestoreMode).toHaveBeenCalledWith('applied', {
      reason: 'desktop-idle-restore',
      projectId: 'project-1',
    });
  });

  it('skips desktop idle restore after the user activates Flow', () => {
    const idleWork: { restoreCallback?: IdleRequestCallback } = {};
    let flowIntentActivated = false;
    const activateFlowIntent = vi.fn();
    const setActiveView = vi.fn();
    const reportFlowRestoreMode = vi.fn();
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => {
      idleWork.restoreCallback = callback;
      return 17;
    }));
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const controller = new ProjectShellFlowRestoreSchedulerController(createOptions({
      activateFlowIntent,
      flowIntentActivated: () => flowIntentActivated,
      reportFlowRestoreMode,
      setActiveView,
    }));

    controller.scheduleFlowIdleRestore('project-1');
    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FLOW_RESTORE_IDLE_DELAY_MS);
    flowIntentActivated = true;
    idleWork.restoreCallback?.({ didTimeout: false, timeRemaining: () => 50 });

    expect(activateFlowIntent).not.toHaveBeenCalled();
    expect(setActiveView).not.toHaveBeenCalled();
    expect(reportFlowRestoreMode).not.toHaveBeenCalled();
  });

  it('skips a queued weak-network preload after Flow intent activates', () => {
    let flowIntentActivated = false;
    const setFlowPrefetchOnlyActivated = vi.fn();
    const reportFlowRestoreMode = vi.fn();
    const controller = new ProjectShellFlowRestoreSchedulerController(createOptions({
      flowIntentActivated: () => flowIntentActivated,
      reportFlowRestoreMode,
      setFlowPrefetchOnlyActivated,
    }));

    controller.scheduleWeakNetworkIdlePreload('project-1');
    flowIntentActivated = true;
    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FLOW_IDLE_PRELOAD_DELAY_MS);

    expect(setFlowPrefetchOnlyActivated).not.toHaveBeenCalled();
    expect(reportFlowRestoreMode).not.toHaveBeenCalled();
  });

  it('cancels zero-valued timeout handles', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
    const controller = new ProjectShellFlowRestoreSchedulerController(createOptions());

    controller.scheduleFlowIdleRestore('project-1');
    controller.scheduleWeakNetworkIdlePreload('project-1');
    controller.cancel();

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(clearTimeoutSpy).toHaveBeenNthCalledWith(1, 0);
    expect(clearTimeoutSpy).toHaveBeenNthCalledWith(2, 0);
  });

  it('cancels pending idle work and ignores a late callback after destroy', () => {
    const idleWork: { restoreCallback?: IdleRequestCallback } = {};
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => {
      idleWork.restoreCallback = callback;
      return 0;
    }));
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);
    const activateFlowIntent = vi.fn();
    const controller = new ProjectShellFlowRestoreSchedulerController(createOptions({
      activateFlowIntent,
    }));

    controller.scheduleFlowIdleRestore('project-1');
    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FLOW_RESTORE_IDLE_DELAY_MS);
    controller.destroy();
    idleWork.restoreCallback?.({ didTimeout: false, timeRemaining: () => 50 });

    expect(cancelIdleCallback).toHaveBeenCalledWith(0);
    expect(activateFlowIntent).not.toHaveBeenCalled();
  });
});
