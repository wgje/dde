import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellInteractionSidebarResizeLazyDelegateController,
} from './workspace-shell-interaction-sidebar-resize-lazy-delegate.controller';
import type {
  WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host.controller';
import {
  createWorkspaceShellSidebarResizeDeferred,
  createWorkspaceShellSidebarResizeDelegate,
  createWorkspaceShellSidebarResizeMouseEvent,
  flushWorkspaceShellSidebarResizeMicrotasks,
} from './workspace-shell-sidebar-resize.spec-helpers';

function readShellSource(fileName: string): string {
  try {
    return readFileSync(join(__dirname, fileName), 'utf8');
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

describe('WorkspaceShellInteractionSidebarResizeLazyDelegateController', () => {
  it('delegates bootstrap document listener state to the bootstrap listeners controller', () => {
    const source = readShellSource(
      'workspace-shell-interaction-sidebar-resize-lazy-delegate.controller.ts',
    );

    expect(source).toContain('WorkspaceShellSidebarResizeBootstrapListenersController');
    expect(source).not.toContain('removeBootstrapMouseMoveListener');
    expect(source).not.toContain('removeBootstrapMouseUpListener');
    expect(source).not.toContain('private removeBootstrapDocumentListeners');
  });

  it('delegates pending gesture state to the sidebar resize pending gesture controller', () => {
    const source = readShellSource(
      'workspace-shell-interaction-sidebar-resize-lazy-delegate.controller.ts',
    );

    expect(source).toContain('WorkspaceShellSidebarResizePendingGestureController');
    expect(source).not.toContain('pendingResize');
    expect(source).not.toContain('gestureId');
    expect(source).not.toContain('private isTornDown');
    expect(source).not.toContain('this.isTornDown');
  });

  it('keeps the generic lazy host behind a named sidebar resize lazy host controller', () => {
    const source = readShellSource(
      'workspace-shell-interaction-sidebar-resize-lazy-delegate.controller.ts',
    );

    expect(source).toContain('WorkspaceShellInteractionSidebarResizeLazyHostController');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('workspace-shell-lazy-delegate-call-host.controller');
  });

  it('delegates loaded resize start orchestration to the sidebar resize start controller', () => {
    const source = readShellSource(
      'workspace-shell-interaction-sidebar-resize-lazy-delegate.controller.ts',
    );
    const startControllerSource = readShellSource(
      'workspace-shell-interaction-sidebar-resize-start.controller.ts',
    );

    expect(source).toContain('WorkspaceShellInteractionSidebarResizeStartController');
    expect(source).not.toContain('private startResize');
    expect(source).not.toContain('private startLoadedResize');
    expect(source).not.toContain('.then(started =>');
    expect(startControllerSource).toContain('this.host.call');
    expect(startControllerSource).toContain('this.pendingGesture.finish');
    expect(startControllerSource).toContain('this.bootstrapListeners.teardown');
  });

  it('forwards setup only after the resize host has already been loaded', async () => {
    const record: string[] = [];
    const delegate = createWorkspaceShellSidebarResizeDelegate(record);
    const loadSidebarResizeHost = vi.fn().mockResolvedValue(delegate);
    const controller = new WorkspaceShellInteractionSidebarResizeLazyDelegateController({
      loadSidebarResizeHost,
      warn: vi.fn(),
    });

    controller.setup();

    expect(loadSidebarResizeHost).not.toHaveBeenCalled();

    controller.startSidebarResize(createWorkspaceShellSidebarResizeMouseEvent());
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(record).toEqual(['setup', 'startSidebarResize']);

    record.length = 0;
    controller.setup();

    expect(loadSidebarResizeHost).toHaveBeenCalledTimes(1);
    expect(record).toEqual(['setup']);
  });

  it('does not start a late-loaded resize after mouseup cancels the pending gesture', async () => {
    const record: string[] = [];
    const delegate = createWorkspaceShellSidebarResizeDelegate(record);
    const deferred = createWorkspaceShellSidebarResizeDeferred<WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate>();
    const controller = new WorkspaceShellInteractionSidebarResizeLazyDelegateController({
      loadSidebarResizeHost: vi.fn(() => deferred.promise),
      warn: vi.fn(),
    });
    const event = createWorkspaceShellSidebarResizeMouseEvent();

    controller.startSidebarResize(event);
    expect(controller.isResizingAny()).toBe(true);

    controller.onMouseUp();
    expect(controller.isResizingAny()).toBe(false);

    deferred.resolve(delegate);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(record).toEqual([]);
    expect(delegate.setup).not.toHaveBeenCalled();
    expect(delegate.startSidebarResize).not.toHaveBeenCalled();
    expect(delegate.onMouseUp).not.toHaveBeenCalled();
    expect(controller.isResizingAny()).toBe(false);
  });

  it('does not let a stale cancelled gesture clear a newer pending resize', async () => {
    const record: string[] = [];
    const delegate = createWorkspaceShellSidebarResizeDelegate(record);
    const deferred = createWorkspaceShellSidebarResizeDeferred<WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate>();
    const controller = new WorkspaceShellInteractionSidebarResizeLazyDelegateController({
      loadSidebarResizeHost: vi.fn(() => deferred.promise),
      warn: vi.fn(),
    });

    controller.startSidebarResize(createWorkspaceShellSidebarResizeMouseEvent());
    controller.onMouseUp();
    controller.startContentResize(createWorkspaceShellSidebarResizeMouseEvent());

    expect(controller.isResizingAny()).toBe(true);

    deferred.resolve(delegate);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(record).toEqual(['setup', 'startContentResize']);
    expect(controller.isResizingAny()).toBe(true);
  });

  it('does not forward loaded resize events after teardown', async () => {
    const record: string[] = [];
    const delegate = createWorkspaceShellSidebarResizeDelegate(record);
    const controller = new WorkspaceShellInteractionSidebarResizeLazyDelegateController({
      loadSidebarResizeHost: vi.fn().mockResolvedValue(delegate),
      warn: vi.fn(),
    });

    controller.startSidebarResize(createWorkspaceShellSidebarResizeMouseEvent());
    await flushWorkspaceShellSidebarResizeMicrotasks();
    controller.teardown();
    record.length = 0;
    controller.setup();
    controller.onMouseMove(createWorkspaceShellSidebarResizeMouseEvent());
    controller.onMouseUp();

    expect(controller.isResizingAny()).toBe(false);
    expect(record).toEqual([]);
    expect(delegate.onMouseMove).not.toHaveBeenCalled();
    expect(delegate.onMouseUp).not.toHaveBeenCalled();
  });

  it('isolates loaded delegate mousemove failures and clears local resize state', async () => {
    const error = new Error('loaded delegate mousemove failed');
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    delegate.onMouseMove.mockImplementationOnce(() => {
      throw error;
    });
    const warn = vi.fn();
    const controller = new WorkspaceShellInteractionSidebarResizeLazyDelegateController({
      loadSidebarResizeHost: vi.fn().mockResolvedValue(delegate),
      warn,
    });

    controller.startSidebarResize(createWorkspaceShellSidebarResizeMouseEvent());
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(() => {
      controller.onMouseMove(createWorkspaceShellSidebarResizeMouseEvent());
    }).not.toThrow();

    expect(controller.isResizingAny()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '侧栏拖拽加载失败，已跳过',
      error,
    );
  });

  it('isolates loaded delegate mouseup failures and clears local resize state', async () => {
    const error = new Error('loaded delegate mouseup failed');
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    delegate.onMouseUp.mockImplementationOnce(() => {
      throw error;
    });
    const warn = vi.fn();
    const controller = new WorkspaceShellInteractionSidebarResizeLazyDelegateController({
      loadSidebarResizeHost: vi.fn().mockResolvedValue(delegate),
      warn,
    });

    controller.startSidebarResize(createWorkspaceShellSidebarResizeMouseEvent());
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(() => {
      controller.onMouseUp();
    }).not.toThrow();

    expect(controller.isResizingAny()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '侧栏拖拽加载失败，已跳过',
      error,
    );
  });

  it('isolates loaded delegate resize-state failures and clears local resize state', async () => {
    const error = new Error('loaded delegate resize state failed');
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    delegate.isResizingAny.mockImplementationOnce(() => true);
    delegate.isResizingAny.mockImplementationOnce(() => {
      throw error;
    });
    const warn = vi.fn();
    const controller = new WorkspaceShellInteractionSidebarResizeLazyDelegateController({
      loadSidebarResizeHost: vi.fn().mockResolvedValue(delegate),
      warn,
    });

    controller.startSidebarResize(createWorkspaceShellSidebarResizeMouseEvent());
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(() => {
      expect(controller.isResizingAny()).toBe(false);
    }).not.toThrow();
    expect(controller.isResizingAny()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '侧栏拖拽加载失败，已跳过',
      error,
    );
  });
});
