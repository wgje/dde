import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellViewportResizeController } from './workspace-shell-viewport-resize.controller';

function createController(options: {
  initialIsMobile?: boolean;
  innerWidth?: number;
  firstTimerId?: number;
} = {}) {
  let isMobile = options.initialIsMobile ?? false;
  let innerWidth = options.innerWidth ?? 1024;
  let scheduledCallback: (() => void) | null = null;
  const scheduledCallbacks = new Map<number, () => void>();
  let nextTimerId = options.firstTimerId ?? 1;
  const setIsMobile = vi.fn((value: boolean) => {
    isMobile = value;
  });
  const setSidebarOpen = vi.fn();
  const setTimeoutFn = vi.fn((callback: () => void, _delay: number) => {
    const timerId = nextTimerId++;
    scheduledCallback = callback;
    scheduledCallbacks.set(timerId, callback);
    return timerId;
  });
  const clearTimeoutFn = vi.fn();
  const controller = new WorkspaceShellViewportResizeController({
    isMobile: () => isMobile,
    setIsMobile,
    setSidebarOpen,
    getWindow: () => ({ innerWidth }),
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    debounceMs: 10,
  });

  return {
    controller,
    clearTimeoutFn,
    runScheduledResize: (timerId?: number) => {
      if (timerId === undefined) {
        scheduledCallback?.();
        return;
      }
      scheduledCallbacks.get(timerId)?.();
    },
    setInnerWidth: (value: number) => {
      innerWidth = value;
    },
    setIsMobile,
    setSidebarOpen,
    setTimeoutFn,
  };
}

describe('WorkspaceShellViewportResizeController', () => {
  it('debounces resize and closes sidebar when viewport crosses from desktop to mobile', () => {
    const { controller, runScheduledResize, setInnerWidth, setIsMobile, setSidebarOpen, setTimeoutFn } = createController({
      initialIsMobile: false,
      innerWidth: 1024,
    });

    setInnerWidth(640);
    controller.handleResize();

    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 10);
    expect(setIsMobile).not.toHaveBeenCalled();

    runScheduledResize();

    expect(setIsMobile).toHaveBeenCalledWith(true);
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it('does not close sidebar for mobile-only resize noise', () => {
    const { controller, runScheduledResize, setInnerWidth, setSidebarOpen } = createController({
      initialIsMobile: true,
      innerWidth: 700,
    });

    setInnerWidth(680);
    controller.handleResize();
    runScheduledResize();

    expect(setSidebarOpen).not.toHaveBeenCalled();
  });

  it('cancels the previous pending resize before scheduling a new one', () => {
    const { clearTimeoutFn, controller } = createController();

    controller.handleResize();
    controller.handleResize();

    expect(clearTimeoutFn).toHaveBeenCalledWith(1);
  });

  it('cancels the previous pending resize when the timer handle is 0', () => {
    const { clearTimeoutFn, controller } = createController({ firstTimerId: 0 });

    controller.handleResize();
    controller.handleResize();

    expect(clearTimeoutFn).toHaveBeenCalledWith(0);
  });

  it('continues scheduling the latest resize when clearing the previous timer fails', () => {
    const {
      clearTimeoutFn,
      controller,
      runScheduledResize,
      setInnerWidth,
      setIsMobile,
      setSidebarOpen,
      setTimeoutFn,
    } = createController({
      initialIsMobile: false,
      innerWidth: 1024,
    });
    clearTimeoutFn.mockImplementationOnce(() => {
      throw new Error('clear timeout failed');
    });

    controller.handleResize();
    setInnerWidth(640);

    expect(() => controller.handleResize()).not.toThrow();

    expect(setTimeoutFn).toHaveBeenCalledTimes(2);
    runScheduledResize(1);
    expect(setIsMobile).not.toHaveBeenCalled();

    runScheduledResize(2);
    expect(setIsMobile).toHaveBeenCalledWith(true);
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it('clears the pending resize timer during cleanup', () => {
    const { clearTimeoutFn, controller } = createController();

    controller.handleResize();
    controller.cleanup();

    expect(clearTimeoutFn).toHaveBeenCalledWith(1);
  });

  it('clears the pending resize timer during cleanup when the timer handle is 0', () => {
    const { clearTimeoutFn, controller } = createController({ firstTimerId: 0 });

    controller.handleResize();
    controller.cleanup();

    expect(clearTimeoutFn).toHaveBeenCalledWith(0);
  });

  it('invalidates the pending resize when cleanup timer clearing fails', () => {
    const { clearTimeoutFn, controller, runScheduledResize, setInnerWidth, setIsMobile } =
      createController({
        initialIsMobile: false,
        innerWidth: 1024,
      });
    clearTimeoutFn.mockImplementationOnce(() => {
      throw new Error('cleanup clear timeout failed');
    });

    controller.handleResize();
    setInnerWidth(640);

    expect(() => controller.cleanup()).not.toThrow();
    runScheduledResize(1);

    expect(setIsMobile).not.toHaveBeenCalled();
  });

  it('falls back to immediate viewport sync when debounce scheduling fails', () => {
    const { controller, setInnerWidth, setIsMobile, setSidebarOpen, setTimeoutFn } =
      createController({
        initialIsMobile: false,
        innerWidth: 1024,
      });
    setTimeoutFn.mockImplementationOnce(() => {
      throw new Error('schedule resize failed');
    });

    setInnerWidth(640);

    expect(() => controller.handleResize()).not.toThrow();
    expect(setIsMobile).toHaveBeenCalledWith(true);
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it('ignores stale debounce callbacks so cleanup still clears the latest timer', () => {
    const { clearTimeoutFn, controller, runScheduledResize } = createController();

    controller.handleResize();
    controller.handleResize();
    runScheduledResize(1);
    controller.cleanup();

    expect(clearTimeoutFn).toHaveBeenCalledWith(1);
    expect(clearTimeoutFn).toHaveBeenCalledWith(2);
  });

  it('clears the fired debounce timer when resize state update throws', () => {
    const { clearTimeoutFn, controller, runScheduledResize, setInnerWidth, setIsMobile } = createController({
      initialIsMobile: false,
      innerWidth: 1024,
    });
    const updateError = new Error('isMobile update failed');
    setIsMobile.mockImplementationOnce(() => {
      throw updateError;
    });

    setInnerWidth(640);
    controller.handleResize();

    expect(() => runScheduledResize()).toThrow(updateError);
    controller.cleanup();

    expect(clearTimeoutFn).not.toHaveBeenCalledWith(1);
  });
});
