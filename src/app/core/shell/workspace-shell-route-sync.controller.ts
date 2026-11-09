import {
  readWorkspaceShellRouteProjectId,
  type WorkspaceShellRouteNodeLike,
} from './workspace-shell-route-project-id';
import {
  WorkspaceShellRouteEventSubscriptionController,
  type WorkspaceShellRouteEventSubscription,
} from './workspace-shell-route-event-subscription.controller';

export type { WorkspaceShellRouteNodeLike };

export interface WorkspaceShellRouteNavigateOptions {
  replaceUrl?: boolean;
  queryParamsHandling?: 'preserve';
}

export interface WorkspaceShellRouteSyncControllerOptions {
  route: () => WorkspaceShellRouteNodeLike;
  projects: () => readonly { id: string }[];
  activeProjectId: () => string | null;
  canAuthoritativelyRejectProjectRoute: () => boolean;
  isProjectAuthoritativelyAccessible: (projectId: string) => boolean;
  switchActiveProject: (projectId: string) => void;
  resolveStartupProjectFallbackId: (projects: readonly { id: string }[]) => string | null;
  navigateRootStartupToTextProject: (projectId: string) => void;
  navigate: (commands: string[], options?: WorkspaceShellRouteNavigateOptions) => Promise<unknown> | unknown;
  warn: (message: string, error: unknown) => void;
  subscribeToRouteEvents?: (
    listener: (event: unknown) => void,
  ) => WorkspaceShellRouteEventSubscription;
  isNavigationEnd?: (event: unknown) => boolean;
}

export class WorkspaceShellRouteSyncController {
  private readonly routeEvents: WorkspaceShellRouteEventSubscriptionController;

  constructor(private readonly options: WorkspaceShellRouteSyncControllerOptions) {
    this.routeEvents = new WorkspaceShellRouteEventSubscriptionController({
      subscribeToRouteEvents: options.subscribeToRouteEvents,
      isNavigationEnd: options.isNavigationEnd,
      onNavigationEnd: () => this.syncStateFromRoute(),
      warn: options.warn,
    });
  }

  setupRouteSync(): void {
    this.routeEvents.setup();

    try {
      this.syncStateFromRoute();
    } catch (error) {
      this.warn('Workspace route sync initial sync failed', error);
    }
  }

  cleanup(): void {
    this.routeEvents.cleanup();
  }

  syncStateFromRoute(): void {
    const projectId = readWorkspaceShellRouteProjectId(this.options.route());
    const projects = this.options.projects();
    const canAuthoritativelyRejectProjectRoute = this.options.canAuthoritativelyRejectProjectRoute();

    if (!projectId) {
      const activeProjectId = this.options.activeProjectId();
      if (activeProjectId) {
        this.options.navigateRootStartupToTextProject(activeProjectId);
        return;
      }

      if (projects.length === 0) {
        return;
      }

      const fallbackProjectId = this.options.resolveStartupProjectFallbackId(projects);
      if (fallbackProjectId) {
        this.options.switchActiveProject(fallbackProjectId);
        this.options.navigateRootStartupToTextProject(fallbackProjectId);
      }
      return;
    }

    const projectExists = projects.some(project => project.id === projectId);
    const isAuthoritativelyAccessible = !canAuthoritativelyRejectProjectRoute
      || this.options.isProjectAuthoritativelyAccessible(projectId);
    if (projectExists && isAuthoritativelyAccessible) {
      this.options.switchActiveProject(projectId);
      return;
    }

    if (!canAuthoritativelyRejectProjectRoute || isAuthoritativelyAccessible) {
      return;
    }

    this.navigate(['/projects']);
  }

  updateUrlForProject(projectId: string): void {
    this.navigate(['/projects', projectId], {
      replaceUrl: true,
      queryParamsHandling: 'preserve',
    });
  }

  private navigate(commands: string[], options?: WorkspaceShellRouteNavigateOptions): void {
    try {
      const navigation = options === undefined
        ? this.options.navigate(commands)
        : this.options.navigate(commands, options);
      void Promise.resolve(navigation)
        .then((result: unknown) => {
          if (result === false || result === null) {
            this.warn('Workspace route sync navigation was not confirmed', {
              commands,
              options,
              result,
            });
          }
        })
        .catch((error: unknown) => {
          this.warn('Workspace route sync navigation failed', error);
        });
    } catch (error) {
      this.warn('Workspace route sync navigation failed', error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning failures must not interrupt route sync state transitions.
    }
  }
}
