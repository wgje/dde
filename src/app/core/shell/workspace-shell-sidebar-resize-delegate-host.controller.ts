import type {
  WorkspaceShellSidebarResizeAsyncDelegate,
} from './workspace-shell-sidebar-resize-async-delegate.controller';

export type WorkspaceShellSidebarResizeDelegateHostDelegate =
  WorkspaceShellSidebarResizeAsyncDelegate;

export interface WorkspaceShellSidebarResizeDelegateHostOptions {
  delegate: WorkspaceShellSidebarResizeDelegateHostDelegate;
  destroyed: () => boolean;
  setup?: () => void;
  teardown?: () => void;
}

export class WorkspaceShellSidebarResizeDelegateHostController {
  constructor(private readonly options: WorkspaceShellSidebarResizeDelegateHostOptions) {}

  setup(): void {
    if (this.isDestroyed()) return;

    this.options.setup?.();
  }

  isResizingAny(): boolean {
    if (this.isDestroyed()) return false;

    return this.options.delegate.isResizingAny();
  }

  startSidebarResize(event: MouseEvent): void {
    if (this.isDestroyed()) return;

    this.options.delegate.startSidebarResize(event);
  }

  startContentResize(event: MouseEvent): void {
    if (this.isDestroyed()) return;

    this.options.delegate.startContentResize(event);
  }

  onMouseMove(event: MouseEvent): void {
    if (this.isDestroyed()) return;

    this.options.delegate.onMouseMove(event);
  }

  onMouseUp(): void {
    if (this.isDestroyed()) return;

    this.options.delegate.onMouseUp();
  }

  teardown(): void {
    this.options.teardown?.();
    this.options.delegate.teardown();
  }

  private isDestroyed(): boolean {
    return this.options.destroyed();
  }
}
