import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellInteractionSidebarResizeStartController,
} from './workspace-shell-interaction-sidebar-resize-start.controller';
import {
  WorkspaceShellInteractionSidebarResizeLazyHostController,
  type WorkspaceShellInteractionSidebarResizeLazyHostDelegate,
} from './workspace-shell-interaction-sidebar-resize-lazy-host.controller';
import {
  WorkspaceShellSidebarResizePendingGestureController,
} from './workspace-shell-sidebar-resize-pending-gesture.controller';
import type {
  WorkspaceShellSidebarResizeBootstrapListenersController,
} from './workspace-shell-sidebar-resize-bootstrap-listeners.controller';
import {
  createWorkspaceShellSidebarResizeDeferred,
  createWorkspaceShellSidebarResizeDelegate,
  createWorkspaceShellSidebarResizeMouseEvent,
  flushWorkspaceShellSidebarResizeMicrotasks,
} from './workspace-shell-sidebar-resize.spec-helpers';

function createBootstrapListeners() {
  return {
    setup: vi.fn(),
    teardown: vi.fn(),
  } as unknown as WorkspaceShellSidebarResizeBootstrapListenersController & {
    setup: ReturnType<typeof vi.fn>;
    teardown: ReturnType<typeof vi.fn>;
  };
}

function createController(overrides: {
  loadSidebarResizeHost?: () => Promise<WorkspaceShellInteractionSidebarResizeLazyHostDelegate>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const delegate = createWorkspaceShellSidebarResizeDelegate();
  const loadSidebarResizeHost = overrides.loadSidebarResizeHost
    ?? vi.fn().mockResolvedValue(delegate);
  const warn = overrides.warn ?? vi.fn();
  const host = new WorkspaceShellInteractionSidebarResizeLazyHostController({
    loadSidebarResizeHost,
    warn,
  });
  const bootstrapListeners = createBootstrapListeners();
  const pendingGesture = new WorkspaceShellSidebarResizePendingGestureController();
  const controller = new WorkspaceShellInteractionSidebarResizeStartController({
    bootstrapListeners,
    host,
    pendingGesture,
  });

  return { bootstrapListeners, controller, delegate, host, pendingGesture, warn };
}

describe('WorkspaceShellInteractionSidebarResizeStartController', () => {
  it('bootstraps document listeners, loads the host, and starts the requested resize', async () => {
    const { bootstrapListeners, controller, delegate, pendingGesture } = createController();
    const event = createWorkspaceShellSidebarResizeMouseEvent();

    controller.start('startSidebarResize', event);

    // 加载完成前先挂 bootstrap listener 并立即锁定手势
    expect(bootstrapListeners.setup).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(pendingGesture.isResizingAny(false)).toBe(true);

    await flushWorkspaceShellSidebarResizeMicrotasks();

    // 加载完成后 bootstrap listener 交还给 delegate 自己的 setup
    expect(bootstrapListeners.teardown).toHaveBeenCalledTimes(1);
    expect(delegate.setup).toHaveBeenCalledTimes(1);
    expect(delegate.startSidebarResize).toHaveBeenCalledWith(event);
    expect(pendingGesture.isResizingAny(false)).toBe(true);
  });

  it('routes startContentResize to the content resize delegate method', async () => {
    const { controller, delegate } = createController();
    const event = createWorkspaceShellSidebarResizeMouseEvent();

    controller.start('startContentResize', event);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(delegate.startContentResize).toHaveBeenCalledWith(event);
    expect(delegate.startSidebarResize).not.toHaveBeenCalled();
  });

  it('skips bootstrap listeners when the resize host is already loaded', async () => {
    const { bootstrapListeners, controller } = createController();

    controller.start('startSidebarResize', createWorkspaceShellSidebarResizeMouseEvent());
    await flushWorkspaceShellSidebarResizeMicrotasks();
    controller.start('startSidebarResize', createWorkspaceShellSidebarResizeMouseEvent());
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(bootstrapListeners.setup).toHaveBeenCalledTimes(1);
  });

  it('does not preventDefault again when the event is already default-prevented', () => {
    const { controller } = createController();
    const event = createWorkspaceShellSidebarResizeMouseEvent();
    event.preventDefault();
    (event.preventDefault as ReturnType<typeof vi.fn>).mockClear();

    controller.start('startSidebarResize', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('releases the pending gesture without starting when the host load fails', async () => {
    const error = new Error('sidebar resize chunk missing');
    const { controller, pendingGesture, warn } = createController({
      loadSidebarResizeHost: vi.fn().mockRejectedValue(error),
    });

    controller.start('startSidebarResize', createWorkspaceShellSidebarResizeMouseEvent());
    expect(pendingGesture.isResizingAny(false)).toBe(true);

    await flushWorkspaceShellSidebarResizeMicrotasks();

    // 加载失败必须释放悬挂手势，避免 UI 永久停留在“拖拽中”
    expect(pendingGesture.isResizingAny(false)).toBe(false);
    expect(warn).toHaveBeenCalledWith('侧栏拖拽加载失败，已跳过', error);
  });

  it('abandons a superseded gesture when the delegate resolves after cancellation', async () => {
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    const deferred = createWorkspaceShellSidebarResizeDeferred<
      WorkspaceShellInteractionSidebarResizeLazyHostDelegate
    >();
    const { bootstrapListeners, controller, pendingGesture } = createController({
      loadSidebarResizeHost: vi.fn(() => deferred.promise),
    });

    controller.start('startSidebarResize', createWorkspaceShellSidebarResizeMouseEvent());
    pendingGesture.cancel();
    deferred.resolve(delegate);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    // 竞态守卫：手势代际已失效时，延迟到达的 delegate 不得启动拖拽
    expect(delegate.startSidebarResize).not.toHaveBeenCalled();
    expect(bootstrapListeners.teardown).not.toHaveBeenCalled();
    expect(pendingGesture.isResizingAny(false)).toBe(false);
  });
});
