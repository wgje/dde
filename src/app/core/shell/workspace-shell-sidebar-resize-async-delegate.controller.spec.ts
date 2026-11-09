import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSidebarResizeAsyncDelegateController,
  type WorkspaceShellSidebarResizeAsyncDelegate,
} from './workspace-shell-sidebar-resize-async-delegate.controller';
import {
  createWorkspaceShellSidebarResizeDeferred,
  createWorkspaceShellSidebarResizeDelegate,
  createWorkspaceShellSidebarResizeMouseEvent,
  flushWorkspaceShellSidebarResizeMicrotasks,
} from './workspace-shell-sidebar-resize.spec-helpers';

function createController(
  loadDelegate: () => Promise<WorkspaceShellSidebarResizeAsyncDelegate>,
): {
  controller: WorkspaceShellSidebarResizeAsyncDelegateController;
  warn: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  const controller = new WorkspaceShellSidebarResizeAsyncDelegateController({
    loadDelegate,
    resolveFailureMessage: target => `${target} load failed`,
    resolveStartFailureMessage: target => `${target} start failed`,
    teardownFailureMessage: 'teardown failed',
    warn,
  });

  return { controller, warn };
}

describe('WorkspaceShellSidebarResizeAsyncDelegateController', () => {
  it('keeps generic lazy delegate host state behind a named sidebar resize async host controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-resize-async-delegate.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellSidebarResizeAsyncDelegateHostController');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('workspace-shell-lazy-delegate-call-host.controller');
  });

  it('reuses the named pending gesture controller for async resize state', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-resize-async-delegate.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellSidebarResizePendingGestureController');
    expect(source).toContain('private readonly pendingGesture');
    expect(source).not.toContain('private active =');
    expect(source).not.toContain('private gestureId =');
  });

  it('keeps resize active while delegate loading and flushes the latest pending mousemove', async () => {
    const deferred = createWorkspaceShellSidebarResizeDeferred<WorkspaceShellSidebarResizeAsyncDelegate>();
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    const { controller } = createController(() => deferred.promise);
    const startEvent = createWorkspaceShellSidebarResizeMouseEvent();
    const staleMoveEvent = createWorkspaceShellSidebarResizeMouseEvent();
    const latestMoveEvent = createWorkspaceShellSidebarResizeMouseEvent();

    controller.startSidebarResize(startEvent);
    controller.onMouseMove(staleMoveEvent);
    controller.onMouseMove(latestMoveEvent);

    expect(startEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(controller.isResizingAny()).toBe(true);
    expect(delegate.startSidebarResize).not.toHaveBeenCalled();
    expect(delegate.onMouseMove).not.toHaveBeenCalled();

    deferred.resolve(delegate);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(delegate.startSidebarResize).toHaveBeenCalledWith(startEvent);
    expect(delegate.onMouseMove).toHaveBeenCalledTimes(1);
    expect(delegate.onMouseMove).toHaveBeenCalledWith(latestMoveEvent);
    expect(controller.isResizingAny()).toBe(true);
  });

  it('does not start a loaded delegate after mouseup cancels the pending gesture', async () => {
    const deferred = createWorkspaceShellSidebarResizeDeferred<WorkspaceShellSidebarResizeAsyncDelegate>();
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    const { controller } = createController(() => deferred.promise);
    const startEvent = createWorkspaceShellSidebarResizeMouseEvent();

    controller.startContentResize(startEvent);
    controller.onMouseUp();

    deferred.resolve(delegate);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(delegate.startContentResize).not.toHaveBeenCalled();
    expect(delegate.onMouseUp).not.toHaveBeenCalled();
    expect(controller.isResizingAny()).toBe(false);
  });

  it('tears down a delegate that resolves after controller teardown', async () => {
    const deferred = createWorkspaceShellSidebarResizeDeferred<WorkspaceShellSidebarResizeAsyncDelegate>();
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    const { controller } = createController(() => deferred.promise);

    controller.startSidebarResize(createWorkspaceShellSidebarResizeMouseEvent());
    controller.teardown();

    deferred.resolve(delegate);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(delegate.startSidebarResize).not.toHaveBeenCalled();
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
    expect(controller.isResizingAny()).toBe(false);
  });

  it('recovers active resize state when a loaded delegate fails to start', async () => {
    const startError = new Error('delegate start failed');
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    delegate.startSidebarResize.mockImplementationOnce(() => {
      throw startError;
    });
    const { controller, warn } = createController(() => Promise.resolve(delegate));
    const startEvent = createWorkspaceShellSidebarResizeMouseEvent();

    controller.startSidebarResize(startEvent);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(startEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(delegate.startSidebarResize).toHaveBeenCalledWith(startEvent);
    expect(controller.isResizingAny()).toBe(false);
    expect(warn).toHaveBeenCalledWith('sidebar start failed', startError);
    expect(warn).not.toHaveBeenCalledWith('sidebar load failed', startError);
  });

  it('recovers when resolving the start failure boundary throws', () => {
    const resolverError = new Error('start failure message unavailable');
    const loadDelegate = vi.fn<() => Promise<WorkspaceShellSidebarResizeAsyncDelegate>>();
    const warn = vi.fn();
    const controller = new WorkspaceShellSidebarResizeAsyncDelegateController({
      loadDelegate,
      resolveFailureMessage: target => `${target} load failed`,
      resolveStartFailureMessage: () => {
        throw resolverError;
      },
      teardownFailureMessage: 'teardown failed',
      warn,
    });
    const startEvent = createWorkspaceShellSidebarResizeMouseEvent();

    expect(() => controller.startSidebarResize(startEvent)).not.toThrow();

    expect(startEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(loadDelegate).not.toHaveBeenCalled();
    expect(controller.isResizingAny()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'sidebar resize start failure message resolution failed',
      resolverError,
    );
  });

  it('isolates mousemove failures from a loaded resize delegate', async () => {
    const moveError = new Error('delegate mousemove failed');
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    delegate.onMouseMove.mockImplementationOnce(() => {
      throw moveError;
    });
    const { controller, warn } = createController(() => Promise.resolve(delegate));
    const startEvent = createWorkspaceShellSidebarResizeMouseEvent();
    const moveEvent = createWorkspaceShellSidebarResizeMouseEvent();

    controller.startSidebarResize(startEvent);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(() => controller.onMouseMove(moveEvent)).not.toThrow();

    expect(delegate.onMouseMove).toHaveBeenCalledWith(moveEvent);
    expect(controller.isResizingAny()).toBe(false);
    expect(warn).toHaveBeenCalledWith('sidebar mousemove failed', moveError);
  });

  it('keeps mousemove failure isolated when the warning sink fails', async () => {
    const moveError = new Error('delegate mousemove failed');
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    delegate.onMouseMove.mockImplementationOnce(() => {
      throw moveError;
    });
    const { controller, warn } = createController(() => Promise.resolve(delegate));
    warn.mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });
    const startEvent = createWorkspaceShellSidebarResizeMouseEvent();
    const moveEvent = createWorkspaceShellSidebarResizeMouseEvent();

    controller.startSidebarResize(startEvent);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(() => controller.onMouseMove(moveEvent)).not.toThrow();

    expect(delegate.onMouseMove).toHaveBeenCalledWith(moveEvent);
    expect(controller.isResizingAny()).toBe(false);
    expect(warn).toHaveBeenCalledWith('sidebar mousemove failed', moveError);
  });

  it('isolates mouseup failures from a loaded resize delegate', async () => {
    const mouseUpError = new Error('delegate mouseup failed');
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    delegate.onMouseUp.mockImplementationOnce(() => {
      throw mouseUpError;
    });
    const { controller, warn } = createController(() => Promise.resolve(delegate));
    const startEvent = createWorkspaceShellSidebarResizeMouseEvent();

    controller.startSidebarResize(startEvent);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(() => controller.onMouseUp()).not.toThrow();

    expect(delegate.onMouseUp).toHaveBeenCalledTimes(1);
    expect(controller.isResizingAny()).toBe(false);
    expect(warn).toHaveBeenCalledWith('sidebar mouseup failed', mouseUpError);
  });

  it('keeps mouseup failure isolated when the warning sink fails', async () => {
    const mouseUpError = new Error('delegate mouseup failed');
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    delegate.onMouseUp.mockImplementationOnce(() => {
      throw mouseUpError;
    });
    const { controller, warn } = createController(() => Promise.resolve(delegate));
    warn.mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });
    const startEvent = createWorkspaceShellSidebarResizeMouseEvent();

    controller.startSidebarResize(startEvent);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(() => controller.onMouseUp()).not.toThrow();

    expect(delegate.onMouseUp).toHaveBeenCalledTimes(1);
    expect(controller.isResizingAny()).toBe(false);
    expect(warn).toHaveBeenCalledWith('sidebar mouseup failed', mouseUpError);
  });

  it('recovers when checking resize state fails on a loaded delegate', async () => {
    const stateError = new Error('delegate resize state failed');
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    delegate.isResizingAny.mockImplementationOnce(() => true);
    delegate.isResizingAny.mockImplementationOnce(() => {
      throw stateError;
    });
    const { controller, warn } = createController(() => Promise.resolve(delegate));
    const startEvent = createWorkspaceShellSidebarResizeMouseEvent();

    controller.startSidebarResize(startEvent);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(controller.isResizingAny()).toBe(false);
    expect(controller.isResizingAny()).toBe(false);
    expect(warn).toHaveBeenCalledWith('sidebar resize state check failed', stateError);
  });
});
