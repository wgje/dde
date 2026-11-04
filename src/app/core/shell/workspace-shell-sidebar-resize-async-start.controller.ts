import type {
  WorkspaceShellSidebarResizeAsyncDelegate,
} from './workspace-shell-sidebar-resize-async-delegate.controller';
import {
  WorkspaceShellSidebarResizeAsyncDelegateHostController,
} from './workspace-shell-sidebar-resize-async-delegate-host.controller';
import {
  WorkspaceShellSidebarResizePendingGestureController,
  type WorkspaceShellSidebarResizePendingGestureId,
} from './workspace-shell-sidebar-resize-pending-gesture.controller';
import {
  WorkspaceShellSidebarResizePendingMouseMoveController,
} from './workspace-shell-sidebar-resize-pending-mouse-move.controller';

export type WorkspaceShellSidebarResizeTarget = 'sidebar' | 'content';

export interface WorkspaceShellSidebarResizeAsyncStartControllerOptions {
  delegateHost: WorkspaceShellSidebarResizeAsyncDelegateHostController;
  pendingGesture: WorkspaceShellSidebarResizePendingGestureController;
  pendingMouseMove: WorkspaceShellSidebarResizePendingMouseMoveController;
  resolveFailureMessage: (target: WorkspaceShellSidebarResizeTarget) => string;
  resolveStartFailureMessage?: (
    target: WorkspaceShellSidebarResizeTarget
  ) => string;
  failActiveGesture: (message: string, error: unknown) => void;
}

export class WorkspaceShellSidebarResizeAsyncStartController {
  constructor(
    private readonly options: WorkspaceShellSidebarResizeAsyncStartControllerOptions,
  ) {}

  start(event: MouseEvent, target: WorkspaceShellSidebarResizeTarget): void {
    if (!event.defaultPrevented) {
      event.preventDefault();
    }
    const gesture = this.options.pendingGesture.start();
    if (gesture === null) return;
    this.options.pendingMouseMove.clear();

    let startFailureMessage: string;
    let loadFailureMessage: string;
    try {
      startFailureMessage = this.resolveStartFailureMessage(target);
      loadFailureMessage = this.options.resolveFailureMessage(target);
    } catch (error) {
      this.options.failActiveGesture(
        `${target} resize start failure message resolution failed`,
        error,
      );
      return;
    }

    void this.options.delegateHost.call(
      delegate => this.startLoadedDelegate(delegate, event, target, gesture),
      false,
      startFailureMessage,
      loadFailureMessage,
    )
      .then(started => {
        if (started || !this.options.pendingGesture.finish(gesture, false)) return;
        this.options.pendingMouseMove.clear();
      });
  }

  private resolveStartFailureMessage(
    target: WorkspaceShellSidebarResizeTarget,
  ): string {
    return this.options.resolveStartFailureMessage?.(target)
      ?? this.options.resolveFailureMessage(target);
  }

  private startLoadedDelegate(
    delegate: WorkspaceShellSidebarResizeAsyncDelegate,
    event: MouseEvent,
    target: WorkspaceShellSidebarResizeTarget,
    gesture: WorkspaceShellSidebarResizePendingGestureId,
  ): boolean {
    if (!this.options.pendingGesture.isCurrent(gesture)) {
      return false;
    }

    if (target === 'sidebar') {
      delegate.startSidebarResize(event);
    } else {
      delegate.startContentResize(event);
    }

    this.flushPendingEvents(delegate, gesture);
    return true;
  }

  private flushPendingEvents(
    delegate: WorkspaceShellSidebarResizeAsyncDelegate,
    gesture: WorkspaceShellSidebarResizePendingGestureId,
  ): void {
    this.options.pendingMouseMove.flush(event => delegate.onMouseMove(event));
    this.options.pendingGesture.finish(gesture, delegate.isResizingAny());
  }
}
