import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellInteractionViewportResizeHost,
  type WorkspaceShellInteractionViewportResizeHostOptions,
} from './workspace-shell-interaction-viewport-resize-host.factory';
import type {
  WorkspaceShellViewportResizeInteractionDelegate,
} from './workspace-shell-interaction-lazy-load-delegates.factory';

function createViewportResizeDelegate(): WorkspaceShellViewportResizeInteractionDelegate {
  return {
    cleanup: vi.fn(),
    handleResize: vi.fn(),
    setup: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellInteractionViewportResizeHostOptions> = {},
): WorkspaceShellInteractionViewportResizeHostOptions {
  return {
    getWindow: () => undefined,
    isMobile: () => false,
    setSidebarOpen: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  } as WorkspaceShellInteractionViewportResizeHostOptions;
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellInteractionViewportResizeHost', () => {
  it('uses the provided viewport resize host lazily', async () => {
    const viewportResize = createViewportResizeDelegate();
    const createViewportResizeHost = vi.fn().mockResolvedValue(viewportResize);
    const host = createWorkspaceShellInteractionViewportResizeHost(createOptions({
      createViewportResizeHost,
    }));

    expect(createViewportResizeHost).not.toHaveBeenCalled();

    await host.setup();
    await flushMicrotasks();

    expect(createViewportResizeHost).toHaveBeenCalledTimes(1);
    expect(viewportResize.setup).toHaveBeenCalledTimes(1);
  });

  it('registers and removes the window resize listener through the default host', async () => {
    const resizeListenerRef: { current: EventListener | null } = { current: null };
    const addEventListener = vi.fn((eventName: string, listener: EventListener) => {
      if (eventName === 'resize') resizeListenerRef.current = listener;
    });
    const removeEventListener = vi.fn();
    const host = createWorkspaceShellInteractionViewportResizeHost(createOptions({
      getWindow: () => ({
        addEventListener,
        innerWidth: 900,
        removeEventListener,
      } as unknown as Window),
    }));

    host.setup();

    await vi.waitFor(() => {
      expect(addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    });
    resizeListenerRef.current?.(new Event('resize'));
    await Promise.resolve(host.cleanup() as unknown);

    expect(removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('delegates concrete viewport resize host loading to the loader boundary', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-viewport-resize-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellInteractionViewportResizeHostLoader');
    expect(source).not.toContain("import('./workspace-shell-viewport-resize-lazy-load-host.controller')");
    expect(source).not.toContain('new WorkspaceShellViewportResizeLazyLoadHostController');
    expect(source).not.toMatch(/import\\s*{[^}]*WorkspaceShellViewportResizeLazyLoadHostController/s);
  });
});
