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

  it('uses the browser window through the real lazy chain when no provider is supplied', async () => {
    const previousWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const callbacks: Array<() => void> = [];
    const setIsMobile = vi.fn(); const setSidebarOpen = vi.fn(); const warn = vi.fn();
    const host = createWorkspaceShellInteractionViewportResizeHost({
      isMobile: () => false, setIsMobile, setSidebarOpen, warn,
      setTimeout: callback => { callbacks.push(callback); return callbacks.length; }, clearTimeout: vi.fn(),
    });
    try {
      await host.setup();
      window.dispatchEvent(new Event('resize'));
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      callbacks[0]();
      expect(setIsMobile).toHaveBeenCalledWith(true);
      expect(setSidebarOpen).toHaveBeenCalledWith(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await host.cleanup();
      if (previousWidth) Object.defineProperty(window, 'innerWidth', previousWidth);
    }
  });

  it('honors an explicit no-window provider for both listener and controller', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const warn = vi.fn(); const setTimeout = vi.fn();
    const host = createWorkspaceShellInteractionViewportResizeHost(createOptions({
      getWindow: () => undefined, setIsMobile: vi.fn(), setTimeout, warn,
    }));
    try {
      await host.setup();
      expect(add.mock.calls.filter(call => call[0] === 'resize')).toHaveLength(0);
      await host.handleResize();
      await flushMicrotasks();
      expect(setTimeout).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally { await host.cleanup(); add.mockRestore(); }
  });

  it('does not apply a scheduled default-chain resize after cleanup', async () => {
    const callbacks: Array<() => void> = [];
    const setIsMobile = vi.fn(); const warn = vi.fn();
    const host = createWorkspaceShellInteractionViewportResizeHost({
      isMobile: () => false, setIsMobile, setSidebarOpen: vi.fn(), warn,
      setTimeout: callback => { callbacks.push(callback); return callbacks.length; }, clearTimeout: vi.fn(),
    });
    await host.setup();
    await host.handleResize();
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    await host.cleanup();
    callbacks[0]();
    expect(setIsMobile).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('retains the exact loader rejection warning rather than masking real failures', async () => {
    const failure = new Error('chunk import failed'); const warn = vi.fn();
    const host = createWorkspaceShellInteractionViewportResizeHost(createOptions({
      createViewportResizeHost: vi.fn().mockRejectedValue(failure), warn,
    }));
    await host.setup();
    expect(warn).toHaveBeenCalledWith('视口 resize lazy-load host 加载失败，已跳过本次操作', failure);
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
