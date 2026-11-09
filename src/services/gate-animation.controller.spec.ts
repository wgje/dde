import { afterEach, describe, expect, it, vi } from 'vitest';

import { GateAnimationController, type GateAnimationControllerOptions, type GateMotionState } from './gate-animation.controller';

function createControllerOptions(animation: { value: GateMotionState }): GateAnimationControllerOptions {
  return {
    getAnimation: vi.fn(() => animation.value),
    setAnimation: vi.fn((state: GateMotionState) => {
      animation.value = state;
    }),
    prefersReducedMotion: vi.fn(() => false),
    run: vi.fn(callback => callback()),
    debug: vi.fn(),
    warn: vi.fn(),
  };
}

describe('GateAnimationController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clear 应清理 handle 为 0 的动画启动兜底 timer', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const animation = { value: 'idle' as GateMotionState };
    const controller = new GateAnimationController(createControllerOptions(animation));

    controller.setWithTimeout('entering');
    controller.clear();

    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(animation.value).toBe('entering');
  });

  it('notifyStarted 应先清理 handle 为 0 的启动 timer 再安排时长兜底 timer', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockReturnValueOnce(0 as unknown as ReturnType<typeof setTimeout>)
      .mockReturnValueOnce(17 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const animation = { value: 'idle' as GateMotionState };
    const controller = new GateAnimationController(createControllerOptions(animation));

    controller.setWithTimeout('entering');
    controller.notifyStarted('entering');

    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });
});
