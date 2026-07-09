import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlowViewMobileInteractionController } from './flow-view-mobile-interaction.controller';

function createController() {
  const detailLayoutTick = signal(0);
  const drawerHeight = signal(16);
  const drawerManualOverride = signal(true);
  const isPaletteOpen = signal(false);
  const isRightPanelOpen = signal(false);
  const selectedTaskId = signal<string | null>('task-1');
  const isMobile = signal(true);
  const activeView = signal<'text' | 'flow'>('flow');
  let destroyed = false;
  const scheduledTimers: Array<() => void> = [];
  const requestUpdate = vi.fn();

  const controller = new FlowViewMobileInteractionController({
    detailLayoutTick,
    diagram: {
      diagramInstance: { requestUpdate },
    } as never,
    drawerHeight,
    drawerManualOverride,
    goBackToText: vi.fn(),
    injector: {} as never,
    isPaletteOpen,
    isRightPanelOpen,
    isDestroyed: () => destroyed,
    loggerDebug: vi.fn(),
    scheduleTimer: (callback) => {
      scheduledTimers.push(callback);
      return scheduledTimers.length as never;
    },
    selectedTaskId,
    swipeGesture: {} as never,
    uiState: {
      activeView,
      isMobile,
    } as never,
  });

  return {
    controller,
    detailLayoutTick,
    drawerHeight,
    drawerManualOverride,
    requestUpdate,
    runScheduledTimer: (index = 0) => scheduledTimers[index]?.(),
    selectedTaskId,
    setDestroyed: (next: boolean) => {
      destroyed = next;
    },
  };
}

describe('FlowViewMobileInteractionController', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not request a diagram update from drawer middle rAF after destroy', () => {
    const rafCallbackRef: { current: FrameRequestCallback | null } = { current: null };
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      rafCallbackRef.current = callback;
      return 1;
    }));
    const {
      controller,
      drawerHeight,
      requestUpdate,
      selectedTaskId,
      setDestroyed,
    } = createController();

    controller.onDrawerStateChange({
      previousLayer: 'top',
      currentLayer: 'middle',
      triggeredBy: 'gesture',
    });
    setDestroyed(true);
    rafCallbackRef.current?.(16);

    expect(selectedTaskId()).toBeNull();
    expect(drawerHeight()).toBe(8);
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it('does not apply a delayed detail layout tick after destroy', () => {
    const { controller, detailLayoutTick, runScheduledTimer, setDestroyed } = createController();

    controller.bumpDetailLayoutTick(50);
    setDestroyed(true);
    runScheduledTimer();

    expect(detailLayoutTick()).toBe(0);
  });
});
