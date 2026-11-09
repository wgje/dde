import {
  WorkspaceShellSidebarResizeAsyncDelegateHostController,
} from './workspace-shell-sidebar-resize-async-delegate-host.controller';
import {
  WorkspaceShellSidebarResizePendingGestureController,
} from './workspace-shell-sidebar-resize-pending-gesture.controller';
import {
  WorkspaceShellSidebarResizePendingMouseMoveController,
} from './workspace-shell-sidebar-resize-pending-mouse-move.controller';

export interface WorkspaceShellSidebarResizeAsyncInteractionControllerOptions {
  delegateHost: WorkspaceShellSidebarResizeAsyncDelegateHostController;
  pendingGesture: WorkspaceShellSidebarResizePendingGestureController;
  pendingMouseMove: WorkspaceShellSidebarResizePendingMouseMoveController;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellSidebarResizeAsyncInteractionController {
  constructor(
    private readonly options: WorkspaceShellSidebarResizeAsyncInteractionControllerOptions,
  ) {}

  isResizingAny(): boolean {
    if (!this.options.pendingGesture.isResizingAny(false)) return false;

    const delegate = this.options.delegateHost.loadedDelegate;
    if (!delegate) return true;

    try {
      return delegate.isResizingAny();
    } catch (error) {
      this.failActiveGesture('sidebar resize state check failed', error);
      return false;
    }
  }

  onMouseMove(event: MouseEvent): void {
    const delegate = this.options.delegateHost.loadedDelegate;
    if (!delegate && this.options.pendingGesture.isResizingAny(false)) {
      this.options.pendingMouseMove.queue(event);
      return;
    }

    try {
      delegate?.onMouseMove(event);
    } catch (error) {
      this.failActiveGesture('sidebar mousemove failed', error);
    }
  }

  onMouseUp(): void {
    this.options.pendingGesture.cancel();
    this.options.pendingMouseMove.clear();
    try {
      this.options.delegateHost.loadedDelegate?.onMouseUp();
    } catch (error) {
      this.warn('sidebar mouseup failed', error);
    }
  }

  teardown(): void {
    this.options.pendingGesture.cancel();
    this.options.pendingMouseMove.clear();
    this.options.delegateHost.teardown();
  }

  failActiveGesture(message: string, error: unknown): void {
    this.options.pendingGesture.cancel();
    this.options.pendingMouseMove.clear();
    this.warn(message, error);
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not re-open sidebar resize event failure paths.
    }
  }
}
