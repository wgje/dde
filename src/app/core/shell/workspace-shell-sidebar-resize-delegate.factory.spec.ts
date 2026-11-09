import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellSidebarResizeDelegate,
  createWorkspaceShellSidebarResizeNoopDelegate,
  type WorkspaceShellSidebarResizeServiceLike,
} from './workspace-shell-sidebar-resize-delegate.factory';

function createMouseEvent(): MouseEvent {
  return {} as MouseEvent;
}

function createService(
  overrides: Partial<WorkspaceShellSidebarResizeServiceLike> = {},
): WorkspaceShellSidebarResizeServiceLike {
  return {
    isResizingAny: vi.fn(() => true),
    onMouseMove: vi.fn(),
    onMouseUp: vi.fn(),
    startContent: vi.fn(),
    startSidebar: vi.fn(),
    teardown: vi.fn(),
    ...overrides,
  };
}

describe('workspace shell sidebar resize delegate factory', () => {
  it('adapts the resize service to the shell resize delegate contract', () => {
    const service = createService();
    const delegate = createWorkspaceShellSidebarResizeDelegate({
      destroyed: () => false,
      service,
    });
    const sidebarEvent = createMouseEvent();
    const contentEvent = createMouseEvent();
    const moveEvent = createMouseEvent();

    expect(delegate.isResizingAny()).toBe(true);
    delegate.startSidebarResize(sidebarEvent);
    delegate.startContentResize(contentEvent);
    delegate.onMouseMove(moveEvent);
    delegate.onMouseUp();
    delegate.teardown();

    expect(service.startSidebar).toHaveBeenCalledWith(sidebarEvent);
    expect(service.startContent).toHaveBeenCalledWith(contentEvent);
    expect(service.onMouseMove).toHaveBeenCalledWith(moveEvent);
    expect(service.onMouseUp).toHaveBeenCalledTimes(1);
    expect(service.teardown).toHaveBeenCalledTimes(1);
  });

  it('tears down the resolved service and returns a noop delegate after destroy', () => {
    const service = createService();
    const delegate = createWorkspaceShellSidebarResizeDelegate({
      destroyed: () => true,
      service,
    });

    delegate.startSidebarResize(createMouseEvent());
    delegate.startContentResize(createMouseEvent());
    delegate.onMouseMove(createMouseEvent());
    delegate.onMouseUp();
    delegate.teardown();

    expect(service.teardown).toHaveBeenCalledTimes(1);
    expect(service.startSidebar).not.toHaveBeenCalled();
    expect(service.startContent).not.toHaveBeenCalled();
    expect(service.onMouseMove).not.toHaveBeenCalled();
    expect(service.onMouseUp).not.toHaveBeenCalled();
    expect(delegate.isResizingAny()).toBe(false);
  });

  it('creates a noop delegate for cancelled lazy-load gestures', () => {
    const delegate = createWorkspaceShellSidebarResizeNoopDelegate();

    delegate.startSidebarResize(createMouseEvent());
    delegate.startContentResize(createMouseEvent());
    delegate.onMouseMove(createMouseEvent());
    delegate.onMouseUp();
    delegate.teardown();

    expect(delegate.isResizingAny()).toBe(false);
  });
});
