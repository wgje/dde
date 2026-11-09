import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProjectShellContentResizeAnimationController,
} from './project-shell-content-resize-animation.controller';

describe('ProjectShellContentResizeAnimationController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps collapse animation active for the resize transition duration', () => {
    const controller = new ProjectShellContentResizeAnimationController();

    controller.enable();
    vi.advanceTimersByTime(319);

    expect(controller.animating()).toBe(true);

    vi.advanceTimersByTime(1);

    expect(controller.animating()).toBe(false);
  });

  it('restarts the transition window when animation is enabled again', () => {
    const controller = new ProjectShellContentResizeAnimationController();

    controller.enable();
    vi.advanceTimersByTime(100);
    controller.enable();
    vi.advanceTimersByTime(319);

    expect(controller.animating()).toBe(true);

    vi.advanceTimersByTime(1);

    expect(controller.animating()).toBe(false);
  });

  it('invalidates pending animation when timer cleanup fails', () => {
    const controller = new ProjectShellContentResizeAnimationController();
    controller.enable();
    vi.stubGlobal('clearTimeout', vi.fn(() => {
      throw new Error('clear animation failed');
    }));

    expect(() => controller.clear()).not.toThrow();
    expect(controller.animating()).toBe(false);

    vi.advanceTimersByTime(320);

    expect(controller.animating()).toBe(false);
  });

  it('disables animation when timer scheduling fails', () => {
    vi.stubGlobal('setTimeout', vi.fn(() => {
      throw new Error('schedule animation failed');
    }));
    const controller = new ProjectShellContentResizeAnimationController();

    expect(() => controller.enable()).not.toThrow();

    expect(controller.animating()).toBe(false);
  });
});
