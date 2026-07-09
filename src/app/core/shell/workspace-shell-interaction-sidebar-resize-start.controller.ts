import type {
  WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host.controller';
import type {
  WorkspaceShellInteractionSidebarResizeLazyHostController,
} from './workspace-shell-interaction-sidebar-resize-lazy-host.controller';
import type {
  WorkspaceShellSidebarResizeBootstrapListenersController,
} from './workspace-shell-sidebar-resize-bootstrap-listeners.controller';
import type {
  WorkspaceShellSidebarResizePendingGestureController,
  WorkspaceShellSidebarResizePendingGestureId,
} from './workspace-shell-sidebar-resize-pending-gesture.controller';

export type WorkspaceShellInteractionSidebarResizeStartMethod =
  'startSidebarResize' | 'startContentResize';

export interface WorkspaceShellInteractionSidebarResizeStartControllerOptions {
  bootstrapListeners: WorkspaceShellSidebarResizeBootstrapListenersController;
  host: WorkspaceShellInteractionSidebarResizeLazyHostController;
  pendingGesture: WorkspaceShellSidebarResizePendingGestureController;
}

export class WorkspaceShellInteractionSidebarResizeStartController {
  constructor(
    private readonly options: WorkspaceShellInteractionSidebarResizeStartControllerOptions,
  ) {}

  start(
    method: WorkspaceShellInteractionSidebarResizeStartMethod,
    event: MouseEvent,
  ): void {
    const gesture = this.pendingGesture.start();
    if (gesture === null) return;

    if (!this.host.loadedDelegate) {
      this.bootstrapListeners.setup();
    }
    if (!event.defaultPrevented) {
      event.preventDefault();
    }
    void this.host.call(
      resolvedDelegate => this.startLoadedResize(resolvedDelegate, method, event, gesture),
      false,
    )
      .then(started => {
        if (!started) {
          this.pendingGesture.finish(gesture, false);
        }
      });
  }

  private startLoadedResize(
    resolvedDelegate: WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate,
    method: WorkspaceShellInteractionSidebarResizeStartMethod,
    event: MouseEvent,
    gesture: WorkspaceShellSidebarResizePendingGestureId,
  ): boolean {
    if (!this.pendingGesture.isCurrent(gesture)) {
      return false;
    }

    this.bootstrapListeners.teardown();
    resolvedDelegate.setup();
    resolvedDelegate[method](event);
    this.pendingGesture.finish(gesture, resolvedDelegate.isResizingAny());
    return true;
  }

  private get bootstrapListeners(): WorkspaceShellSidebarResizeBootstrapListenersController {
    return this.options.bootstrapListeners;
  }

  private get host(): WorkspaceShellInteractionSidebarResizeLazyHostController {
    return this.options.host;
  }

  private get pendingGesture(): WorkspaceShellSidebarResizePendingGestureController {
    return this.options.pendingGesture;
  }
}
