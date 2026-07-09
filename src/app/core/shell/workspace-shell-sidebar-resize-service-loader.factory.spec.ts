import type { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellSidebarResizeServiceLoader,
} from './workspace-shell-sidebar-resize-service-loader.factory';
import type {
  WorkspaceShellSidebarResizeServiceLike,
} from './workspace-shell-sidebar-resize-lazy-load.controller';

vi.mock('../../../services/sidebar-resize.service', () => ({
  SidebarResizeService: class SidebarResizeService {},
}));

function createService(): WorkspaceShellSidebarResizeServiceLike {
  return {
    isResizingAny: vi.fn(() => false),
    onMouseMove: vi.fn(),
    onMouseUp: vi.fn(),
    startContent: vi.fn(),
    startSidebar: vi.fn(),
    teardown: vi.fn(),
  };
}

describe('createWorkspaceShellSidebarResizeServiceLoader', () => {
  it('uses the provided sidebar resize service loader', async () => {
    const service = createService();
    const loadSidebarResize = vi.fn().mockResolvedValue(service);
    const loadService = createWorkspaceShellSidebarResizeServiceLoader({
      injector: {} as Injector,
      loadSidebarResize,
    });

    await expect(loadService()).resolves.toBe(service);

    expect(loadSidebarResize).toHaveBeenCalledOnce();
  });

  it('loads the sidebar resize service through the injector by default', async () => {
    const service = createService();
    const injectorGet = vi.fn().mockReturnValue(service);
    const injector = { get: injectorGet } as unknown as Injector;
    const loadService = createWorkspaceShellSidebarResizeServiceLoader({ injector });

    await expect(loadService()).resolves.toBe(service);

    expect(injectorGet).toHaveBeenCalledOnce();
    const [token] = injectorGet.mock.calls[0];
    expect((token as { name?: string }).name).toBe('SidebarResizeService');
  });
});
