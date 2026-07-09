import type { Project } from '../../../models';
import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';
import {
  resolveStartupProjectFallbackId,
  shouldNavigateRootStartupToTextProject,
} from './workspace-shell-startup-route.helpers';

export interface WorkspaceShellMobileRootStartupNavigationControllerOptions {
  isMobile: () => boolean;
  activeProjectId: () => string | null;
  projects: () => readonly Pick<Project, 'id'>[];
  startupLaunchSnapshot: () => {
    activeProjectId: string | null;
    currentProject?: Pick<Project, 'id'> | null;
  } | null;
  routeUrl: () => string;
  startupEntryIntent: () => Pick<StartupEntryIntent, 'intent'> | null;
  navigateToTextProject: (projectId: string) => Promise<unknown> | unknown;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellMobileRootStartupNavigationController {
  private rootStartupTextNavigationApplied = false;
  private rootStartupTextNavigationInFlight = false;

  constructor(private readonly options: WorkspaceShellMobileRootStartupNavigationControllerOptions) {}

  resolveStartupProjectFallbackId(projects = this.options.projects()): string | null {
    return resolveStartupProjectFallbackId({
      projects,
      startupLaunchSnapshot: this.options.startupLaunchSnapshot(),
    });
  }

  resolveMobileRootStartupProjectId(): string | null {
    if (!this.options.isMobile()) {
      return null;
    }

    const activeProjectId = this.options.activeProjectId();
    if (activeProjectId) {
      return activeProjectId;
    }

    return this.resolveStartupProjectFallbackId();
  }

  shouldNavigateRootStartupToTextProject(): boolean {
    return shouldNavigateRootStartupToTextProject({
      routeUrl: this.options.routeUrl(),
      isMobile: this.options.isMobile(),
      rootStartupTextNavigationApplied: this.rootStartupTextNavigationApplied,
      startupEntryIntent: this.options.startupEntryIntent(),
    });
  }

  navigateRootStartupToTextProject(projectId: string): void {
    if (!this.shouldNavigateRootStartupToTextProject()) {
      return;
    }

    if (this.rootStartupTextNavigationInFlight) {
      return;
    }

    this.rootStartupTextNavigationInFlight = true;
    try {
      void Promise.resolve(this.options.navigateToTextProject(projectId)).then(() => {
        this.rootStartupTextNavigationApplied = true;
      }).catch((error: unknown) => {
        this.warn('Mobile root startup navigation failed', error);
      }).finally(() => {
        this.rootStartupTextNavigationInFlight = false;
      });
    } catch (error) {
      this.rootStartupTextNavigationInFlight = false;
      this.warn('Mobile root startup navigation failed', error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not block root startup navigation retries.
    }
  }
}
