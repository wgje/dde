import type {
  WorkspaceShellTouchGestureControllerOptions,
} from './workspace-shell-touch-gesture.controller';
import {
  WorkspaceShellTouchGestureLazyHostController,
} from './workspace-shell-touch-gesture-lazy-host.controller';

export interface WorkspaceShellTouchGestureControllerLike {
  onMainTouchEnd(event: TouchEvent): void;
  onMainTouchMove(event: TouchEvent): void;
  onMainTouchStart(event: TouchEvent): void;
  onSidebarTouchEnd(event: TouchEvent): void;
  onSidebarTouchMove(event: TouchEvent): void;
  onSidebarTouchStart(event: TouchEvent): void;
}

export interface WorkspaceShellTouchGestureLazyLoadControllerOptions
  extends WorkspaceShellTouchGestureControllerOptions {
  warn: (message: string, error: unknown) => void;
  createTouchGestureController?: () => Promise<WorkspaceShellTouchGestureControllerLike>;
}

export class WorkspaceShellTouchGestureLazyLoadController {
  private readonly host: WorkspaceShellTouchGestureLazyHostController;

  constructor(private readonly options: WorkspaceShellTouchGestureLazyLoadControllerOptions) {
    this.host = new WorkspaceShellTouchGestureLazyHostController(options);
  }

  onSidebarTouchStart(event: TouchEvent): void {
    this.run(controller => controller.onSidebarTouchStart(event));
  }

  onSidebarTouchMove(event: TouchEvent): void {
    this.run(controller => controller.onSidebarTouchMove(event));
  }

  onSidebarTouchEnd(event: TouchEvent): void {
    this.run(controller => controller.onSidebarTouchEnd(event));
  }

  onMainTouchStart(event: TouchEvent): void {
    this.run(controller => controller.onMainTouchStart(event));
  }

  onMainTouchMove(event: TouchEvent): void {
    this.run(controller => controller.onMainTouchMove(event));
  }

  onMainTouchEnd(event: TouchEvent): void {
    this.run(controller => controller.onMainTouchEnd(event));
  }

  private run(action: (controller: WorkspaceShellTouchGestureControllerLike) => void): void {
    if (!this.options.isMobile()) {
      return;
    }

    this.host.run(action);
  }

}
