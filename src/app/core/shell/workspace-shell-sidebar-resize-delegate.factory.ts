import type {
  WorkspaceShellSidebarResizeAsyncDelegate,
} from './workspace-shell-sidebar-resize-async-delegate.controller';

export interface WorkspaceShellSidebarResizeServiceLike {
  isResizingAny(): boolean;
  onMouseMove(event: MouseEvent): void;
  onMouseUp(): void;
  startContent(event: MouseEvent): void;
  startSidebar(event: MouseEvent): void;
  teardown(): void;
}

export interface WorkspaceShellSidebarResizeDelegateOptions {
  destroyed: () => boolean;
  service: WorkspaceShellSidebarResizeServiceLike;
}

export function createWorkspaceShellSidebarResizeDelegate(
  options: WorkspaceShellSidebarResizeDelegateOptions,
): WorkspaceShellSidebarResizeAsyncDelegate {
  if (options.destroyed()) {
    options.service.teardown();
    return createWorkspaceShellSidebarResizeNoopDelegate();
  }

  return {
    isResizingAny: () => options.service.isResizingAny(),
    onMouseMove: event => options.service.onMouseMove(event),
    onMouseUp: () => options.service.onMouseUp(),
    startContentResize: event => options.service.startContent(event),
    startSidebarResize: event => options.service.startSidebar(event),
    teardown: () => options.service.teardown(),
  };
}

export function createWorkspaceShellSidebarResizeNoopDelegate(): WorkspaceShellSidebarResizeAsyncDelegate {
  return {
    isResizingAny: () => false,
    onMouseMove: () => undefined,
    onMouseUp: () => undefined,
    startContentResize: () => undefined,
    startSidebarResize: () => undefined,
    teardown: () => undefined,
  };
}
