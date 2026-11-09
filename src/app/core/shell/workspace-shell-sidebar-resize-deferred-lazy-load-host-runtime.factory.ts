import { WorkspaceShellSidebarResizeAsyncDelegateController } from './workspace-shell-sidebar-resize-async-delegate.controller';
import {
  WorkspaceShellSidebarResizeBootstrapListenersController,
} from './workspace-shell-sidebar-resize-bootstrap-listeners.controller';
import {
  WorkspaceShellSidebarResizeDelegateHostController,
} from './workspace-shell-sidebar-resize-delegate-host.controller';
import {
  createWorkspaceShellSidebarResizeDeferredLazyLoadHostLoader,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host-loader.factory';
import type {
  WorkspaceShellSidebarResizeDeferredLazyLoadHostOptions,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host.controller';

export interface WorkspaceShellSidebarResizeDeferredLazyLoadHostRuntimeOptions
  extends WorkspaceShellSidebarResizeDeferredLazyLoadHostOptions {
  onMouseMove: (event: MouseEvent) => void;
  onMouseUp: () => void;
}

export function createWorkspaceShellSidebarResizeDeferredLazyLoadHostRuntime(
  options: WorkspaceShellSidebarResizeDeferredLazyLoadHostRuntimeOptions,
): WorkspaceShellSidebarResizeDelegateHostController {
  const loadSidebarResizeHost = createWorkspaceShellSidebarResizeDeferredLazyLoadHostLoader({
    destroyed: options.destroyed,
    injector: options.injector,
    loadSidebarResize: options.loadSidebarResize,
    loadSidebarResizeHost: options.loadSidebarResizeHost,
    warn: options.warn,
  });
  const delegate = new WorkspaceShellSidebarResizeAsyncDelegateController({
    loadDelegate: loadSidebarResizeHost,
    resolveFailureMessage: () => '侧栏拖拽 deferred lazy-load host 加载失败，已跳过本次拖拽',
    resolveStartFailureMessage: () => '侧栏拖拽 deferred lazy-load host 启动失败，已跳过本次拖拽',
    teardownFailureMessage: '侧栏拖拽 deferred lazy-load host 清理失败，已跳过',
    warn: options.warn,
  });
  const documentListeners = new WorkspaceShellSidebarResizeBootstrapListenersController({
    cleanupFailureMessage: '侧栏拖拽 document listener 清理失败，已继续清理',
    listenToDocument: options.listenToDocument,
    onMouseMove: options.onMouseMove,
    onMouseUp: options.onMouseUp,
    warn: options.warn,
  });

  return new WorkspaceShellSidebarResizeDelegateHostController({
    delegate,
    destroyed: () => options.destroyed?.() ?? false,
    setup: () => documentListeners.setup(),
    teardown: () => documentListeners.teardown(),
  });
}
