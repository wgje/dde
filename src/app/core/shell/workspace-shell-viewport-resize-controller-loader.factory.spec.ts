import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellViewportResizeControllerLoader,
} from './workspace-shell-viewport-resize-controller-loader.factory';
import type {
  WorkspaceShellViewportResizeHostDelegate,
} from './workspace-shell-viewport-resize-lazy-load-host.controller';

function createViewportResizeDelegate(): WorkspaceShellViewportResizeHostDelegate {
  return {
    cleanup: vi.fn(),
    handleResize: vi.fn(),
  };
}

function requireScheduledResize(callback: (() => void) | null): () => void {
  if (!callback) {
    throw new Error('Expected viewport resize to be scheduled');
  }
  return callback;
}

describe('createWorkspaceShellViewportResizeControllerLoader', () => {
  it('uses the provided viewport resize controller loader', async () => {
    const viewportResize = createViewportResizeDelegate();
    const createViewportResizeController = vi.fn().mockResolvedValue(viewportResize);
    const loadController = createWorkspaceShellViewportResizeControllerLoader({
      createViewportResizeController,
      isMobile: () => false,
      setSidebarOpen: vi.fn(),
      warn: vi.fn(),
    });

    await expect(loadController()).resolves.toBe(viewportResize);

    expect(createViewportResizeController).toHaveBeenCalledOnce();
  });

  it('creates the default viewport resize controller lazily', async () => {
    const setIsMobile = vi.fn();
    const setSidebarOpen = vi.fn();
    let scheduledResize: (() => void) | null = null;
    const loadController = createWorkspaceShellViewportResizeControllerLoader({
      getWindow: () => ({ innerWidth: 400 }) as Window,
      isMobile: () => false,
      setIsMobile,
      setSidebarOpen,
      setTimeout: vi.fn((callback: () => void) => {
        scheduledResize = callback;
        return 1;
      }),
      clearTimeout: vi.fn(),
      warn: vi.fn(),
    });

    const controller = await loadController();
    controller.handleResize();
    requireScheduledResize(scheduledResize)();

    expect(setIsMobile).toHaveBeenCalledWith(true);
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });
});
