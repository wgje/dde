import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSidebarResizeDelegateHostController,
  type WorkspaceShellSidebarResizeDelegateHostDelegate,
} from './workspace-shell-sidebar-resize-delegate-host.controller';

function createMouseEvent(): MouseEvent {
  return {
    preventDefault: vi.fn(),
  } as unknown as MouseEvent;
}

function createDelegate(): WorkspaceShellSidebarResizeDelegateHostDelegate {
  return {
    isResizingAny: vi.fn(() => true),
    onMouseMove: vi.fn(),
    onMouseUp: vi.fn(),
    startContentResize: vi.fn(),
    startSidebarResize: vi.fn(),
    teardown: vi.fn(),
  };
}

describe('WorkspaceShellSidebarResizeDelegateHostController', () => {
  it('does not forward resize gestures after the shell is destroyed', () => {
    const delegate = createDelegate();
    const controller = new WorkspaceShellSidebarResizeDelegateHostController({
      delegate,
      destroyed: () => true,
    });
    const event = createMouseEvent();

    controller.startSidebarResize(event);
    controller.startContentResize(event);
    controller.onMouseMove(event);
    controller.onMouseUp();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(delegate.startSidebarResize).not.toHaveBeenCalled();
    expect(delegate.startContentResize).not.toHaveBeenCalled();
    expect(delegate.onMouseMove).not.toHaveBeenCalled();
    expect(delegate.onMouseUp).not.toHaveBeenCalled();
    expect(controller.isResizingAny()).toBe(false);
  });

  it('forwards resize gestures to the loaded delegate while the shell is alive', () => {
    const delegate = createDelegate();
    const controller = new WorkspaceShellSidebarResizeDelegateHostController({
      delegate,
      destroyed: () => false,
    });
    const sidebarEvent = createMouseEvent();
    const contentEvent = createMouseEvent();
    const moveEvent = createMouseEvent();

    controller.startSidebarResize(sidebarEvent);
    controller.startContentResize(contentEvent);
    controller.onMouseMove(moveEvent);
    controller.onMouseUp();

    expect(delegate.startSidebarResize).toHaveBeenCalledWith(sidebarEvent);
    expect(delegate.startContentResize).toHaveBeenCalledWith(contentEvent);
    expect(delegate.onMouseMove).toHaveBeenCalledWith(moveEvent);
    expect(delegate.onMouseUp).toHaveBeenCalledTimes(1);
    expect(controller.isResizingAny()).toBe(true);
  });

  it('keeps host setup and teardown concerns outside resize callers', () => {
    const delegate = createDelegate();
    const record: string[] = [];
    const controller = new WorkspaceShellSidebarResizeDelegateHostController({
      delegate,
      destroyed: () => false,
      setup: () => record.push('setup'),
      teardown: () => record.push('host.teardown'),
    });
    vi.mocked(delegate.teardown).mockImplementation(() => record.push('delegate.teardown'));

    controller.setup();
    controller.teardown();

    expect(record).toEqual([
      'setup',
      'host.teardown',
      'delegate.teardown',
    ]);
  });
});
