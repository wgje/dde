import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FlowOverviewPointerController } from './flow-overview-pointer.controller';
import {
  OverviewBindingsScheduler,
  OverviewViewportUpdateScheduler,
} from './flow-overview-scheduler.helpers';
import {
  cleanupFlowOverview,
  scheduleFlowOverviewIdleUpdateDelayRestore,
  type FlowOverviewCleanupRuntime,
  type FlowOverviewIdleDelayRestoreRuntime,
} from './flow-overview-runtime.helpers';

describe('scheduleFlowOverviewIdleUpdateDelayRestore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears the previous idle restore timer even when the browser timer handle is 0', () => {
    const oldTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    const nextTimer = 4 as unknown as ReturnType<typeof setTimeout>;
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => nextTimer);
    let storedTimer: ReturnType<typeof setTimeout> | null = oldTimer;
    const overview = {} as ReturnType<FlowOverviewIdleDelayRestoreRuntime['getOverview']>;
    const runtime: FlowOverviewIdleDelayRestoreRuntime = {
      getTimer: () => storedTimer,
      setTimer: vi.fn((timer) => {
        storedTimer = timer;
      }),
      isDestroyed: () => false,
      getOverview: () => overview,
      isOverviewBoxDragging: () => false,
      isOverviewInteracting: () => false,
      setOverviewUpdateDelay: vi.fn(),
    };

    scheduleFlowOverviewIdleUpdateDelayRestore(96, runtime);

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(runtime.setTimer).toHaveBeenCalledWith(nextTimer);
    expect(storedTimer).toBe(nextTimer);
  });
});

describe('cleanupFlowOverview', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears the idle restore timer during cleanup even when the browser timer handle is 0', () => {
    const idleTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const setIdleTimer = vi.fn();
    const overviewBindingsScheduler = {
      cancelPendingRefresh: vi.fn(),
    } as unknown as OverviewBindingsScheduler;
    const runtime: FlowOverviewCleanupRuntime = {
      getOverview: () => null,
      setOverview: vi.fn(),
      getDiagram: () => null,
      setOverviewContainer: vi.fn(),
      removePendingInitialLayoutHandler: vi.fn(),
      pointerController: { detach: vi.fn() } as unknown as FlowOverviewPointerController,
      getOverviewResizeObserver: () => null,
      setOverviewResizeObserver: vi.fn(),
      getOverviewDocumentBoundsChangedHandler: () => null,
      setOverviewDocumentBoundsChangedHandler: vi.fn(),
      getOverviewViewportBoundsChangedHandler: () => null,
      setOverviewViewportBoundsChangedHandler: vi.fn(),
      frameCallbacks: {
        viewportPollRafId: null,
        setViewportPollRafId: vi.fn(),
        resizeRefreshRafId: null,
        setResizeRefreshRafId: vi.fn(),
        interactionRefreshRafId: null,
        setInteractionRefreshRafId: vi.fn(),
      },
      overviewViewportUpdateScheduler: {
        cancelAll: vi.fn(),
      } as unknown as OverviewViewportUpdateScheduler,
      overviewBindingsScheduler,
      getOverviewIdleUpdateDelayRestoreTimer: () => idleTimer,
      setOverviewIdleUpdateDelayRestoreTimer: setIdleTimer,
      resetInteractionState: vi.fn(),
      removeOverviewHealHook: vi.fn(),
      clearOverviewBoundsCache: vi.fn(),
      clearOverviewFixedBounds: vi.fn(),
      clearOverviewUpdateCallbacks: vi.fn(),
    };

    cleanupFlowOverview(runtime);

    expect(overviewBindingsScheduler.cancelPendingRefresh).toHaveBeenCalledOnce();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(setIdleTimer).toHaveBeenCalledWith(null);
  });
});
