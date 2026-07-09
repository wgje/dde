import type { Injector, Signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import type { WorkspaceShellRouteSyncController } from './workspace-shell-route-sync.controller';
import {
  createWorkspaceShellRouteSyncDelegate,
  type WorkspaceShellRouteStartupEntryControllers,
} from './workspace-shell-route-sync.factory';
import { createWorkspaceShellRouteUrlSignal } from './workspace-shell-route-url-signal.factory';

export interface WorkspaceShellRoutingSurfaceOptions {
  injector: Injector;
  projectState: {
    projects(): readonly { id: string }[];
    activeProjectId(): string | null;
  };
  userSession: {
    canAuthoritativelyRejectProjectRoute(): boolean;
    isProjectAuthoritativelyAccessible(projectId: string): boolean;
    switchActiveProject(projectId: string): void;
  };
  startupEntryControllers: () => WorkspaceShellRouteStartupEntryControllers;
  warn: (message: string, error: unknown) => void;
}

export interface WorkspaceShellRoutingSurface {
  readonly router: Router;
  readonly routeUrl: Signal<string>;
  readonly routeSyncController: WorkspaceShellRouteSyncController;
}

export function createWorkspaceShellRoutingSurface(
  options: WorkspaceShellRoutingSurfaceOptions,
): WorkspaceShellRoutingSurface {
  const route = options.injector.get(ActivatedRoute);
  const router = options.injector.get(Router);

  return {
    router,
    routeUrl: createWorkspaceShellRouteUrlSignal({
      injector: options.injector,
      router,
    }),
    routeSyncController: createWorkspaceShellRouteSyncDelegate({
      route: () => route,
      router: () => router,
      projectState: options.projectState,
      userSession: options.userSession,
      startupEntryControllers: options.startupEntryControllers,
      warn: options.warn,
    }),
  };
}
