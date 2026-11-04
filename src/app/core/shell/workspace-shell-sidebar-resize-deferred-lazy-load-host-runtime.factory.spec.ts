import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellSidebarResizeDeferredLazyLoadHostRuntime,
  type WorkspaceShellSidebarResizeDeferredLazyLoadHostRuntimeOptions,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host-runtime.factory';
import type {
  WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host.controller';
import {
  createWorkspaceShellSidebarResizeDelegate,
  createWorkspaceShellSidebarResizeMouseEvent,
  flushWorkspaceShellSidebarResizeMicrotasks,
} from './workspace-shell-sidebar-resize.spec-helpers';

function createRuntime(overrides: Partial<
  WorkspaceShellSidebarResizeDeferredLazyLoadHostRuntimeOptions
> = {}) {
  const delegate = createWorkspaceShellSidebarResizeDelegate();
  const loadSidebarResizeHost = overrides.loadSidebarResizeHost
    ?? vi.fn().mockResolvedValue(delegate);
  const onMouseMove = vi.fn();
  const onMouseUp = vi.fn();
  const warn = vi.fn();
  const documentListeners = new Map<string, EventListener>();
  const removeListeners = new Map<string, ReturnType<typeof vi.fn>>();
  const listenToDocument = vi.fn((eventName: string, listener: EventListener) => {
    documentListeners.set(eventName, listener);
    const remove = vi.fn();
    removeListeners.set(eventName, remove);
    return remove;
  });
  const host = createWorkspaceShellSidebarResizeDeferredLazyLoadHostRuntime({
    destroyed: () => false,
    listenToDocument,
    loadSidebarResizeHost,
    warn,
    onMouseMove,
    onMouseUp,
    ...overrides,
  });

  return {
    delegate,
    documentListeners,
    host,
    listenToDocument,
    loadSidebarResizeHost,
    onMouseMove,
    onMouseUp,
    removeListeners,
    warn,
  };
}

describe('createWorkspaceShellSidebarResizeDeferredLazyLoadHostRuntime', () => {
  it('registers bootstrap document listeners that forward to the runtime callbacks', () => {
    const { documentListeners, host, listenToDocument, onMouseMove, onMouseUp } = createRuntime();

    host.setup();

    expect(listenToDocument).toHaveBeenCalledWith('mousemove', expect.any(Function));
    expect(listenToDocument).toHaveBeenCalledWith('mouseup', expect.any(Function));

    const moveEvent = createWorkspaceShellSidebarResizeMouseEvent();
    documentListeners.get('mousemove')?.(moveEvent as unknown as Event);
    documentListeners.get('mouseup')?.({} as Event);

    expect(onMouseMove).toHaveBeenCalledWith(moveEvent);
    expect(onMouseUp).toHaveBeenCalledTimes(1);
  });

  it('lazy-loads the resize host once and forwards resize interactions to it', async () => {
    const { delegate, host, loadSidebarResizeHost } = createRuntime();
    const startEvent = createWorkspaceShellSidebarResizeMouseEvent();
    const moveEvent = createWorkspaceShellSidebarResizeMouseEvent();

    host.startSidebarResize(startEvent);
    await flushWorkspaceShellSidebarResizeMicrotasks();
    host.onMouseMove(moveEvent);
    host.onMouseUp();

    expect(loadSidebarResizeHost).toHaveBeenCalledTimes(1);
    expect(delegate.startSidebarResize).toHaveBeenCalledWith(startEvent);
    expect(delegate.onMouseMove).toHaveBeenCalledWith(moveEvent);
    expect(delegate.onMouseUp).toHaveBeenCalledTimes(1);
    expect(host.isResizingAny()).toBe(false);
  });

  it('warns with the runtime start failure message when the resize host load fails', async () => {
    const error = new Error('sidebar resize chunk missing');
    const { host, warn } = createRuntime({
      loadSidebarResizeHost: vi.fn().mockRejectedValue(error),
    });

    host.startSidebarResize(createWorkspaceShellSidebarResizeMouseEvent());
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(warn).toHaveBeenCalledWith('侧栏拖拽 deferred lazy-load host 加载失败，已跳过本次拖拽', error);
    expect(host.isResizingAny()).toBe(false);
  });

  it('guards every interaction behind the destroyed flag', () => {
    let destroyed = false;
    const { host, listenToDocument, loadSidebarResizeHost } = createRuntime({
      destroyed: () => destroyed,
    });

    destroyed = true;
    host.setup();
    host.startSidebarResize(createWorkspaceShellSidebarResizeMouseEvent());

    // 销毁后 setup/拖拽全部短路：不挂 listener 也不触发懒加载
    expect(listenToDocument).not.toHaveBeenCalled();
    expect(loadSidebarResizeHost).not.toHaveBeenCalled();
    expect(host.isResizingAny()).toBe(false);
  });

  it('removes document listeners and tears down the loaded delegate on teardown', async () => {
    const { delegate, host, removeListeners } = createRuntime();

    host.setup();
    host.startSidebarResize(createWorkspaceShellSidebarResizeMouseEvent());
    await flushWorkspaceShellSidebarResizeMicrotasks();

    host.teardown();

    expect(removeListeners.get('mousemove')).toHaveBeenCalledTimes(1);
    expect(removeListeners.get('mouseup')).toHaveBeenCalledTimes(1);
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
  });

  it('prefers an injected loadSidebarResizeHost over the dynamic import loader', async () => {
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    const loadSidebarResizeHost = vi.fn(
      (): Promise<WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate> =>
        Promise.resolve(delegate),
    );
    const { host } = createRuntime({ loadSidebarResizeHost });

    host.startContentResize(createWorkspaceShellSidebarResizeMouseEvent());
    await flushWorkspaceShellSidebarResizeMicrotasks();

    expect(loadSidebarResizeHost).toHaveBeenCalledTimes(1);
    expect(delegate.startContentResize).toHaveBeenCalledTimes(1);
  });
});
