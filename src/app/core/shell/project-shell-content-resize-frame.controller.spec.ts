import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ProjectShellContentResizeFrameController,
} from './project-shell-content-resize-frame.controller';

describe('ProjectShellContentResizeFrameController', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('coalesces move requests while a frame is pending', () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length - 1;
    });
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const applyMove = vi.fn();
    const controller = new ProjectShellContentResizeFrameController({ applyMove });

    controller.schedule(100);
    controller.schedule(200);
    queuedFrames[0](performance.now());

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(applyMove).toHaveBeenCalledOnce();
    expect(applyMove).toHaveBeenCalledWith(100);
  });

  it('invalidates a zero-valued frame handle when cancellation fails', () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const cancelFrame = vi.fn(() => {
      throw new Error('cancel frame failed');
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return 0;
    }));
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const applyMove = vi.fn();
    const controller = new ProjectShellContentResizeFrameController({ applyMove });

    controller.schedule(100);

    expect(() => controller.clear()).not.toThrow();
    queuedFrames[0](performance.now());

    expect(cancelFrame).toHaveBeenCalledWith(0);
    expect(applyMove).not.toHaveBeenCalled();
  });

  it('applies the move immediately when frame scheduling fails', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => {
      throw new Error('request frame failed');
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const applyMove = vi.fn();
    const controller = new ProjectShellContentResizeFrameController({ applyMove });

    expect(() => controller.schedule(100)).not.toThrow();

    expect(applyMove).toHaveBeenCalledWith(100);
  });

  it('accepts another move after the pending frame is applied', () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const applyMove = vi.fn();
    const controller = new ProjectShellContentResizeFrameController({ applyMove });

    controller.schedule(100);
    queuedFrames[0](performance.now());
    controller.schedule(200);
    queuedFrames[1](performance.now());

    expect(requestFrame).toHaveBeenCalledTimes(2);
    expect(applyMove).toHaveBeenNthCalledWith(1, 100);
    expect(applyMove).toHaveBeenNthCalledWith(2, 200);
  });
});
