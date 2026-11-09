import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellSidebarResizeDelegate,
  createWorkspaceShellSidebarResizeMouseEvent,
} from './workspace-shell-sidebar-resize.spec-helpers';
import type {
  WorkspaceShellSidebarResizeServiceLike,
} from './workspace-shell-sidebar-resize-lazy-load.controller';
import {
  createWorkspaceShellSidebarResizeDeferredLazyLoadHostLoader,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host-loader.factory';

function createService(
  overrides: Partial<WorkspaceShellSidebarResizeServiceLike> = {},
): WorkspaceShellSidebarResizeServiceLike {
  return {
    isResizingAny: vi.fn(() => true),
    onMouseMove: vi.fn(),
    onMouseUp: vi.fn(),
    startContent: vi.fn(),
    startSidebar: vi.fn(),
    teardown: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellSidebarResizeDeferredLazyLoadHostLoader', () => {
  it('delegates sidebar resize service resolution to the service loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-resize-deferred-lazy-load-host-loader.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellSidebarResizeServiceLoader');
    const controllerOptions = source.slice(
      source.indexOf('new WorkspaceShellSidebarResizeLazyLoadController'),
      source.indexOf('}));'),
    );
    expect(controllerOptions).toContain('loadSidebarResize,');
    expect(controllerOptions).not.toContain('options.loadSidebarResize');
    expect(controllerOptions).not.toContain('options.injector');
  });

  it('uses the provided deferred host loader when one is supplied', async () => {
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    const loadSidebarResizeHost = vi.fn().mockResolvedValue(delegate);
    const loadHost = createWorkspaceShellSidebarResizeDeferredLazyLoadHostLoader({
      loadSidebarResizeHost,
      warn: vi.fn(),
    });

    await expect(loadHost()).resolves.toBe(delegate);

    expect(loadSidebarResizeHost).toHaveBeenCalledOnce();
  });

  it('creates the final resize lazy-load controller when no host loader is supplied', async () => {
    const service = createService();
    const loadSidebarResize = vi.fn().mockResolvedValue(service);
    const loadHost = createWorkspaceShellSidebarResizeDeferredLazyLoadHostLoader({
      destroyed: () => false,
      loadSidebarResize,
      warn: vi.fn(),
    });

    const host = await loadHost();
    const event = createWorkspaceShellSidebarResizeMouseEvent();
    host.startSidebarResize(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(service.startSidebar).toHaveBeenCalledWith(event));
    expect(loadSidebarResize).toHaveBeenCalledOnce();
  });
});
