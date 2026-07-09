import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellInteractionSidebarResizeHost,
} from './workspace-shell-interaction-sidebar-resize-host.factory';
import {
  createWorkspaceShellSidebarResizeDeferred,
  createWorkspaceShellSidebarResizeDelegate,
  createWorkspaceShellSidebarResizeMouseEvent,
  flushWorkspaceShellSidebarResizeMicrotasks,
} from './workspace-shell-sidebar-resize.spec-helpers';

describe('createWorkspaceShellInteractionSidebarResizeHost', () => {
  it('keeps the concrete deferred resize host behind a loader boundary', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-sidebar-resize-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellInteractionSidebarResizeHostLoader');
    expect(source).not.toContain(
      "import('./workspace-shell-sidebar-resize-deferred-lazy-load-host.controller')",
    );
    expect(source).not.toContain('WorkspaceShellSidebarResizeDeferredLazyLoadHostController');
    expect(source).not.toContain('workspace-shell-sidebar-resize.factory');
    expect(source).not.toContain('createWorkspaceShellSidebarResize');
  });

  it('keeps sidebar resize loading lazy while exposing synchronous resize state', async () => {
    const sidebarResize = {
      setup: vi.fn(),
      teardown: vi.fn(),
      isResizingAny: vi.fn(() => false),
      startSidebarResize: vi.fn(),
      startContentResize: vi.fn(),
      onMouseMove: vi.fn(),
      onMouseUp: vi.fn(),
    };
    const createSidebarResizeFactoryHost = vi.fn().mockResolvedValue(sidebarResize);
    const resizeHost = createWorkspaceShellInteractionSidebarResizeHost({
      destroyed: () => false,
      injector: {} as never,
      warn: vi.fn(),
      createSidebarResizeFactoryHost,
    });
    const event = createWorkspaceShellSidebarResizeMouseEvent();

    expect(createSidebarResizeFactoryHost).not.toHaveBeenCalled();
    expect(resizeHost.isResizingAny()).toBe(false);

    resizeHost.startSidebarResize(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(resizeHost.isResizingAny()).toBe(true);

    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(createSidebarResizeFactoryHost).toHaveBeenCalledTimes(1);
    expect(sidebarResize.setup).toHaveBeenCalledTimes(1);
    expect(sidebarResize.startSidebarResize).toHaveBeenCalledWith(event);
    expect(resizeHost.isResizingAny()).toBe(false);
  });

  it('does not start a first drag after document mouseup happens before the deferred host loads', async () => {
    const record: string[] = [];
    const sidebarResize = createWorkspaceShellSidebarResizeDelegate(record);
    const deferred = createWorkspaceShellSidebarResizeDeferred<typeof sidebarResize>();
    const documentTarget = new EventTarget() as Document;
    const resizeHost = createWorkspaceShellInteractionSidebarResizeHost({
      destroyed: () => false,
      getDocument: () => documentTarget,
      injector: {} as never,
      warn: vi.fn(),
      createSidebarResizeLazyLoadHost: () => deferred.promise,
    });
    const event = createWorkspaceShellSidebarResizeMouseEvent();

    resizeHost.setup();
    resizeHost.startSidebarResize(event);
    documentTarget.dispatchEvent(new Event('mouseup'));

    deferred.resolve(sidebarResize);
    await deferred.promise;
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(record).toEqual([]);
    expect(sidebarResize.setup).not.toHaveBeenCalled();
    expect(sidebarResize.startSidebarResize).not.toHaveBeenCalled();
    expect(resizeHost.isResizingAny()).toBe(false);
  });
});
