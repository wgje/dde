import { NavigationEnd } from '@angular/router';

import {
  WorkspaceShellRouteSyncController,
  type WorkspaceShellRouteNodeLike,
} from './workspace-shell-route-sync.controller';
import type {
  WorkspaceShellRouteSyncFactoryOptions,
} from './workspace-shell-route-sync.factory';

export function createWorkspaceShellRouteSyncController(
  options: WorkspaceShellRouteSyncFactoryOptions,
): WorkspaceShellRouteSyncController {
  return new WorkspaceShellRouteSyncController({
    route: () => options.route() as WorkspaceShellRouteNodeLike,
    projects: options.projects,
    activeProjectId: options.activeProjectId,
    canAuthoritativelyRejectProjectRoute:
      () => options.userSession.canAuthoritativelyRejectProjectRoute(),
    isProjectAuthoritativelyAccessible: projectId =>
      options.userSession.isProjectAuthoritativelyAccessible(projectId),
    switchActiveProject: projectId => options.userSession.switchActiveProject(projectId),
    resolveStartupProjectFallbackId: options.resolveStartupProjectFallbackId,
    navigateRootStartupToTextProject: options.navigateRootStartupToTextProject,
    navigate: (commands, routeOptions) =>
      options.router().navigate(commands, routeOptions),
    warn: options.warn,
    subscribeToRouteEvents: (listener) =>
      options.router().events.subscribe(listener),
    isNavigationEnd: (event) => event instanceof NavigationEnd,
  });
}
