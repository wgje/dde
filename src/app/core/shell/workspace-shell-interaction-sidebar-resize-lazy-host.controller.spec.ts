import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellInteractionSidebarResizeLazyHostController,
  type WorkspaceShellInteractionSidebarResizeLazyHostDelegate,
} from './workspace-shell-interaction-sidebar-resize-lazy-host.controller';
import {
  createWorkspaceShellSidebarResizeDeferred,
  createWorkspaceShellSidebarResizeDelegate,
  flushWorkspaceShellSidebarResizeMicrotasks,
} from './workspace-shell-sidebar-resize.spec-helpers';

function createHost(overrides: {
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

  return { delegate, host, loadSidebarResizeHost, warn };
}

describe('WorkspaceShellInteractionSidebarResizeLazyHostController', () => {
  it('loads the sidebar resize host once and resolves call results', async () => {
    const { delegate, host, loadSidebarResizeHost } = createHost();

    expect(host.loadedDelegate).toBeNull();

    const firstResult = await host.call(resolved => {
      resolved.setup();
      return 'first';
    }, 'fallback');
    const secondResult = await host.call(() => 'second', 'fallback');

    expect(firstResult).toBe('first');
    expect(secondResult).toBe('second');
    expect(loadSidebarResizeHost).toHaveBeenCalledTimes(1);
    expect(delegate.setup).toHaveBeenCalledTimes(1);
    expect(host.loadedDelegate).toBe(delegate);
  });

  it('returns the fallback and warns with the load failure message when loading fails', async () => {
    const error = new Error('sidebar resize chunk missing');
    const { host, warn } = createHost({
      loadSidebarResizeHost: vi.fn().mockRejectedValue(error),
    });

    const result = await host.call(() => true, false);

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith('侧栏拖拽加载失败，已跳过', error);
  });

  it('only runs runIfLoaded actions once a delegate instance exists', async () => {
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    const deferred = createWorkspaceShellSidebarResizeDeferred<
      WorkspaceShellInteractionSidebarResizeLazyHostDelegate
    >();
    const { host } = createHost({
      loadSidebarResizeHost: vi.fn(() => deferred.promise),
    });
    const action = vi.fn();

    // 尚未触发加载：runIfLoaded 不得触发懒加载副作用
    host.runIfLoaded(action);
    await flushWorkspaceShellSidebarResizeMicrotasks();
    expect(action).not.toHaveBeenCalled();

    void host.call(() => undefined, undefined);
    host.runIfLoaded(action);
    deferred.resolve(delegate);
    await flushWorkspaceShellSidebarResizeMicrotasks();

    // 在途加载完成后，排队的 loaded-only 动作补跑一次
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('skips pending actions after teardown and warns when delegate teardown fails', async () => {
    const teardownError = new Error('sidebar resize teardown failed');
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    delegate.teardown.mockImplementation(() => {
      throw teardownError;
    });
    const { host, warn } = createHost({
      loadSidebarResizeHost: vi.fn().mockResolvedValue(delegate),
    });

    await host.call(() => undefined, undefined);
    host.teardown();

    expect(delegate.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('侧栏拖拽 lazy-load host 清理失败，已跳过', teardownError);
    expect(host.loadedDelegate).toBeNull();

    const result = await host.call(() => 'ran', 'fallback');

    // teardown 后调用统一走 fallback，不再触达 delegate
    expect(result).toBe('fallback');
  });

  it('tears down a delegate that resolves after teardown without running queued actions', async () => {
    const delegate = createWorkspaceShellSidebarResizeDelegate();
    const deferred = createWorkspaceShellSidebarResizeDeferred<
      WorkspaceShellInteractionSidebarResizeLazyHostDelegate
    >();
    const { host } = createHost({
      loadSidebarResizeHost: vi.fn(() => deferred.promise),
    });
    const pending = host.call(resolved => {
      resolved.startSidebarResize({} as MouseEvent);
      return true;
    }, false);

    host.teardown();
    deferred.resolve(delegate);

    await expect(pending).resolves.toBe(false);
    // 竞态守卫：teardown 后延迟到达的 delegate 只清理、不启动拖拽
    expect(delegate.startSidebarResize).not.toHaveBeenCalled();
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
  });
});
