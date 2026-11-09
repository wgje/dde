import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellTouchGestureControllerLoader,
} from './workspace-shell-touch-gesture-controller-loader.factory';
import type {
  WorkspaceShellTouchGestureControllerLike,
} from './workspace-shell-touch-gesture-lazy-load.controller';

function createTouchGestureDelegate(): WorkspaceShellTouchGestureControllerLike {
  return {
    onMainTouchEnd: vi.fn(),
    onMainTouchMove: vi.fn(),
    onMainTouchStart: vi.fn(),
    onSidebarTouchEnd: vi.fn(),
    onSidebarTouchMove: vi.fn(),
    onSidebarTouchStart: vi.fn(),
  };
}

function touchEvent(
  touches: Array<Pick<Touch, 'clientX' | 'clientY'>>,
  changedTouches = touches,
): TouchEvent {
  return { touches, changedTouches } as unknown as TouchEvent;
}

describe('createWorkspaceShellTouchGestureControllerLoader', () => {
  it('uses the provided touch gesture controller loader', async () => {
    const touchGesture = createTouchGestureDelegate();
    const createTouchGestureController = vi.fn().mockResolvedValue(touchGesture);
    const loadController = createWorkspaceShellTouchGestureControllerLoader({
      activeView: () => 'text',
      createTouchGestureController,
      isMobile: () => true,
      setSidebarOpen: vi.fn(),
    });

    await expect(loadController()).resolves.toBe(touchGesture);

    expect(createTouchGestureController).toHaveBeenCalledOnce();
  });

  it('creates the default touch gesture controller lazily', async () => {
    const setSidebarOpen = vi.fn();
    const loadController = createWorkspaceShellTouchGestureControllerLoader({
      activeView: () => 'text',
      isMobile: () => true,
      setSidebarOpen,
    });

    const controller = await loadController();
    controller.onMainTouchStart(touchEvent([{ clientX: 0, clientY: 0 }]));
    controller.onMainTouchMove(touchEvent([{ clientX: 120, clientY: 5 }]));
    controller.onMainTouchEnd(touchEvent([], [{ clientX: 120, clientY: 5 }]));

    expect(setSidebarOpen).toHaveBeenCalledWith(true);
  });
});
