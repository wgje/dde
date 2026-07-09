import type { Injector } from '@angular/core';

import {
  createWorkspaceShellSidebarResizeDeferredLazyLoadHostRuntime,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host-runtime.factory';
import type {
  WorkspaceShellSidebarResizeServiceLike,
} from './workspace-shell-sidebar-resize-lazy-load.controller';

export interface WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate {
  isResizingAny(): boolean;
  onMouseMove(event: MouseEvent): void;
  onMouseUp(): void;
  setup(): void;
  startContentResize(event: MouseEvent): void;
  startSidebarResize(event: MouseEvent): void;
  teardown(): void;
}

export interface WorkspaceShellSidebarResizeDeferredLazyLoadHostOptions {
  injector?: Injector;
  destroyed?: () => boolean;
  listenToDocument?: (eventName: string, listener: EventListener) => () => void;
  loadSidebarResize?: () => Promise<WorkspaceShellSidebarResizeServiceLike>;
  loadSidebarResizeHost?: () => Promise<WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellSidebarResizeDeferredLazyLoadHostController {
  private readonly host: WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate;

  constructor(options: WorkspaceShellSidebarResizeDeferredLazyLoadHostOptions) {
    this.host = createWorkspaceShellSidebarResizeDeferredLazyLoadHostRuntime({
      ...options,
      onMouseMove: event => this.onMouseMove(event),
      onMouseUp: () => this.onMouseUp(),
    });
  }

  setup(): void {
    this.host.setup();
  }

  isResizingAny(): boolean {
    return this.host.isResizingAny();
  }

  startSidebarResize(event: MouseEvent): void {
    this.host.startSidebarResize(event);
  }

  startContentResize(event: MouseEvent): void {
    this.host.startContentResize(event);
  }

  onMouseMove(event: MouseEvent): void {
    this.host.onMouseMove(event);
  }

  onMouseUp(): void {
    this.host.onMouseUp();
  }

  teardown(): void {
    this.host.teardown();
  }
}
