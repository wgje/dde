import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellTouchGestureLazyHostController,
} from './workspace-shell-touch-gesture-lazy-host.controller';
import type {
  WorkspaceShellTouchGestureControllerLike,
} from './workspace-shell-touch-gesture-lazy-load.controller';

function createTouchGestureControllerLike(): WorkspaceShellTouchGestureControllerLike {
  return {
    onMainTouchEnd: vi.fn(),
    onMainTouchMove: vi.fn(),
    onMainTouchStart: vi.fn(),
    onSidebarTouchEnd: vi.fn(),
    onSidebarTouchMove: vi.fn(),
    onSidebarTouchStart: vi.fn(),
  };
}

function createHost(overrides: {
  createTouchGestureController?: () => Promise<WorkspaceShellTouchGestureControllerLike>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const controller = createTouchGestureControllerLike();
  const createTouchGestureController = overrides.createTouchGestureController
    ?? vi.fn().mockResolvedValue(controller);
  const warn = overrides.warn ?? vi.fn();
  const host = new WorkspaceShellTouchGestureLazyHostController({
    activeView: () => 'text',
    createTouchGestureController,
    isMobile: () => true,
    setSidebarOpen: vi.fn(),
    warn,
  });

  return { controller, createTouchGestureController, host, warn };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('WorkspaceShellTouchGestureLazyHostController', () => {
  it('loads the touch gesture controller once and forwards queued gesture actions', async () => {
    const { controller, createTouchGestureController, host } = createHost();
    const firstEvent = {} as TouchEvent;
    const secondEvent = {} as TouchEvent;

    host.run(gesture => gesture.onMainTouchStart(firstEvent));
    host.run(gesture => gesture.onSidebarTouchMove(secondEvent));
    await flushMicrotasks();

    expect(createTouchGestureController).toHaveBeenCalledTimes(1);
    expect(controller.onMainTouchStart).toHaveBeenCalledWith(firstEvent);
    expect(controller.onSidebarTouchMove).toHaveBeenCalledWith(secondEvent);
  });

  it('warns with the load failure message and keeps gestures retryable after a load failure', async () => {
    const error = new Error('touch gesture chunk missing');
    const controller = createTouchGestureControllerLike();
    const createTouchGestureController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(controller);
    const { host, warn } = createHost({ createTouchGestureController });

    host.run(gesture => gesture.onMainTouchStart({} as TouchEvent));
    await flushMicrotasks();
    host.run(gesture => gesture.onMainTouchStart({} as TouchEvent));
    await flushMicrotasks();

    expect(createTouchGestureController).toHaveBeenCalledTimes(2);
    expect(controller.onMainTouchStart).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('触摸手势控制器懒加载失败，已跳过本次手势', error);
  });

  it('warns with the operation failure message when a loaded gesture action throws', async () => {
    const error = new Error('gesture handler failed');
    const { host, warn } = createHost();

    host.run(() => {
      throw error;
    });
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith('触摸手势控制器手势处理失败，已跳过本次手势', error);
    expect(warn).not.toHaveBeenCalledWith('触摸手势控制器懒加载失败，已跳过本次手势', error);
  });

  it('does not throw when the gesture loader fails synchronously', async () => {
    const error = new Error('gesture loader unavailable');
    const createTouchGestureController = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      });
    const { host, warn } = createHost({ createTouchGestureController });

    expect(() => host.run(gesture => gesture.onMainTouchEnd({} as TouchEvent))).not.toThrow();
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith('触摸手势控制器懒加载失败，已跳过本次手势', error);
  });
});
