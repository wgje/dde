import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellSidebarToggleEventController } from './workspace-shell-sidebar-toggle-event.controller';

function createWindowRef() {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function createController(windowRef: ReturnType<typeof createWindowRef> | undefined = createWindowRef()) {
  const toggleSidebar = vi.fn();
  const controller = new WorkspaceShellSidebarToggleEventController({
    getWindow: () => windowRef,
    toggleSidebar,
  });

  return { controller, toggleSidebar, windowRef };
}

describe('WorkspaceShellSidebarToggleEventController', () => {
  it('registers a deduplicated toggle-sidebar listener', () => {
    const { controller, windowRef } = createController();

    controller.setup();

    expect(windowRef?.removeEventListener).toHaveBeenCalledWith('toggle-sidebar', expect.any(Function));
    expect(windowRef?.addEventListener).toHaveBeenCalledWith('toggle-sidebar', expect.any(Function));
  });

  it('continues setup when removing a previous toggle listener fails', () => {
    const { controller, windowRef } = createController();

    controller.setup();
    windowRef?.addEventListener.mockClear();
    windowRef?.removeEventListener.mockImplementationOnce(() => {
      throw new Error('remove stale toggle listener failed');
    });

    expect(() => controller.setup()).not.toThrow();

    expect(windowRef?.addEventListener).toHaveBeenCalledWith(
      'toggle-sidebar',
      expect.any(Function),
    );
  });

  it('continues after add listener failures and allows a later setup retry', () => {
    const { controller, windowRef } = createController();

    windowRef?.addEventListener.mockImplementationOnce(() => {
      throw new Error('add toggle listener failed');
    });

    expect(() => controller.setup()).not.toThrow();

    controller.setup();

    expect(windowRef?.addEventListener).toHaveBeenCalledTimes(2);
    expect(windowRef?.addEventListener).toHaveBeenLastCalledWith(
      'toggle-sidebar',
      expect.any(Function),
    );
  });

  it('toggles sidebar when the global event fires', () => {
    const { controller, toggleSidebar, windowRef } = createController();

    controller.setup();
    const listener = windowRef?.addEventListener.mock.calls[0]?.[1] as EventListener;
    listener(new Event('toggle-sidebar'));

    expect(toggleSidebar).toHaveBeenCalledOnce();
  });

  it('removes the listener during cleanup', () => {
    const { controller, windowRef } = createController();

    controller.cleanup();

    expect(windowRef?.removeEventListener).toHaveBeenCalledWith('toggle-sidebar', expect.any(Function));
  });

  it('does not throw during cleanup when removing the toggle listener fails', () => {
    const { controller, windowRef } = createController();

    controller.setup();
    windowRef?.removeEventListener.mockImplementationOnce(() => {
      throw new Error('remove toggle listener failed');
    });

    expect(() => controller.cleanup()).not.toThrow();
  });

  it('removes the listener from the window that setup actually bound', () => {
    const firstWindowRef = createWindowRef();
    const nextWindowRef = createWindowRef();
    let currentWindowRef = firstWindowRef;
    const controller = new WorkspaceShellSidebarToggleEventController({
      getWindow: () => currentWindowRef,
      toggleSidebar: vi.fn(),
    });

    controller.setup();
    const listener = firstWindowRef.addEventListener.mock.calls[0]?.[1] as EventListener;
    currentWindowRef = nextWindowRef;
    controller.cleanup();

    expect(firstWindowRef.removeEventListener)
      .toHaveBeenNthCalledWith(2, 'toggle-sidebar', listener);
    expect(nextWindowRef.removeEventListener).not.toHaveBeenCalled();
  });

  it('does nothing when window is unavailable', () => {
    const { controller } = createController(undefined);

    expect(() => {
      controller.setup();
      controller.cleanup();
    }).not.toThrow();
  });
});
