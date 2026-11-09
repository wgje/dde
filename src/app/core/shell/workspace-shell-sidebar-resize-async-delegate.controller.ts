import {
  WorkspaceShellSidebarResizeAsyncDelegateHostController,
} from './workspace-shell-sidebar-resize-async-delegate-host.controller';
import {
  WorkspaceShellSidebarResizeAsyncInteractionController,
} from './workspace-shell-sidebar-resize-async-interaction.controller';
import {
  WorkspaceShellSidebarResizePendingGestureController,
} from './workspace-shell-sidebar-resize-pending-gesture.controller';
import {
  WorkspaceShellSidebarResizePendingMouseMoveController,
} from './workspace-shell-sidebar-resize-pending-mouse-move.controller';
import {
  WorkspaceShellSidebarResizeAsyncStartController,
} from './workspace-shell-sidebar-resize-async-start.controller';

export interface WorkspaceShellSidebarResizeAsyncDelegate {
  isResizingAny(): boolean;
  onMouseMove(event: MouseEvent): void;
  onMouseUp(): void;
  startContentResize(event: MouseEvent): void;
  startSidebarResize(event: MouseEvent): void;
  teardown(): void;
}

export interface WorkspaceShellSidebarResizeAsyncDelegateOptions {
  loadDelegate: () => Promise<WorkspaceShellSidebarResizeAsyncDelegate>;
  resolveFailureMessage: (target: 'sidebar' | 'content') => string;
  resolveStartFailureMessage?: (target: 'sidebar' | 'content') => string;
  teardownFailureMessage: string;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellSidebarResizeAsyncDelegateController {
  private readonly delegateHost: WorkspaceShellSidebarResizeAsyncDelegateHostController;
  private readonly pendingGesture = new WorkspaceShellSidebarResizePendingGestureController();
  private readonly pendingMouseMove =
    new WorkspaceShellSidebarResizePendingMouseMoveController();
  private readonly interactionController: WorkspaceShellSidebarResizeAsyncInteractionController;
  private readonly startController: WorkspaceShellSidebarResizeAsyncStartController;

  constructor(options: WorkspaceShellSidebarResizeAsyncDelegateOptions) {
    this.delegateHost = new WorkspaceShellSidebarResizeAsyncDelegateHostController({
      loadDelegate: options.loadDelegate,
      loadFailureMessage: options.resolveFailureMessage('sidebar'),
      teardownFailureMessage: options.teardownFailureMessage,
      warn: options.warn,
    });
    this.interactionController =
      new WorkspaceShellSidebarResizeAsyncInteractionController({
        delegateHost: this.delegateHost,
        pendingGesture: this.pendingGesture,
        pendingMouseMove: this.pendingMouseMove,
        warn: options.warn,
      });
    this.startController = new WorkspaceShellSidebarResizeAsyncStartController({
      delegateHost: this.delegateHost,
      pendingGesture: this.pendingGesture,
      pendingMouseMove: this.pendingMouseMove,
      resolveFailureMessage: options.resolveFailureMessage,
      resolveStartFailureMessage: options.resolveStartFailureMessage,
      failActiveGesture: (message, error) => {
        this.interactionController.failActiveGesture(message, error);
      },
    });
  }

  isResizingAny(): boolean {
    return this.interactionController.isResizingAny();
  }

  startSidebarResize(event: MouseEvent): void {
    this.startController.start(event, 'sidebar');
  }

  startContentResize(event: MouseEvent): void {
    this.startController.start(event, 'content');
  }

  onMouseMove(event: MouseEvent): void {
    this.interactionController.onMouseMove(event);
  }

  onMouseUp(): void {
    this.interactionController.onMouseUp();
  }

  teardown(): void {
    this.interactionController.teardown();
  }
}
