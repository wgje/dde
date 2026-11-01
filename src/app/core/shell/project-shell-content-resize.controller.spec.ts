import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';

import { ProjectShellContentResizeController } from './project-shell-content-resize.controller';
import type {
  ProjectShellContentResizeAnimationController,
} from './project-shell-content-resize-animation.controller';
import type {
  ProjectShellContentResizeFrameController,
} from './project-shell-content-resize-frame.controller';
import type { UiStateService } from '../../../services/ui-state.service';

function createMouseEvent(clientX: number): MouseEvent {
  return {
    clientX,
    preventDefault: vi.fn(),
  } as unknown as MouseEvent;
}

function createUiState() {
  return {
    isResizing: signal(false),
    isTextColumnCollapsed: signal(false),
    textColumnRatio: signal(50),
  } as unknown as UiStateService;
}

function createControllerWithMain(
  animation?: Pick<
    ProjectShellContentResizeAnimationController,
    'animating' | 'clear' | 'enable'
  >,
  frame?: Pick<ProjectShellContentResizeFrameController, 'clear' | 'schedule'>,
) {
  const uiState = createUiState();
  const controller = new ProjectShellContentResizeController(uiState, animation, frame);

  document.body.innerHTML = '<main style="width: 1000px"></main>';
  Object.defineProperty(document.querySelector('main'), 'clientWidth', {
    configurable: true,
    value: 1000,
  });

  return { controller, uiState };
}

describe('ProjectShellContentResizeController', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('cancels a pending move frame when a new drag starts', () => {
    const queuedFrames: Array<FrameRequestCallback> = [];
    const cancelFrame = vi.fn((id: number) => {
      queuedFrames[id - 1] = () => undefined;
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const { controller, uiState } = createControllerWithMain();

    controller.start(createMouseEvent(0));
    controller.move(createMouseEvent(400));

    controller.start(createMouseEvent(0));
    queuedFrames[0](performance.now());

    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(uiState.textColumnRatio()).toBe(50);
  });

  it('cancels a pending move frame with id 0 during cleanup', () => {
    const queuedFrames: Array<FrameRequestCallback> = [];
    const cancelFrame = vi.fn((id: number) => {
      queuedFrames[id] = () => undefined;
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length - 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const { controller, uiState } = createControllerWithMain();

    controller.start(createMouseEvent(0));
    controller.move(createMouseEvent(400));
    controller.cleanup();
    queuedFrames[0](performance.now());

    expect(cancelFrame).toHaveBeenCalledWith(0);
    expect(uiState.textColumnRatio()).toBe(50);
  });

  it('keeps a pending move frame with id 0 from scheduling another frame', () => {
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      void callback;
      return requestFrame.mock.calls.length - 1;
    });
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { controller } = createControllerWithMain();

    controller.start(createMouseEvent(0));
    controller.move(createMouseEvent(100));
    controller.move(createMouseEvent(200));

    expect(requestFrame).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending move frame with id 0 when a new drag starts', () => {
    const queuedFrames: Array<FrameRequestCallback> = [];
    const cancelFrame = vi.fn((id: number) => {
      queuedFrames[id] = () => undefined;
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length - 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const { controller, uiState } = createControllerWithMain();

    controller.start(createMouseEvent(0));
    controller.move(createMouseEvent(400));
    controller.start(createMouseEvent(0));
    queuedFrames[0](performance.now());

    expect(cancelFrame).toHaveBeenCalledWith(0);
    expect(uiState.textColumnRatio()).toBe(50);
  });

  it('resets resize state and ignores the stale move frame when cleanup cancel fails', () => {
    const queuedFrames: Array<FrameRequestCallback> = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn(() => {
      throw new Error('cancel frame failed');
    }));
    const { controller, uiState } = createControllerWithMain();

    controller.start(createMouseEvent(0));
    controller.move(createMouseEvent(400));

    expect(() => controller.cleanup()).not.toThrow();
    queuedFrames[0](performance.now());

    expect(uiState.isResizing()).toBe(false);
    expect(uiState.textColumnRatio()).toBe(50);
  });

  it('ignores a stale move frame when starting a new drag cannot cancel the old frame', () => {
    const queuedFrames: Array<FrameRequestCallback> = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn(() => {
      throw new Error('cancel frame failed');
    }));
    const { controller, uiState } = createControllerWithMain();

    controller.start(createMouseEvent(0));
    controller.move(createMouseEvent(400));

    expect(() => controller.start(createMouseEvent(0))).not.toThrow();
    queuedFrames[0](performance.now());

    expect(uiState.textColumnRatio()).toBe(50);
  });

  it('falls back to applying the move immediately when frame scheduling fails', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => {
      throw new Error('request frame failed');
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { controller, uiState } = createControllerWithMain();

    controller.start(createMouseEvent(0));

    expect(() => controller.move(createMouseEvent(100))).not.toThrow();
    expect(uiState.textColumnRatio()).toBe(60);
  });

  it('resets collapse animation state when cleanup timer clearing fails', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('clearTimeout', vi.fn(() => {
      throw new Error('clear collapse animation failed');
    }));
    const { controller, uiState } = createControllerWithMain();

    controller.start(createMouseEvent(500));
    controller.move(createMouseEvent(0));

    expect(controller.collapseAnimating()).toBe(true);
    expect(uiState.isTextColumnCollapsed()).toBe(true);
    expect(() => controller.cleanup()).not.toThrow();

    expect(controller.collapseAnimating()).toBe(false);
    expect(uiState.isTextColumnCollapsed()).toBe(true);
  });

  it('keeps collapse state but disables animation when animation timer scheduling fails', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('setTimeout', vi.fn(() => {
      throw new Error('schedule collapse animation failed');
    }));
    const { controller, uiState } = createControllerWithMain();

    controller.start(createMouseEvent(500));

    expect(() => controller.move(createMouseEvent(0))).not.toThrow();

    expect(uiState.textColumnRatio()).toBe(0);
    expect(uiState.isTextColumnCollapsed()).toBe(true);
    expect(controller.collapseAnimating()).toBe(false);
  });

  it('delegates collapse animation state and cleanup to the animation controller', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const animation = {
      animating: signal(false),
      clear: vi.fn(),
      enable: vi.fn(),
    };
    const { controller } = createControllerWithMain(animation);

    controller.start(createMouseEvent(500));
    controller.move(createMouseEvent(0));
    controller.cleanup();

    expect(controller.collapseAnimating).toBe(animation.animating);
    expect(animation.enable).toHaveBeenCalledTimes(1);
    expect(animation.clear).toHaveBeenCalledTimes(1);
  });

  it('delegates move frame scheduling and cleanup to the frame controller', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const frame = {
      clear: vi.fn(),
      schedule: vi.fn(),
    };
    const { controller } = createControllerWithMain(undefined, frame);

    controller.start(createMouseEvent(0));
    controller.move(createMouseEvent(100));
    controller.cleanup();

    expect(frame.schedule).toHaveBeenCalledWith(100);
    expect(frame.clear).toHaveBeenCalledTimes(2);
  });
});
