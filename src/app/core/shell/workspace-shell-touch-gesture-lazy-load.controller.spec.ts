import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellTouchGestureLazyLoadController,
  type WorkspaceShellTouchGestureControllerLike,
} from './workspace-shell-touch-gesture-lazy-load.controller';

function touchEvent(): TouchEvent {
  return {} as TouchEvent;
}

function readTouchGestureLazyLoadControllerSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-touch-gesture-lazy-load.controller.ts'),
    'utf8',
  );
}

function readTouchGestureLazyHostControllerSource(): string {
  try {
    return readFileSync(
      join(process.cwd(), 'src/app/core/shell/workspace-shell-touch-gesture-lazy-host.controller.ts'),
      'utf8',
    );
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return '';
    }

    throw error;
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

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

function createController(overrides: {
  isMobile?: () => boolean;
  createTouchGestureController?: () => Promise<WorkspaceShellTouchGestureControllerLike>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const touchGesture = createTouchGestureControllerLike();
  const warn = overrides.warn ?? vi.fn();
  const createTouchGestureControllerFn = overrides.createTouchGestureController
    ?? vi.fn().mockResolvedValue(touchGesture);
  const controller = new WorkspaceShellTouchGestureLazyLoadController({
    activeView: () => 'text',
    createTouchGestureController: createTouchGestureControllerFn,
    isMobile: overrides.isMobile ?? (() => true),
    setSidebarOpen: vi.fn(),
    warn,
  });

  return { controller, createTouchGestureController: createTouchGestureControllerFn, touchGesture, warn };
}

describe('WorkspaceShellTouchGestureLazyLoadController', () => {
  it('keeps concrete touch gesture loading behind the named lazy host controller', () => {
    const lazyLoadSource = readTouchGestureLazyLoadControllerSource();
    const lazyHostSource = readTouchGestureLazyHostControllerSource();

    expect(lazyLoadSource).toContain('WorkspaceShellTouchGestureLazyHostController');
    expect(lazyLoadSource).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(lazyLoadSource).not.toContain('workspace-shell-lazy-delegate-call-host.controller');
    expect(lazyLoadSource).not.toContain('createWorkspaceShellTouchGestureControllerLoader');
    expect(lazyLoadSource).not.toContain("import('./workspace-shell-touch-gesture.controller')");
    expect(lazyLoadSource).not.toContain('new WorkspaceShellTouchGestureController');
    expect(lazyHostSource).toContain('createWorkspaceShellTouchGestureControllerLoader');
  });

  it('does not load the touch gesture controller outside mobile viewports', () => {
    const { controller, createTouchGestureController } = createController({
      isMobile: () => false,
    });

    controller.onMainTouchStart(touchEvent());

    expect(createTouchGestureController).not.toHaveBeenCalled();
  });

  it('loads the touch gesture controller once while gesture handlers are in flight', async () => {
    const mainEvent = touchEvent();
    const sidebarEvent = touchEvent();
    const touchGesture = createTouchGestureControllerLike();
    const deferred = createDeferred<WorkspaceShellTouchGestureControllerLike>();
    const { controller, createTouchGestureController } = createController({
      createTouchGestureController: vi.fn(() => deferred.promise),
    });

    controller.onMainTouchStart(mainEvent);
    controller.onSidebarTouchStart(sidebarEvent);

    expect(createTouchGestureController).toHaveBeenCalledTimes(1);
    deferred.resolve(touchGesture);
    await flushMicrotasks();

    expect(touchGesture.onMainTouchStart).toHaveBeenCalledWith(mainEvent);
    expect(touchGesture.onSidebarTouchStart).toHaveBeenCalledWith(sidebarEvent);
  });

  it('warns and allows retrying after the gesture controller load fails', async () => {
    const error = { message: 'chunk unavailable' };
    const touchGesture = createTouchGestureControllerLike();
    const { controller, createTouchGestureController, warn } = createController({
      createTouchGestureController: vi.fn()
        .mockImplementationOnce(() => Promise.resolve().then(() => {
          throw error;
        }))
        .mockResolvedValueOnce(touchGesture),
    });

    controller.onMainTouchStart(touchEvent());
    await flushMicrotasks();
    controller.onMainTouchStart(touchEvent());
    await flushMicrotasks();

    expect(createTouchGestureController).toHaveBeenCalledTimes(2);
    expect(touchGesture.onMainTouchStart).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('触摸手势控制器懒加载失败，已跳过本次手势', error);
  });

  it('warns and allows retrying after the gesture controller loader throws synchronously', async () => {
    const error = new Error('gesture loader unavailable');
    const touchGesture = createTouchGestureControllerLike();
    const { controller, createTouchGestureController, warn } = createController({
      createTouchGestureController: vi.fn()
        .mockImplementationOnce(() => {
          throw error;
        })
        .mockResolvedValueOnce(touchGesture),
    });

    expect(() => controller.onMainTouchStart(touchEvent())).not.toThrow();
    await flushMicrotasks();

    controller.onMainTouchStart(touchEvent());
    await flushMicrotasks();

    expect(createTouchGestureController).toHaveBeenCalledTimes(2);
    expect(touchGesture.onMainTouchStart).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('触摸手势控制器懒加载失败，已跳过本次手势', error);
  });

  it('warns with the operation failure message when a loaded gesture handler fails', async () => {
    const error = new Error('gesture handler failed');
    const touchGesture = createTouchGestureControllerLike();
    touchGesture.onMainTouchMove = vi.fn(() => {
      throw error;
    });
    const { controller, warn } = createController({
      createTouchGestureController: vi.fn().mockResolvedValue(touchGesture),
    });

    controller.onMainTouchMove(touchEvent());
    await flushMicrotasks();

    expect(touchGesture.onMainTouchMove).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '触摸手势控制器手势处理失败，已跳过本次手势',
      error,
    );
    expect(warn).not.toHaveBeenCalledWith(
      '触摸手势控制器懒加载失败，已跳过本次手势',
      error,
    );
  });
});
