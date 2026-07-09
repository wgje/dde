import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellInteractionTouchGesturesHostLoader,
  type WorkspaceShellInteractionTouchGesturesHostLike,
} from './workspace-shell-interaction-touch-gestures-host-loader.factory';

function createTouchGestures(): WorkspaceShellInteractionTouchGesturesHostLike {
  return {
    onMainTouchEnd: vi.fn(),
    onMainTouchMove: vi.fn(),
    onMainTouchStart: vi.fn(),
    onSidebarTouchEnd: vi.fn(),
    onSidebarTouchMove: vi.fn(),
    onSidebarTouchStart: vi.fn(),
  };
}

function touchEvent(): TouchEvent {
  return {} as TouchEvent;
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellInteractionTouchGesturesHostLoader', () => {
  it('uses the provided touch gestures host factory', async () => {
    const touchGestures = createTouchGestures();
    const createTouchGesturesHost = vi.fn(() => touchGestures);
    const loadHost = createWorkspaceShellInteractionTouchGesturesHostLoader({
      createTouchGesturesHost,
      options: {
        activeView: () => 'text',
        isMobile: () => true,
        setSidebarOpen: vi.fn(),
        warn: vi.fn(),
      },
    });

    await expect(loadHost()).resolves.toBe(touchGestures);

    expect(createTouchGesturesHost).toHaveBeenCalledOnce();
  });

  it('converts synchronous touch gestures host factory failures to rejected promises and retries later', async () => {
    const error = new Error('touch gestures host factory failed synchronously');
    const touchGestures = createTouchGestures();
    const createTouchGesturesHost = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockImplementationOnce(() => touchGestures);
    const loadHost = createWorkspaceShellInteractionTouchGesturesHostLoader({
      createTouchGesturesHost,
      options: {
        activeView: () => 'text',
        isMobile: () => true,
        setSidebarOpen: vi.fn(),
        warn: vi.fn(),
      },
    });

    await expect(loadHost()).rejects.toBe(error);
    await expect(loadHost()).resolves.toBe(touchGestures);

    expect(createTouchGesturesHost).toHaveBeenCalledTimes(2);
  });

  it('creates the default touch gestures lazy-load host lazily', async () => {
    const setSidebarOpen = vi.fn();
    const loadHost = createWorkspaceShellInteractionTouchGesturesHostLoader({
      options: {
        activeView: () => 'text',
        isMobile: () => true,
        setSidebarOpen,
        warn: vi.fn(),
      },
    });

    const host = await loadHost();
    host.onMainTouchStart(touchEvent());
    await flushMicrotasks();

    expect(setSidebarOpen).not.toHaveBeenCalled();
  });
});
