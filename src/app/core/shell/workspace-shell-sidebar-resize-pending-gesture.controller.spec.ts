import { describe, expect, it } from 'vitest';

import {
  WorkspaceShellSidebarResizePendingGestureController,
} from './workspace-shell-sidebar-resize-pending-gesture.controller';

describe('WorkspaceShellSidebarResizePendingGestureController', () => {
  it('tracks whether a resize is pending before the real host is loaded', () => {
    const controller = new WorkspaceShellSidebarResizePendingGestureController();

    expect(controller.isResizingAny(false)).toBe(false);

    const gesture = controller.start();

    expect(controller.isResizingAny(false)).toBe(true);
    expect(controller.isCurrent(gesture)).toBe(true);

    controller.finish(gesture, true);
    expect(controller.isResizingAny(false)).toBe(true);

    controller.finish(gesture, false);
    expect(controller.isResizingAny(false)).toBe(false);
  });

  it('does not let a stale cancelled gesture clear a newer pending resize', () => {
    const controller = new WorkspaceShellSidebarResizePendingGestureController();

    const first = controller.start();
    controller.cancel();
    const second = controller.start();

    controller.finish(first, false);

    expect(controller.isCurrent(first)).toBe(false);
    expect(controller.isCurrent(second)).toBe(true);
    expect(controller.isResizingAny(false)).toBe(true);
  });

  it('turns teardown into a terminal state for future resize activity', () => {
    const controller = new WorkspaceShellSidebarResizePendingGestureController();

    const gesture = controller.start();
    controller.teardown();
    controller.finish(gesture, true);

    expect(controller.isTornDown()).toBe(true);
    expect(controller.isCurrent(gesture)).toBe(false);
    expect(controller.isResizingAny(true)).toBe(false);
    expect(controller.start()).toBeNull();
  });
});
