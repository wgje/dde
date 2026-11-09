import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellTouchGestureController } from './workspace-shell-touch-gesture.controller';

function touchEvent(
  touches: Array<{ clientX: number; clientY: number }>,
  changedTouches: Array<{ clientX: number; clientY: number }> = touches,
): TouchEvent {
  return {
    touches,
    changedTouches,
  } as unknown as TouchEvent;
}

function createController(options: {
  mobile?: boolean;
  activeView?: 'text' | 'flow';
} = {}) {
  const setSidebarOpen = vi.fn();
  const controller = new WorkspaceShellTouchGestureController({
    isMobile: () => options.mobile ?? true,
    activeView: () => options.activeView ?? 'text',
    setSidebarOpen,
  });

  return { controller, setSidebarOpen };
}

describe('WorkspaceShellTouchGestureController', () => {
  it('closes the sidebar for a horizontal left swipe on mobile', () => {
    const { controller, setSidebarOpen } = createController();

    controller.onSidebarTouchStart(touchEvent([{ clientX: 200, clientY: 40 }]));
    controller.onSidebarTouchMove(touchEvent([{ clientX: 120, clientY: 48 }]));
    controller.onSidebarTouchEnd(touchEvent([], [{ clientX: 120, clientY: 48 }]));

    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it('ignores sidebar gestures that are vertical or below threshold', () => {
    const { controller, setSidebarOpen } = createController();

    controller.onSidebarTouchStart(touchEvent([{ clientX: 200, clientY: 40 }]));
    controller.onSidebarTouchMove(touchEvent([{ clientX: 175, clientY: 120 }]));
    controller.onSidebarTouchEnd(touchEvent([], [{ clientX: 100, clientY: 120 }]));

    expect(setSidebarOpen).not.toHaveBeenCalled();
  });

  it('opens the sidebar for a horizontal right swipe on the main text view', () => {
    const { controller, setSidebarOpen } = createController({ activeView: 'text' });

    controller.onMainTouchStart(touchEvent([{ clientX: 20, clientY: 40 }]));
    controller.onMainTouchMove(touchEvent([{ clientX: 100, clientY: 46 }]));
    controller.onMainTouchEnd(touchEvent([], [{ clientX: 100, clientY: 46 }]));

    expect(setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it('does not open the sidebar from the flow view or desktop viewport', () => {
    const flow = createController({ activeView: 'flow' });
    flow.controller.onMainTouchStart(touchEvent([{ clientX: 20, clientY: 40 }]));
    flow.controller.onMainTouchMove(touchEvent([{ clientX: 100, clientY: 46 }]));
    flow.controller.onMainTouchEnd(touchEvent([], [{ clientX: 100, clientY: 46 }]));
    expect(flow.setSidebarOpen).not.toHaveBeenCalled();

    const desktop = createController({ mobile: false, activeView: 'text' });
    desktop.controller.onMainTouchStart(touchEvent([{ clientX: 20, clientY: 40 }]));
    desktop.controller.onMainTouchMove(touchEvent([{ clientX: 100, clientY: 46 }]));
    desktop.controller.onMainTouchEnd(touchEvent([], [{ clientX: 100, clientY: 46 }]));
    expect(desktop.setSidebarOpen).not.toHaveBeenCalled();
  });
});
