import type {
  WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host.controller';
import {
  WorkspaceShellInteractionSidebarResizeLazyHostController,
} from './workspace-shell-interaction-sidebar-resize-lazy-host.controller';
import {
  WorkspaceShellSidebarResizeBootstrapListenersController,
} from './workspace-shell-sidebar-resize-bootstrap-listeners.controller';
import {
  WorkspaceShellSidebarResizePendingGestureController,
} from './workspace-shell-sidebar-resize-pending-gesture.controller';
import {
  WorkspaceShellInteractionSidebarResizeStartController,
} from './workspace-shell-interaction-sidebar-resize-start.controller';

type WorkspaceShellInteractionSidebarResizeDelegate =
  WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate;

export interface WorkspaceShellInteractionSidebarResizeLazyDelegateControllerOptions {
  listenToDocument?: (eventName: string, listener: EventListener) => () => void;
  loadSidebarResizeHost: () => Promise<WorkspaceShellInteractionSidebarResizeDelegate>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellInteractionSidebarResizeLazyDelegateController
implements WorkspaceShellInteractionSidebarResizeDelegate {
  private readonly host: WorkspaceShellInteractionSidebarResizeLazyHostController;
  private readonly bootstrapListeners: WorkspaceShellSidebarResizeBootstrapListenersController;
  private readonly pendingGesture = new WorkspaceShellSidebarResizePendingGestureController();
  private readonly startController: WorkspaceShellInteractionSidebarResizeStartController;

  constructor(options: WorkspaceShellInteractionSidebarResizeLazyDelegateControllerOptions) {
    this.host = new WorkspaceShellInteractionSidebarResizeLazyHostController({
      loadSidebarResizeHost: options.loadSidebarResizeHost,
      warn: options.warn,
    });
    this.bootstrapListeners = new WorkspaceShellSidebarResizeBootstrapListenersController({
      listenToDocument: options.listenToDocument,
      onMouseMove: event => this.onMouseMove(event),
      onMouseUp: () => this.onMouseUp(),
      warn: options.warn,
    });
    this.startController = new WorkspaceShellInteractionSidebarResizeStartController({
      bootstrapListeners: this.bootstrapListeners,
      host: this.host,
      pendingGesture: this.pendingGesture,
    });
  }

  setup(): void {
    if (this.pendingGesture.isTornDown()) return;

    if (!this.host.loadedDelegate) {
      this.bootstrapListeners.setup();
    }

    this.host.runIfLoaded(
      resolvedDelegate => {
        this.bootstrapListeners.teardown();
        resolvedDelegate.setup();
      },
    );
  }

  isResizingAny(): boolean {
    if (!this.pendingGesture.isResizingAny(false)) return false;

    const loadedDelegate = this.host.loadedDelegate;
    if (!loadedDelegate) return true;

    try {
      return this.pendingGesture.isResizingAny(loadedDelegate.isResizingAny());
    } catch (error) {
      this.failLoadedResize(error);
      return false;
    }
  }

  startSidebarResize(event: MouseEvent): void {
    this.startController.start('startSidebarResize', event);
  }

  startContentResize(event: MouseEvent): void {
    this.startController.start('startContentResize', event);
  }

  onMouseMove(event: MouseEvent): void {
    if (this.pendingGesture.isTornDown()) return;
    if (!this.pendingGesture.isResizingAny(false)) return;
    if (!this.host.loadedDelegate) return;

    this.host.runIfLoaded(delegate => {
      try {
        delegate.onMouseMove(event);
      } catch (error) {
        this.pendingGesture.cancel();
        throw error;
      }
    });
  }

  onMouseUp(): void {
    if (this.pendingGesture.isTornDown()) return;

    this.pendingGesture.cancel();
    if (!this.host.loadedDelegate) return;

    this.host.runIfLoaded(delegate => delegate.onMouseUp());
  }

  teardown(): void {
    if (this.pendingGesture.isTornDown()) return;

    this.pendingGesture.teardown();
    this.bootstrapListeners.teardown();
    this.host.teardown();
  }

  private failLoadedResize(error: unknown): void {
    this.pendingGesture.cancel();
    this.host.runIfLoaded(() => {
      throw error;
    });
  }

}
