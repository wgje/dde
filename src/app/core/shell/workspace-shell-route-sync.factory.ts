import type { ActivatedRoute, Router } from '@angular/router';

import type {
  WorkspaceShellRouteSyncController,
} from './workspace-shell-route-sync.controller';
import {
  WorkspaceShellRouteSyncLazyDelegateController,
} from './workspace-shell-route-sync-lazy-delegate.controller';

export interface WorkspaceShellRouteSyncFactoryOptions {
  route: () => ActivatedRoute;
  router: () => Router;
  projects: () => readonly { id: string }[];
  activeProjectId: () => string | null;
  userSession: {
    canAuthoritativelyRejectProjectRoute(): boolean;
    isProjectAuthoritativelyAccessible(projectId: string): boolean;
    switchActiveProject(projectId: string): void;
  };
  resolveStartupProjectFallbackId: (projects: readonly { id: string }[]) => string | null;
  navigateRootStartupToTextProject: (projectId: string) => void;
  warn: (message: string, error: unknown) => void;
}

export interface WorkspaceShellRouteStartupEntryControllers {
  readonly mobileRootStartupNavigation: {
    resolveStartupProjectFallbackId(projects: readonly { id: string }[]): string | null;
    navigateRootStartupToTextProject(projectId: string): void;
  };
}

export interface WorkspaceShellRouteSyncOptionsFactoryOptions {
  route: WorkspaceShellRouteSyncFactoryOptions['route'];
  router: WorkspaceShellRouteSyncFactoryOptions['router'];
  projectState: {
    projects: WorkspaceShellRouteSyncFactoryOptions['projects'];
    activeProjectId: WorkspaceShellRouteSyncFactoryOptions['activeProjectId'];
  };
  userSession: WorkspaceShellRouteSyncFactoryOptions['userSession'];
  startupEntryControllers: () => WorkspaceShellRouteStartupEntryControllers;
  warn: WorkspaceShellRouteSyncFactoryOptions['warn'];
}

export function createWorkspaceShellRouteSyncOptions(
  options: WorkspaceShellRouteSyncOptionsFactoryOptions,
): WorkspaceShellRouteSyncFactoryOptions {
  return {
    route: options.route,
    router: options.router,
    projects: () => options.projectState.projects(),
    activeProjectId: () => options.projectState.activeProjectId(),
    userSession: options.userSession,
    resolveStartupProjectFallbackId: projects =>
      options.startupEntryControllers().mobileRootStartupNavigation
        .resolveStartupProjectFallbackId(projects),
    navigateRootStartupToTextProject: projectId =>
      options.startupEntryControllers().mobileRootStartupNavigation
        .navigateRootStartupToTextProject(projectId),
    warn: options.warn,
  };
}

export function createWorkspaceShellRouteSyncDelegate(
  options: WorkspaceShellRouteSyncOptionsFactoryOptions,
): WorkspaceShellRouteSyncController {
  return new WorkspaceShellRouteSyncLazyDelegateController(
    createWorkspaceShellRouteSyncOptions(options),
  ) as unknown as WorkspaceShellRouteSyncController;
}
