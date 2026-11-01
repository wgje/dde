import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STARTUP_PERF_CONFIG } from '../../../config/startup-performance.config';
import {
  ProjectShellFlowRestoreController,
  type ProjectShellFlowRestoreControllerOptions,
} from './project-shell-flow-restore.controller';

function createControllerOptions(
  overrides: Partial<ProjectShellFlowRestoreControllerOptions> = {},
): ProjectShellFlowRestoreControllerOptions {
  return {
    flowStateAwareRestoreEnabled: true,
    flowIntentActivated: () => false,
    flowPrefetchOnlyActivated: {
      set: vi.fn(),
    },
    uiState: {
      isMobile: () => false,
      activeView: {
        set: vi.fn(),
      },
      getLastActiveView: () => null,
      persistActiveView: vi.fn(),
    },
    activateFlowIntent: vi.fn(),
    ...overrides,
  };
}

describe('ProjectShellFlowRestoreController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps mobile root restore in Text even when state-aware restore is disabled', () => {
    const activeViewSet = vi.fn();
    const setPrefetchOnly = vi.fn();
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');
    const controller = new ProjectShellFlowRestoreController(createControllerOptions({
      flowStateAwareRestoreEnabled: false,
      flowPrefetchOnlyActivated: {
        set: setPrefetchOnly,
      },
      uiState: {
        isMobile: () => true,
        activeView: {
          set: activeViewSet,
        },
        getLastActiveView: () => null,
        persistActiveView: vi.fn(),
      },
    }));

    controller.applyStateAwareFlowRestore('/projects/project-1', 'project-1');

    expect(setPrefetchOnly).toHaveBeenCalledWith(false);
    expect(activeViewSet).toHaveBeenCalledWith('text');
    expect(dispatchEventSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'nanoflow:flow-restore-status',
    }));
  });

  it('activates Flow immediately for desktop root restore when state-aware restore is disabled', () => {
    const setPrefetchOnly = vi.fn();
    const activateFlowIntent = vi.fn();
    const activeViewSet = vi.fn();
    const controller = new ProjectShellFlowRestoreController(createControllerOptions({
      flowStateAwareRestoreEnabled: false,
      flowPrefetchOnlyActivated: {
        set: setPrefetchOnly,
      },
      uiState: {
        isMobile: () => false,
        activeView: {
          set: activeViewSet,
        },
        getLastActiveView: () => null,
        persistActiveView: vi.fn(),
      },
      activateFlowIntent,
    }));

    controller.applyStateAwareFlowRestore('/projects/project-1', 'project-1');

    expect(setPrefetchOnly).toHaveBeenCalledWith(false);
    expect(activateFlowIntent).toHaveBeenCalledWith('route');
    expect(activeViewSet).toHaveBeenCalledWith('flow');
  });

  it('does not let an immediate requestIdleCallback bypass the Flow restore delay', () => {
    const activateFlowIntent = vi.fn();
    const activeViewSet = vi.fn();
    const persistActiveView = vi.fn();
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 42;
    });
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: requestIdleCallback,
    });
    Object.defineProperty(window, 'cancelIdleCallback', {
      configurable: true,
      value: vi.fn(),
    });
    const controller = new ProjectShellFlowRestoreController(createControllerOptions({
      flowStateAwareRestoreEnabled: true,
      activateFlowIntent,
      uiState: {
        isMobile: () => false,
        activeView: {
          set: activeViewSet,
        },
        getLastActiveView: () => 'flow',
        persistActiveView,
      },
    }));

    controller.applyStateAwareFlowRestore('/projects/project-1', 'project-1');
    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FLOW_RESTORE_IDLE_DELAY_MS - 1);

    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(activateFlowIntent).not.toHaveBeenCalled();
    expect(activeViewSet).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(activateFlowIntent).toHaveBeenCalledWith('restore-idle');
    expect(activeViewSet).toHaveBeenCalledWith('flow');
    expect(persistActiveView).toHaveBeenCalledWith('flow');
  });

  it('cancels zero-valued restore and preload timer handles', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
    const flowRestoreController = new ProjectShellFlowRestoreController(createControllerOptions({
      uiState: {
        isMobile: () => false,
        activeView: {
          set: vi.fn(),
        },
        getLastActiveView: () => 'flow',
        persistActiveView: vi.fn(),
      },
    }));

    flowRestoreController.applyStateAwareFlowRestore('/projects/project-1', 'project-1');
    flowRestoreController.cancelFlowStateAwareTimers();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);

    clearTimeoutSpy.mockClear();
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: {
        effectiveType: '2g',
      },
    });
    const weakNetworkPreloadController = new ProjectShellFlowRestoreController(createControllerOptions({
      uiState: {
        isMobile: () => false,
        activeView: {
          set: vi.fn(),
        },
        getLastActiveView: () => 'flow',
        persistActiveView: vi.fn(),
      },
    }));

    weakNetworkPreloadController.applyStateAwareFlowRestore('/projects/project-2', 'project-2');
    weakNetworkPreloadController.cancelFlowStateAwareTimers();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('uses weak-network idle preload without activating Flow immediately', () => {
    const activateFlowIntent = vi.fn();
    const activeViewSet = vi.fn();
    const setPrefetchOnly = vi.fn();
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: {
        effectiveType: '2g',
      },
    });
    const controller = new ProjectShellFlowRestoreController(createControllerOptions({
      flowStateAwareRestoreEnabled: true,
      flowPrefetchOnlyActivated: {
        set: setPrefetchOnly,
      },
      activateFlowIntent,
      uiState: {
        isMobile: () => false,
        activeView: {
          set: activeViewSet,
        },
        getLastActiveView: () => 'flow',
        persistActiveView: vi.fn(),
      },
    }));

    controller.applyStateAwareFlowRestore('/projects/project-1', 'project-1');

    expect(activeViewSet).toHaveBeenCalledWith('text');
    expect(activateFlowIntent).not.toHaveBeenCalled();

    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FLOW_IDLE_PRELOAD_DELAY_MS);

    expect(setPrefetchOnly).toHaveBeenLastCalledWith(true);
  });

  it('delegates weak-network deferred work and lifecycle cleanup to the scheduler', () => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: {
        effectiveType: '2g',
      },
    });
    const scheduler = {
      cancel: vi.fn(),
      destroy: vi.fn(),
      scheduleFlowIdleRestore: vi.fn(),
      scheduleWeakNetworkIdlePreload: vi.fn(),
    };
    const controller = new ProjectShellFlowRestoreController(createControllerOptions({
      scheduler,
      uiState: {
        isMobile: () => false,
        activeView: {
          set: vi.fn(),
        },
        getLastActiveView: () => 'flow',
        persistActiveView: vi.fn(),
      },
    }));

    controller.applyStateAwareFlowRestore('/projects/project-1', 'project-1');
    expect(scheduler.scheduleWeakNetworkIdlePreload).toHaveBeenCalledWith('project-1');

    scheduler.cancel.mockClear();
    controller.cancelFlowStateAwareTimers();
    controller.destroy();

    expect(scheduler.cancel).toHaveBeenCalledTimes(1);
    expect(scheduler.destroy).toHaveBeenCalledTimes(1);
  });
});
