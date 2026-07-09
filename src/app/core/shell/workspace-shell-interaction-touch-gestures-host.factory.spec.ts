import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellInteractionTouchGesturesHost,
  type WorkspaceShellInteractionTouchGesturesHostOptions,
} from './workspace-shell-interaction-touch-gestures-host.factory';
import type {
  WorkspaceShellTouchGestureControllerLike,
} from './workspace-shell-touch-gesture-lazy-load.controller';

function createTouchGestures(): WorkspaceShellTouchGestureControllerLike {
  return {
    onMainTouchEnd: vi.fn(),
    onMainTouchMove: vi.fn(),
    onMainTouchStart: vi.fn(),
    onSidebarTouchEnd: vi.fn(),
    onSidebarTouchMove: vi.fn(),
    onSidebarTouchStart: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellInteractionTouchGesturesHostOptions> = {},
): WorkspaceShellInteractionTouchGesturesHostOptions {
  return {
    activeView: () => 'text',
    isMobile: () => true,
    setSidebarOpen: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellInteractionTouchGesturesHost', () => {
  it('uses the provided touch gestures host lazily', async () => {
    const touchGestures = createTouchGestures();
    const createTouchGesturesHost = vi.fn().mockResolvedValue(touchGestures);
    const host = createWorkspaceShellInteractionTouchGesturesHost(createOptions({
      createTouchGesturesHost,
    }));
    const event = {} as TouchEvent;

    expect(createTouchGesturesHost).not.toHaveBeenCalled();

    host.onSidebarTouchStart(event);
    await flushMicrotasks();

    expect(createTouchGesturesHost).toHaveBeenCalledTimes(1);
    expect(touchGestures.onSidebarTouchStart).toHaveBeenCalledWith(event);
  });

  it('keeps the concrete touch gesture lazy-load controller behind a dynamic import', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-touch-gestures-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellInteractionTouchGesturesHostLoader');
    expect(source).not.toContain("import('./workspace-shell-touch-gesture-lazy-load.controller')");
    expect(source).not.toContain('new WorkspaceShellTouchGestureLazyLoadController');
    expect(source).not.toMatch(/import\s*{[^}]*WorkspaceShellTouchGestureLazyLoadController/s);
  });
});
